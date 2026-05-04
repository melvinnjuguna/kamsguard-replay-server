import "dotenv/config";
import express from "express";
import cors from "cors";

import { getDb } from "./db.js";
import StreamManager from "./src/services/streamManager.js";
import { checkFFmpegAvailable } from "./src/services/videoConverter.js";
import { testConnection } from "./src/services/storageService.js";
import { startSyncScheduler } from "./src/services/syncService.js";

import camerasRouter from "./src/routes/cameras.js";
import vpartsRouter from "./src/routes/vparts.js";
import streamRouter, { setStreamManager } from "./src/routes/stream.js";
import videoRouter from "./src/routes/video.js";
import diagnosticRouter from "./src/routes/diagnostic.js";
import healthRouter from "./src/routes/health.js";

const app = express();
const streamManager = new StreamManager({ maxStreams: 100 });

// ── devices to sync ───────────────────────────────────────────────────────────
const SYNC_DEVICES = [
  { deviceIp: "192.168.1.75", cameras: [1] },
  { deviceIp: "192.168.1.70", cameras: [1] }
];

app.use(cors({ origin: "http://localhost:4200", credentials: true }));
app.use(express.json());
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

streamManager.on("stream-started", ({ streamId, type, contentType }) => {
  console.log(`✓ Stream started: ${streamId} (${type}) - ${contentType}`);
});
streamManager.on("stream-stopped", ({ streamId, duration, stats }) => {
  console.log(
    `✗ Stream stopped: ${streamId} - Duration: ${(duration / 1000).toFixed(1)}s, Bytes: ${(stats.bytes / 1024 / 1024).toFixed(2)} MB`,
  );
});
streamManager.on("stream-error", ({ streamId, error }) => {
  console.error(`⚠ Stream error: ${streamId} - ${error.message}`);
});

app.use("/api", camerasRouter);
app.use("/api", vpartsRouter);
app.use("/api", healthRouter);
app.use("/api", videoRouter);
app.use("/api", diagnosticRouter);

setStreamManager(streamManager);
app.use("/api", streamRouter);

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error", details: err.message });
});

let stopSync = null;

process.on("SIGINT", () => {
  if (stopSync) stopSync();
  streamManager.cleanup();
  setTimeout(() => process.exit(0), 1000);
});
process.on("SIGTERM", () => {
  if (stopSync) stopSync();
  streamManager.cleanup();
  setTimeout(() => process.exit(0), 1000);
});

const PORT = 3000;
app.listen(PORT, async () => {
  console.log(`\n🚀 Kamsguard Observer Proxy  — http://localhost:${PORT}\n`);

  try {
    await getDb();
    console.log("✅ Database ready");
  } catch (err) {
    console.error("❌ Database init failed:", err.message);
    process.exit(1);
  }

  try {
    await testConnection();
    console.log("✅ IONOS storage ready");
  } catch (err) {
    console.error("❌ IONOS storage connection failed:", err.message);
  }

  const ffmpegOk = await checkFFmpegAvailable();
  console.log(
    ffmpegOk
      ? "✅ FFmpeg available"
      : "⚠️  FFmpeg not found — video conversion disabled",
  );

  // Start sync scheduler — 5 minutes for testing
  stopSync = startSyncScheduler(SYNC_DEVICES, 15 * 60 * 1000);
  console.log("✅ Sync scheduler started");

  console.log(`
📺 Replay (proxy — adhbinary → MJPEG):
   GET  /api/stream/replay?device_url=&cam=&time=&speed=

📦 Download:
   GET  /api/stream/download-zip?device_url=&cam=&start=&end=
   GET  /api/stream/download-zip-mp4?device_url=&cam=&start=&end=
   POST /api/video/concatenate

📋 VParts:
   GET  /api/vparts?device_url=&cam=&start=&end=
   GET  /api/vparts/with-estimates?device_url=&cam=&start=&end=

📊 Stats & control:
   GET  /api/stream/stats
   DELETE /api/stream/:streamId

🏥 Health & diagnostics:
   GET  /api/health/:id
   GET  /api/diagnostic/stream-test/:id
   GET  /api/diagnostic/system
  `);
});