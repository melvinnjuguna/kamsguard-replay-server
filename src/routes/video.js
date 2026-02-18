import express from "express";
import path from "path";
import os from "os";
import fs from "fs";
import archiver from "archiver";
import { netVuHttpGet } from "../utils/netvuClient.js";
import {
  buildDeviceUrl,
  sanitizeUrlForLogging,
  isValidVpartPath,
} from "../utils/urlHelpers.js";
import { runWithConcurrency } from "../utils/concurrency.js";
import {
  downloadFile,
  convertParToMp4Single,
  convertParToMp4,
  analyzeParFile,
  cleanupTemp,
  estimateConversionTime,
} from "../services/videoConverter.js";

const router = express.Router();

router.get("/video/analyze", async (req, res) => {
  try {
    const { device_url, path: filePath } = req.query;
    if (!device_url || !filePath) {
      return res
        .status(400)
        .json({ error: "device_url and path are required" });
    }

    const deviceUrl = decodeURIComponent(device_url);
    const tempDir = path.join(os.tmpdir(), `analyze_${Date.now()}`);
    await fs.promises.mkdir(tempDir, { recursive: true });

    try {
      const tempFilePath = path.join(tempDir, "temp.par");
      const fileUrl = buildDeviceUrl(deviceUrl, filePath);
      await downloadFile(fileUrl, tempFilePath);

      const analysis = await analyzeParFile(tempFilePath);
      const stats = await fs.promises.stat(tempFilePath);
      const fileSizeMB = stats.size / 1024 / 1024;
      const estimate = analysis.duration
        ? estimateConversionTime(fileSizeMB, analysis.duration)
        : null;

      res.json({
        path: filePath,
        filename: path.basename(filePath),
        fileSize: stats.size,
        fileSizeMB: fileSizeMB.toFixed(2),
        analysis,
        conversionEstimate: estimate,
      });

      await cleanupTemp(tempDir);
    } catch (err) {
      await cleanupTemp(tempDir);
      throw err;
    }
  } catch (err) {
    console.error("Analyze error:", err.message);
    res
      .status(500)
      .json({ error: "Failed to analyze file", details: err.message });
  }
});

router.get("/stream/download-zip", async (req, res) => {
  const { device_url, cam = 1, start, end } = req.query;
  if (!device_url)
    return res.status(400).json({ error: "device_url is required" });
  if (!start || !end)
    return res.status(400).json({ error: "start and end are required" });

  let tempDir = null;
  try {
    const deviceUrl = decodeURIComponent(device_url);
    const startTime = parseInt(start);
    const endTime = parseInt(end);
    const camNum = parseInt(cam);
    const range = endTime - startTime;

    if (range > 14400) {
      return res.status(400).json({
        error: "Range too large",
        message: "Maximum download range is 4 hours.",
      });
    }

    const vpartsUrl = buildDeviceUrl(
      deviceUrl,
      `/vparts.cgi?format=csv&listlength=100&pathstyle=long&time=${startTime}&range=${range}&domain=0&cam=${camNum}`,
    );
    const vpartsResponse = await netVuHttpGet(vpartsUrl, 500, 30000);

    const vparts = [];
    for (const line of vpartsResponse.data
      .split("\n")
      .filter((l) => l.trim())) {
      const parts = line.split(",").map((p) => p.trim());
      if (parts.length < 6) continue;

      const vpartPath = parts[3];
      const vpartStartTime = Number(parts[4]);
      const vpartEndTime = Number(parts[5]);
      const vpartDuration = vpartEndTime - vpartStartTime;

      if (isNaN(vpartStartTime) || isNaN(vpartEndTime) || isNaN(vpartDuration))
        continue;
      if (!isValidVpartPath(vpartPath)) continue;

      vparts.push({
        path: vpartPath.replace(/\\/g, "/"),
        start: vpartStartTime,
        duration: vpartDuration,
      });
    }

    if (vparts.length === 0) {
      return res
        .status(404)
        .json({ error: "No recordings found for the selected time range." });
    }

    const deviceHost = new URL(deviceUrl).hostname.replace(/\./g, "_");
    tempDir = path.join(
      os.tmpdir(),
      `zip_${Date.now()}_${deviceHost}_${camNum}`,
    );
    await fs.promises.mkdir(tempDir, { recursive: true });

    const parPaths = await runWithConcurrency(vparts, 3, async (vpart, i) => {
      const parFilename = path.basename(vpart.path);
      const parLocalPath = path.join(tempDir, `${i}_${parFilename}`);
      const downloadUrl = buildDeviceUrl(deviceUrl, vpart.path);

      console.log(
        `[DownloadZIP] [${i + 1}/${vparts.length}] ${sanitizeUrlForLogging(downloadUrl)}`,
      );
      await downloadFile(downloadUrl, parLocalPath);

      const dateStr = new Date(vpart.start * 1000)
        .toISOString()
        .replace(/[:.]/g, "-")
        .slice(0, 19);
      return {
        localPath: parLocalPath,
        zipEntry: `${deviceHost}_cam${camNum}_${dateStr}.par`,
      };
    });

    const dateFrom = new Date(startTime * 1000).toISOString().split("T")[0];
    const dateTo = new Date(endTime * 1000).toISOString().split("T")[0];
    const zipName = `${deviceHost}_cam${camNum}_${dateFrom}_to_${dateTo}.zip`;

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);
    res.setHeader("Cache-Control", "no-cache");

    const archive = archiver("zip", { zlib: { level: 0 } });

    archive.on("warning", (err) => {
      if (err.code !== "ENOENT")
        console.error("[DownloadZIP] Archiver warning:", err.message);
    });
    archive.on("error", async (err) => {
      console.error("[DownloadZIP] Archiver error:", err);
      if (!res.headersSent)
        res.status(500).json({ error: "ZIP creation failed" });
    });
    archive.on("finish", async () => {
      console.log(
        `[DownloadZIP] ✅ ${zipName} (${(archive.pointer() / 1024 / 1024).toFixed(2)} MB)`,
      );
      await cleanupTemp(tempDir).catch(() => {});
    });
    req.on("close", async () => {
      if (!res.writableEnded) {
        archive.abort();
        await cleanupTemp(tempDir).catch(() => {});
      }
    });

    archive.pipe(res);
    for (const { localPath, zipEntry } of parPaths) {
      archive.file(localPath, { name: zipEntry });
    }
    await archive.finalize();
  } catch (err) {
    console.error("[DownloadZIP] Error:", err.message);
    await cleanupTemp(tempDir).catch(() => {});
    if (!res.headersSent)
      res.status(500).json({ error: "Download failed", details: err.message });
  }
});

