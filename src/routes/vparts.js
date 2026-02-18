import express from "express";
import path from "path";
import { netVuHttpGet } from "../utils/netvuClient.js";
import { buildDeviceUrl, isValidVpartPath } from "../utils/urlHelpers.js";
import { estimateConversionTime } from "../services/videoConverter.js";

const router = express.Router();

async function fetchVparts(deviceUrl, cam, startTime, endTime) {
  const range = endTime - startTime;
  const url = buildDeviceUrl(
    deviceUrl,
    `/vparts.cgi?format=csv&listlength=100&pathstyle=long&time=${startTime}&range=${range}&domain=0&cam=${cam}`,
  );
  const response = await netVuHttpGet(url, 500, 30000);
  const vparts = [];

  for (const line of response.data.split("\n").filter((l) => l.trim())) {
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
      filename: path.basename(vpartPath),
      start: vpartStartTime,
      end: vpartEndTime,
      duration: vpartDuration,
      startDate: new Date(vpartStartTime * 1000).toISOString(),
      endDate: new Date(vpartEndTime * 1000).toISOString(),
    });
  }

  return vparts;
}

router.get("/vparts", async (req, res) => {
  try {
    const { device_url, cam = 1, start, end } = req.query;
    if (!device_url)
      return res.status(400).json({ error: "device_url is required" });
    if (!start || !end)
      return res.status(400).json({ error: "start and end are required" });

    const deviceUrl = decodeURIComponent(device_url);
    const startTime = parseInt(start);
    const endTime = parseInt(end);
    const vparts = await fetchVparts(deviceUrl, cam, startTime, endTime);

    res.json({
      device_url: deviceUrl,
      camera: parseInt(cam),
      start: startTime,
      end: endTime,
      range: endTime - startTime,
      count: vparts.length,
      vparts,
    });
  } catch (err) {
    console.error("VParts error:", err.message);
    res
      .status(500)
      .json({ error: "Failed to fetch VParts", details: err.message });
  }
});

router.get("/vparts/with-estimates", async (req, res) => {
  try {
    const { device_url, cam = 1, start, end } = req.query;
    if (!device_url)
      return res.status(400).json({ error: "device_url is required" });
    if (!start || !end)
      return res.status(400).json({ error: "start and end are required" });

    const deviceUrl = decodeURIComponent(device_url);
    const startTime = parseInt(start);
    const endTime = parseInt(end);
    const rawVparts = await fetchVparts(deviceUrl, cam, startTime, endTime);

    let totalEstimatedSeconds = 0;
    const vparts = rawVparts.map((vpart) => {
      const estimatedSizeMB = (vpart.duration / 30) * 1;
      const conversionEstimate = estimateConversionTime(
        estimatedSizeMB,
        vpart.duration,
      );
      totalEstimatedSeconds += conversionEstimate.seconds;
      return { ...vpart, estimatedConversionTime: conversionEstimate };
    });

    res.json({
      device_url: deviceUrl,
      camera: parseInt(cam),
      start: startTime,
      end: endTime,
      range: endTime - startTime,
      count: vparts.length,
      totalEstimatedConversionSeconds: totalEstimatedSeconds,
      totalEstimatedConversionFormatted: estimateConversionTime(
        0,
        totalEstimatedSeconds,
      ).formatted,
      vparts,
    });
  } catch (err) {
    console.error("VParts+Est error:", err.message);
    res.status(500).json({
      error: "Failed to fetch VParts with estimates",
      details: err.message,
    });
  }
});

export default router;
