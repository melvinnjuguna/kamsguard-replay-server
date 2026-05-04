import "dotenv/config";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { downloadFile, convertParToMp4Single } from "./src/services/videoConverter.js";
import { uploadStream } from "./src/services/storageService.js";

const CONFIG = {
  deviceIp: "192.168.1.75",
  camera: 1,
  secondsBack: 3600,
};

async function fetchVparts(deviceIp, cam, secondsBack) {
  const now = Math.floor(Date.now() / 1000);
  const startTime = now - secondsBack;
  const url = `http://${deviceIp}/vparts.cgi?format=csv&listlength=100&pathstyle=long&time=${startTime}&range=${secondsBack}&domain=0&cam=${cam}`;

  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
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
    }).on("error", reject);
  });
}

async function test() {
  console.log(`⏱  Fetching vparts for last ${CONFIG.secondsBack}s...`);
  const vparts = await fetchVparts(CONFIG.deviceIp, CONFIG.camera, CONFIG.secondsBack);

  if (!vparts.length) {
    console.error("❌ No PAR files found.");
    return;
  }

  const par = vparts[0];
  console.log(`✅ Found: ${par.path}`);
  console.log(`   Start:    ${new Date(par.start * 1000).toISOString()}`);
  console.log(`   End:      ${new Date(par.end * 1000).toISOString()}`);
  console.log(`   Duration: ${par.duration}s`);

  const tempDir = path.join(os.tmpdir(), `test_sync_${Date.now()}`);
  await fs.promises.mkdir(tempDir, { recursive: true });

  try {
  // Step 1 — Download
    const parLocalPath = path.join(tempDir, path.basename(par.path));
    const normalizedPath = par.path.replace(/^\/+/, "/");
    const downloadUrl = `http://${CONFIG.deviceIp}${normalizedPath}`;
    console.log(`\n📥 Downloading: ${downloadUrl}`);
    await downloadFile(downloadUrl, parLocalPath);

    // 🔍 Inspect PAR header
    const buffer = fs.readFileSync(parLocalPath);
    console.log("\n🔍 PAR header (hex):");
    console.log(buffer.slice(0, 64).toString("hex"));
    console.log("🔍 PAR header (ascii):");
    console.log(buffer.slice(0, 64).toString("ascii").replace(/[^\x20-\x7E]/g, "."));

    // Step 2 — Convert
    const mp4LocalPath = path.join(tempDir, "converted.mp4");
    console.log(`\n⚙️  Converting...`);
    await convertParToMp4Single(parLocalPath, mp4LocalPath);
    const sizeMB = (fs.statSync(mp4LocalPath).size / 1024 / 1024).toFixed(2);
    console.log(`✅ Converted: ${sizeMB} MB`);

    // Step 3 — Upload to IONOS
    const date = new Date(par.start * 1000).toISOString().split("T")[0];
    const time = new Date(par.start * 1000).toISOString().split("T")[1].replace(/[:.]/g, "-").slice(0, 8);
    const ionosKey = `recordings/cam${CONFIG.camera}/${date}/${time}.mp4`;

    console.log(`\n☁️  Uploading to IONOS: ${ionosKey}`);
    const fileStream = fs.createReadStream(mp4LocalPath);
    await uploadStream(ionosKey, fileStream, "video/mp4");
    console.log(`✅ Uploaded: ${ionosKey}`);

  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
    console.log(`🧹 Temp cleaned up`);
  }
}

test().catch(console.error);