import express from "express";
import { getDb } from "../../db.js";
import { netVuHttpGet } from "../utils/netvuClient.js";
import { buildDeviceUrl } from "../utils/urlHelpers.js";

const router = express.Router();

router.get("/health/:id", async (req, res) => {
  try {
    const db = await getDb();
    const device = await db.get(
      "SELECT * FROM devices WHERE id = ?",
      req.params.id,
    );
    if (!device) return res.status(404).json({ error: "Device not found" });
    await netVuHttpGet(buildDeviceUrl(device, "/"), 500, 5000);
    const isGateway = device.device_type !== "multidetector";
    res.json({
      status: "ok",
      device: device.ip_address,
      device_name: device.name,
      device_type: device.device_type || "nvr",
      max_cameras: device.max_cameras || 16,
      is_gateway: isGateway,
      has_auth: !!(device.username && device.password),
      connected: true,
    });
  } catch (err) {
    res
      .status(503)
      .json({ status: "error", connected: false, error: err.message });
  }
});

export default router;
