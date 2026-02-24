import express from "express";

const router = express.Router();

let streamManager;
export function setStreamManager(sm) {
  streamManager = sm;
}

router.get("/stream/replay", async (req, res) => {
  try {
    const { device_url, cam = 1, time } = req.query;
    if (!device_url) return res.status(400).json({ error: "device_url is required" });
    if (!time) return res.status(400).json({ error: "time is required" });

    const deviceUrl = decodeURIComponent(device_url);
    const camNum = parseInt(cam);

    const ALLOWED_SPEEDS = [-16, -4, -1, 1, 4, 16, 64];
    const speed = ALLOWED_SPEEDS.includes(parseFloat(req.query.speed))
      ? parseFloat(req.query.speed)
      : 1;

    const stream = await streamManager.startReplayStream(deviceUrl, camNum, parseInt(time), { speed });

    res.setHeader("Content-Type", "multipart/x-mixed-replace; boundary=frame");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("X-Stream-Id", stream.id);
    res.setHeader("X-Stream-Type", "replay");
    res.setHeader("X-Replay-Time", time);
    res.setHeader("Access-Control-Expose-Headers", "X-Stream-Id, X-Stream-Type, X-Replay-Time");
    res.setTimeout(0);

    streamManager.addClient(stream.id, res);
    req.on("close", () => console.log(`[Replay] Client disconnected: ${stream.id}`));
  } catch (err) {
    console.error("[Replay] Error:", err.message);
    if (!res.headersSent)
      res.status(503).json({ error: err.message });
  }
});

router.get("/stream/stats", (req, res) => {
  try {
    res.json({ manager: streamManager.getStats(), streams: streamManager.getActiveStreams() });
  } catch (err) {
    res.status(500).json({ error: "Failed to get stats" });
  }
});

router.delete("/stream/:streamId", (req, res) => {
  try {
    const success = streamManager.stopStream(req.params.streamId);
    if (success) res.json({ success: true });
    else res.status(404).json({ error: "Stream not found" });
  } catch (err) {
    res.status(500).json({ error: "Failed to stop stream" });
  }
});

/**
 * GET /api/stream/download-zip-mp4
 * Fetches PARs for the range, converts to MP4, and streams either:
 *  - Single MP4 directly
 *  - Multiple MP4s as ZIP
 */
router.get("/download-zip-mp4", async (req, res) => {
  try {
    const { device_url, cam = 1, start, end } = req.query;
    if (!device_url || !start || !end) {
      return res.status(400).json({ error: "Missing required parameters: device_url, start, end" });
    }

    const startTime = parseInt(start);
    const endTime = parseInt(end);

    // Fetch recordings for the requested time range
    const vparts = await fetchVparts(device_url, cam, startTime, endTime);

    if (!vparts.length) {
      return res.status(404).json({ error: "No recordings found for the requested range" });
    }

    // Temporary directory for MP4 conversion
    const tmpDir = path.join(process.cwd(), "tmp_mp4");
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    const mp4Files = [];
    for (const vp of vparts) {
      const outputMp4 = path.join(tmpDir, vp.filename.replace(".PAR", ".mp4"));
      await convertParToMp4Single(vp.path, outputMp4);
      mp4Files.push({ path: outputMp4, name: path.basename(outputMp4) });
    }

    // Single MP4 → direct download
    if (mp4Files.length === 1) {
      res.download(mp4Files[0].path, mp4Files[0].name, () => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      });
      return;
    }

    // Multiple MP4s → ZIP
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="videos.zip"`);

    const archive = archiver("zip");
    archive.pipe(res);

    for (const file of mp4Files) {
      archive.file(file.path, { name: file.name });
    }

    archive.finalize();

    // Clean up after archive finishes
    archive.on("end", () => fs.rmSync(tmpDir, { recursive: true, force: true }));

  } catch (err) {
    console.error("Download MP4 error:", err);
    res.status(500).json({ error: "Failed to prepare MP4 download", details: err.message });
  }
});


export default router;