import express from "express";
import { getDb } from "../../db.js";
import { netVuHttpGet } from "../utils/netvuClient.js";
import { buildDeviceUrl } from "../utils/urlHelpers.js";

const router = express.Router();

router.get("/events", async (req, res) => {
  try {
    const { device_url, cam = 1, start, end } = req.query;
    if (!device_url)
      return res.status(400).json({ error: "device_url is required" });

    const deviceUrl = decodeURIComponent(device_url);
    const startTime = parseInt(start) || 0;
    const endTime = parseInt(end) || -100;
    const isAbsoluteRange = startTime > 0 && endTime > 0;
    const listlength = isAbsoluteRange ? 1000 : endTime;

    const url = buildDeviceUrl(
      deviceUrl,
      `/events.cgi?format=csv&time=${startTime}&listlength=${listlength}`,
    );
    const response = await netVuHttpGet(url, 500, 10000);

    const db = await getDb();

    for (const line of response.data.split("\n").filter((l) => l.trim())) {
      const parts = line.split(",");
      if (parts.length < 7 || parts[2] === "No matching records") continue;

      const eventId = Number(parts[0]);
      const camNum = Number(parts[1]);
      const description = parts[2].trim();
      const eventTime = Number(parts[3]);
      const duration = Number(parts[4]);
      const rangeValue = Number(parts[5]);
      const existsFlag = parts[6].trim();

      if (isNaN(eventId) || isNaN(eventTime)) continue;
      if (cam && camNum !== parseInt(cam)) continue;
      if (isAbsoluteRange && (eventTime < startTime || eventTime > endTime))
        continue;

      const exists = await db.get(
        "SELECT id FROM events WHERE id = ? AND device_ip = ?",
        eventId,
        deviceUrl,
      );
      if (!exists) {
        await db.run(
          `INSERT INTO events (id, device_ip, cam, type, description, time, duration, range_value, exists_flag)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          eventId,
          deviceUrl,
          camNum,
          description.split(":")[0],
          description,
          eventTime,
          duration,
          rangeValue,
          existsFlag,
        );
      }
    }

    let savedEvents;
    if (isAbsoluteRange) {
      savedEvents = cam
        ? await db.all(
            "SELECT * FROM events WHERE device_ip = ? AND cam = ? AND time >= ? AND time <= ? ORDER BY time DESC",
            deviceUrl,
            cam,
            startTime,
            endTime,
          )
        : await db.all(
            "SELECT * FROM events WHERE device_ip = ? AND time >= ? AND time <= ? ORDER BY time DESC",
            deviceUrl,
            startTime,
            endTime,
          );
    } else {
      savedEvents = cam
        ? await db.all(
            "SELECT * FROM events WHERE device_ip = ? AND cam = ? ORDER BY time DESC LIMIT 100",
            deviceUrl,
            cam,
          )
        : await db.all(
            "SELECT * FROM events WHERE device_ip = ? ORDER BY time DESC LIMIT 100",
            deviceUrl,
          );
    }

    console.log(`[Events] Returning ${savedEvents.length} events`);
    res.json(savedEvents);
  } catch (err) {
    console.error("Events error:", err.message);
    res
      .status(500)
      .json({ error: "Failed to fetch events", details: err.message });
  }
});

export default router;
