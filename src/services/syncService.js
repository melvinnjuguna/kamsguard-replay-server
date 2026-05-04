import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import { downloadFile } from "./videoConverter.js";
import { uploadStream } from "./storageService.js";
import { runWithConcurrency } from "../utils/concurrency.js";

// ── in-memory state
const lastSyncTime = new Map();
const offlineDevices = new Map();

const SYNC_LOOKBACK = 15 * 60;
const OFFLINE_RETRY_LIMIT = 3;
const DEVICE_CONCURRENCY = 10; 

// ── helpers 

async function fetchVparts(deviceIp, cam, fromTime) {
  const now = Math.floor(Date.now() / 1000);
  const range = now - fromTime;
  const url = `http://${deviceIp}/vparts.cgi?format=csv&listlength=500&pathstyle=long&time=${fromTime}&range=${range}&domain=0&cam=${cam}`;

  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 10000 }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const vparts = Buffer.concat(chunks)
          .toString()
          .split("\n")
          .filter((l) => l.trim())
          .map((line) => {
            const cols = line.split(",").map((c) => c.trim());
            const filePath = cols[3];
            const start = Number(cols[4]);
            const end = Number(cols[5]);
            if (!filePath || !filePath.toUpperCase().endsWith(".PAR")) return null;
            return {
              path: filePath.replace(/\\/g, "/"),
              start,
              end,
              duration: end - start,
            };
          })
          .filter(Boolean);
        resolve(vparts);
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout fetching vparts")); });
  });
}

async function syncCamera(deviceIp, cam) {
  const key = `${deviceIp}:${cam}`;
  const now = Math.floor(Date.now() / 1000);

  const fromTime = lastSyncTime.has(key)
    ? lastSyncTime.get(key) - 60
    : now - SYNC_LOOKBACK;

  console.log(`[SyncService] cam${cam}@${deviceIp} — syncing from ${new Date(fromTime * 1000).toISOString()}`);

  const vparts = await fetchVparts(deviceIp, cam, fromTime);

  if (!vparts.length) {
    console.log(`[SyncService] cam${cam}@${deviceIp} — no new files`);
    lastSyncTime.set(key, now);
    return { uploaded: 0, failed: 0 };
  }

  console.log(`[SyncService] cam${cam}@${deviceIp} — ${vparts.length} file(s) to sync`);

  let uploaded = 0;
  let failed = 0;

  for (const vpart of vparts) {
    const tempDir = path.join(os.tmpdir(), `sync_${Date.now()}`);
    await fs.promises.mkdir(tempDir, { recursive: true });

    try {
      const parLocalPath = path.join(tempDir, path.basename(vpart.path));
      const normalizedPath = vpart.path.replace(/^\/+/, "/");
      const downloadUrl = `http://${deviceIp}${normalizedPath}`;
      await downloadFile(downloadUrl, parLocalPath);

      const date = new Date(vpart.start * 1000).toISOString().split("T")[0];
      const deviceFolder = deviceIp.replace(/\./g, "_");
      const ionosKey = `recordings/${deviceFolder}/cam${cam}/${date}/${path.basename(vpart.path)}`;

      const fileStream = fs.createReadStream(parLocalPath);
      await uploadStream(ionosKey, fileStream, "application/octet-stream");

      console.log(`[SyncService] ✅ ${ionosKey}`);
      uploaded++;
      lastSyncTime.set(key, vpart.end);

    } catch (err) {
      console.error(`[SyncService] ❌ ${vpart.path} — ${err.message}`);
      failed++;
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  return { uploaded, failed };
}

async function syncDevice(device) {
  const { deviceIp, cameras } = device;

  try {
    const results = await Promise.allSettled(
      cameras.map((cam) => syncCamera(deviceIp, cam))
    );

    let totalUploaded = 0;
    let totalFailed = 0;

    results.forEach((result, i) => {
      if (result.status === "fulfilled") {
        totalUploaded += result.value.uploaded;
        totalFailed += result.value.failed;
      } else {
        console.error(`[SyncService] ❌ cam${cameras[i]}@${deviceIp}: ${result.reason.message}`);
        totalFailed++;
      }
    });

    offlineDevices.delete(deviceIp);
    console.log(`[SyncService] ${deviceIp} — ✅ ${totalUploaded} uploaded, ❌ ${totalFailed} failed`);

  } catch (err) {
    const failures = (offlineDevices.get(deviceIp) || 0) + 1;
    offlineDevices.set(deviceIp, failures);

    if (failures >= OFFLINE_RETRY_LIMIT) {
      console.warn(`[SyncService] ⚠️  ${deviceIp} offline (${failures} failures) — retrying next interval`);
    } else {
      console.error(`[SyncService] ❌ ${deviceIp} failed (attempt ${failures}): ${err.message}`);
    }
  }
}

// ── public API

export async function runSync(devices) {
  console.log(`[SyncService] ── Sync started (${new Date().toISOString()}) ──`);

  // Run up to DEVICE_CONCURRENCY devices at a time
  await runWithConcurrency(devices, DEVICE_CONCURRENCY, (device) => syncDevice(device));

  console.log(`[SyncService] ── Sync complete ──`);
}

export function startSyncScheduler(devices, intervalMs = 15 * 60 * 1000) {
  console.log(`[SyncService] Scheduler started — interval: ${intervalMs / 60000} min, devices: ${devices.length}`);

  runSync(devices).catch((err) => console.error(`[SyncService] Sync error:`, err.message));

  const timer = setInterval(() => {
    runSync(devices).catch((err) => console.error(`[SyncService] Sync error:`, err.message));
  }, intervalMs);

  return () => {
    clearInterval(timer);
    console.log(`[SyncService] Scheduler stopped`);
  };
}