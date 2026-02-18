import express from "express";
import { getDb } from "../../db.js";
import { netVuHttpGet } from "../../netvuClient.js";
import { buildDeviceUrl, isValidAddress } from "../utils/urlHelpers.js";

const router = express.Router();

router.post("/devices", async (req, res) => {
  try {
    const {
      name,
      ip_address,
      device_type = "nvr",
      max_cameras = 16,
      username = null,
      password = null,
    } = req.body;
    if (!name || !ip_address)
      return res
        .status(400)
        .json({ error: "Name and IP address are required" });

    if (!isValidAddress(ip_address))
      return res.status(400).json({ error: "Invalid IP or URL format" });

    try {
      const testDevice = { ip_address, username, password };
      const testUrl = buildDeviceUrl(testDevice, "/");
      await netVuHttpGet(testUrl, 500, 5000);

      const db = await getDb();
      const result = await db.run(
        "INSERT INTO devices (name, ip_address, site_id, status, device_type, max_cameras, username, password) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        name,
        ip_address,
        "Unknown",
        "active",
        device_type,
        max_cameras,
        username,
        password,
      );
      res.json(
        await db.get("SELECT * FROM devices WHERE id = ?", result.lastID),
      );
    } catch (connErr) {
      if (
        username &&
        password &&
        (connErr.message.includes("401") ||
          connErr.message.includes("Unauthorized"))
      ) {
        return res
          .status(401)
          .json({
            error: "Authentication failed",
            details: `Invalid credentials for ${ip_address}`,
          });
      }
      return res
        .status(503)
        .json({
          error: "Cannot connect to device",
          details: `${ip_address} unreachable: ${connErr.message}`,
        });
    }
  } catch (err) {
    if (err.message?.includes("UNIQUE constraint failed")) {
      res.status(409).json({ error: "Device with this IP already exists" });
    } else {
      res
        .status(500)
        .json({ error: "Failed to add device", details: err.message });
    }
  }
});

router.get("/devices", async (req, res) => {
  try {
    const db = await getDb();
    res.json(await db.all("SELECT * FROM devices ORDER BY created_at DESC"));
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch devices" });
  }
});

router.get("/devices/:id", async (req, res) => {
  try {
    const db = await getDb();
    const device = await db.get(
      "SELECT * FROM devices WHERE id = ?",
      req.params.id,
    );
    if (!device) return res.status(404).json({ error: "Device not found" });
    res.json(device);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch device" });
  }
});

router.put("/devices/:id", async (req, res) => {
  try {
    const { name, status, device_type, max_cameras, username, password } =
      req.body;
    const db = await getDb();
    const updates = [],
      params = [];
    if (name !== undefined) {
      updates.push("name = ?");
      params.push(name);
    }
    if (status !== undefined) {
      updates.push("status = ?");
      params.push(status);
    }
    if (device_type !== undefined) {
      updates.push("device_type = ?");
      params.push(device_type);
    }
    if (max_cameras !== undefined) {
      updates.push("max_cameras = ?");
      params.push(max_cameras);
    }
    if (username !== undefined) {
      updates.push("username = ?");
      params.push(username);
    }
    if (password !== undefined) {
      updates.push("password = ?");
      params.push(password);
    }
    params.push(req.params.id);
    await db.run(
      `UPDATE devices SET ${updates.join(", ")} WHERE id = ?`,
      ...params,
    );
    res.json(await db.get("SELECT * FROM devices WHERE id = ?", req.params.id));
  } catch (err) {
    res.status(500).json({ error: "Failed to update device" });
  }
});

router.delete("/devices/:id", async (req, res) => {
  try {
    const db = await getDb();
    await db.run(
      "DELETE FROM events WHERE device_ip = (SELECT ip_address FROM devices WHERE id = ?)",
      req.params.id,
    );
    await db.run("DELETE FROM devices WHERE id = ?", req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete device" });
  }
});

export default router;
