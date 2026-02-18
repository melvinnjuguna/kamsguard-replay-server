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

export default router;