router.get("/stream/download-zip-mp4", async (req, res) => {
  const { device_url, cam = 1, start, end } = req.query;
  if (!device_url)
    return res.status(400).json({ error: "device_url is required" });
  if (!start || !end)
    return res.status(400).json({ error: "start and end are required" });

  let tempDir = null;
  try {
    const deviceUrl = decodeURIComponent(device_url);
    const startTime = parseInt(start);
    const endTime = parseInt(end);
    const camNum = parseInt(cam);
    const range = endTime - startTime;

    if (range > 7200) {
      return res.status(400).json({
        error: "Range too large for MP4 conversion",
        message:
          "Maximum range with conversion is 2 hours. Use /download-zip for larger ranges.",
      });
    }

    const vpartsUrl = buildDeviceUrl(
      deviceUrl,
      `/vparts.cgi?format=csv&listlength=100&pathstyle=long&time=${startTime}&range=${range}&domain=0&cam=${camNum}`,
    );
    const vpartsResponse = await netVuHttpGet(vpartsUrl, 500, 30000);

    const vparts = [];
    for (const line of vpartsResponse.data
      .split("\n")
      .filter((l) => l.trim())) {
      const parts = line.split(",").map((p) => p.trim());
      if (parts.length < 6) continue;

      const vpartPath = parts[3];
      const vpartStartTime = Number(parts[4]);
      const vpartEndTime = Number(parts[5]);
      const vpartDuration = vpartEndTime - vpartStartTime;

      if (isNaN(vpartStartTime) || isNaN(vpartEndTime) || isNaN(vpartDuration))
        continue;
      if (!isValidVpartPath(vpartPath)) continue;

      vparts.push({
        path: vpartPath.replace(/\\/g, "/"),
        start: vpartStartTime,
        duration: vpartDuration,
      });
    }

    if (vparts.length === 0) {
      return res
        .status(404)
        .json({ error: "No recordings found for the selected time range." });
    }

    const deviceHost = new URL(deviceUrl).hostname.replace(/\./g, "_");
    tempDir = path.join(
      os.tmpdir(),
      `zip_mp4_${Date.now()}_${deviceHost}_${camNum}`,
    );
    await fs.promises.mkdir(tempDir, { recursive: true });

    const mp4Paths = await runWithConcurrency(vparts, 3, async (vpart, i) => {
      const parFilename = path.basename(vpart.path);
      const parLocalPath = path.join(tempDir, `${i}_${parFilename}`);
      const mp4LocalPath = path.join(tempDir, `${i}_converted.mp4`);
      const downloadUrl = buildDeviceUrl(deviceUrl, vpart.path);

      console.log(
        `[DownloadZIP-MP4] [${i + 1}/${vparts.length}] ${sanitizeUrlForLogging(downloadUrl)}`,
      );
      await downloadFile(downloadUrl, parLocalPath);
      await convertParToMp4Single(parLocalPath, mp4LocalPath);
      await fs.promises.unlink(parLocalPath).catch(() => {});

      const dateStr = new Date(vpart.start * 1000)
        .toISOString()
        .replace(/[:.]/g, "-")
        .slice(0, 19);
      return {
        localPath: mp4LocalPath,
        zipEntry: `${deviceHost}_cam${camNum}_${dateStr}.mp4`,
      };
    });

    const dateFrom = new Date(startTime * 1000).toISOString().split("T")[0];
    const dateTo = new Date(endTime * 1000).toISOString().split("T")[0];
    const zipName = `${deviceHost}_cam${camNum}_${dateFrom}_to_${dateTo}_mp4.zip`;

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);
    res.setHeader("Cache-Control", "no-cache");

    const archive = archiver("zip", { zlib: { level: 0 } });

    archive.on("warning", (err) => {
      if (err.code !== "ENOENT")
        console.error("[DownloadZIP-MP4] Archiver warning:", err.message);
    });
    archive.on("error", async (err) => {
      console.error("[DownloadZIP-MP4] Archiver error:", err);
      if (!res.headersSent)
        res.status(500).json({ error: "ZIP creation failed" });
    });
    archive.on("finish", async () => {
      console.log(
        `[DownloadZIP-MP4] ✅ ${zipName} (${(archive.pointer() / 1024 / 1024).toFixed(2)} MB)`,
      );
      await cleanupTemp(tempDir).catch(() => {});
    });
    req.on("close", async () => {
      if (!res.writableEnded) {
        archive.abort();
        await cleanupTemp(tempDir).catch(() => {});
      }
    });

    archive.pipe(res);
    for (const { localPath, zipEntry } of mp4Paths) {
      archive.file(localPath, { name: zipEntry });
    }
    await archive.finalize();
  } catch (err) {
    console.error("[DownloadZIP-MP4] Error:", err.message);
    await cleanupTemp(tempDir).catch(() => {});
    if (!res.headersSent)
      res.status(500).json({
        error: "Download with conversion failed",
        details: err.message,
      });
  }
});

