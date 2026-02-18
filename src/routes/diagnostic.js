import express from "express";
import os from "os";
import { getDb } from "../../db.js";
import { netVuHttpGet } from "../utils/netvuClient.js";
import { buildDeviceUrl, sanitizeUrlForLogging } from "../utils/urlHelpers.js";
import { checkFFmpegAvailable } from "../services/videoConverter.js";

const router = express.Router();

// Stream format test
router.get("/diagnostic/stream-test/:id", async (req, res) => {
  try {
    const db = await getDb();
    const device = await db.get(
      "SELECT * FROM devices WHERE id = ?",
      req.params.id,
    );
    if (!device) return res.status(404).json({ error: "Device not found" });

    const cam = req.query.cam || 1;
    const deviceType = device.device_type || "nvr";
    const recommendedFormat = "mjpeg";
    const isGateway = deviceType !== "multidetector";

    const tests = [
      {
        name: "h264",
        url: buildDeviceUrl(
          device,
          `/display_pic.cgi?cam=${cam}&res=hi&format=h264&id=${Date.now()}`,
        ),
      },
      {
        name: "mp4",
        url: buildDeviceUrl(
          device,
          `/display_pic.cgi?cam=${cam}&res=hi&format=mp4&id=${Date.now()}`,
        ),
      },
      {
        name: "mjpeg",
        url: buildDeviceUrl(
          device,
          `/display_pic.cgi?cam=${cam}&res=hi&format=mjpeg&id=${Date.now()}`,
        ),
      },
      {
        name: "jpeg",
        url: buildDeviceUrl(
          device,
          `/display_pic.cgi?cam=${cam}&res=hi&format=jpeg&id=${Date.now()}`,
        ),
      },
      {
        name: "jfif",
        url: buildDeviceUrl(
          device,
          `/display_pic.cgi?cam=${cam}&res=hi&format=jfif&id=${Date.now()}`,
        ),
      },
      {
        name: "default",
        url: buildDeviceUrl(
          device,
          `/display_pic.cgi?cam=${cam}&res=hi&id=${Date.now()}`,
        ),
      },
    ];

    const results = [];
    for (const test of tests) {
      try {
        const response = await netVuHttpGet(test.url, 200, 3000);
        const firstBytes = response.data.substring(0, 100);
        const hex = Buffer.from(firstBytes).slice(0, 32).toString("hex");
        let detected = "unknown",
          recommended = "";
        if (hex.includes("667479706d70")) {
          detected = "MP4/fMP4 ✅";
        } else if (hex.includes("000001")) {
          detected = "Raw H.264 ✅";
        } else if (firstBytes.includes("<?xml")) {
          detected = "ADH/XML ❌";
        } else if (hex.startsWith("ffd8")) {
          detected = "JPEG ✅";
          recommended = isGateway ? "✅ RECOMMENDED" : "";
        }
        if (test.name === recommendedFormat) {
          recommended = "⭐ AUTO-SELECTED";
        }
        results.push({
          format: test.name,
          url: sanitizeUrlForLogging(test.url),
          status: response.status,
          contentType: response.headers["content-type"],
          detected,
          recommended,
          firstBytesHex: hex,
        });
      } catch (err) {
        results.push({ format: test.name, error: err.message });
      }
    }

    res.json({
      device: device.name,
      device_type: deviceType,
      is_gateway: isGateway,
      max_cameras: device.max_cameras || 16,
      has_auth: !!(device.username && device.password),
      recommended_format: recommendedFormat,
      results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// System diagnostics
router.get("/diagnostic/system", async (req, res) => {
  try {
    const ffmpegAvailable = await checkFFmpegAvailable();

    res.json({
      ffmpeg: {
        available: ffmpegAvailable,
        status: ffmpegAvailable ? "✅ Ready" : "❌ Not found",
      },
      system: {
        platform: os.platform(),
        arch: os.arch(),
        cpus: os.cpus().length,
        totalMemory: `${(os.totalmem() / 1024 / 1024 / 1024).toFixed(2)} GB`,
        freeMemory: `${(os.freemem() / 1024 / 1024 / 1024).toFixed(2)} GB`,
        tmpDir: os.tmpdir(),
      },
      capabilities: {
        parDownload: true,
        mp4Conversion: ffmpegAvailable,
        concatenation: ffmpegAvailable,
        analysis: ffmpegAvailable,
      },
    });
  } catch (err) {
    res.status(500).json({
      error: "Failed to get system diagnostics",
      details: err.message,
    });
  }
});

export default router;