router.post("/video/concatenate", async (req, res) => {
  const { device_url, paths, output_name } = req.body;
  if (!device_url || !paths || !Array.isArray(paths) || paths.length === 0) {
    return res
      .status(400)
      .json({ error: "device_url and paths array are required" });
  }

  let tempDir = null;
  try {
    const deviceUrl = decodeURIComponent(device_url);
    const deviceHost = new URL(deviceUrl).hostname.replace(/\./g, "_");
    tempDir = path.join(os.tmpdir(), `concat_${Date.now()}_${deviceHost}`);
    await fs.promises.mkdir(tempDir, { recursive: true });

    const parFiles = await runWithConcurrency(paths, 3, async (filePath, i) => {
      const parLocalPath = path.join(
        tempDir,
        `${i}_${path.basename(filePath)}`,
      );
      await downloadFile(buildDeviceUrl(deviceUrl, filePath), parLocalPath);
      return parLocalPath;
    });

    const outputFileName = output_name || `concatenated_${Date.now()}.mp4`;
    const outputPath = path.join(tempDir, outputFileName);

    await convertParToMp4(parFiles, outputPath, {
      preset: "fast",
      quality: 23,
    });

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${outputFileName}"`,
    );
    res.setHeader("Cache-Control", "no-cache");

    const fileStream = fs.createReadStream(outputPath);
    fileStream.pipe(res);

    fileStream.on("end", async () => {
      await cleanupTemp(tempDir).catch(() => {});
    });
    fileStream.on("error", async (err) => {
      console.error("[Concatenate] Stream error:", err);
      await cleanupTemp(tempDir).catch(() => {});
      if (!res.headersSent) res.status(500).json({ error: "Stream failed" });
    });
    req.on("close", async () => {
      if (!res.writableEnded) {
        fileStream.destroy();
        await cleanupTemp(tempDir).catch(() => {});
      }
    });
  } catch (err) {
    console.error("[Concatenate] Error:", err.message);
    await cleanupTemp(tempDir).catch(() => {});
    if (!res.headersSent)
      res
        .status(500)
        .json({ error: "Concatenation failed", details: err.message });
  }
});

export default router;
