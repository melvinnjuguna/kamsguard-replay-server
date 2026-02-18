import express from "express";
import { netVuHttpGet } from "../utils/netvuClient.js";
import { buildDeviceUrl } from "../utils/urlHelpers.js";

const router = express.Router();

router.get("/cameras", async (req, res) => {
  try {
    const { device_url } = req.query;
    if (!device_url)
      return res.status(400).json({ error: "device_url is required" });

    const deviceUrl = decodeURIComponent(device_url);
    const response = await netVuHttpGet(
      buildDeviceUrl(deviceUrl, "/camlist.cgi"),
      500,
      10000,
    );

    try {
      return res.json(JSON.parse(response.data));
    } catch {
      res.setHeader(
        "Content-Type",
        response.data.trim().startsWith("<") ? "application/xml" : "text/plain",
      );
      return res.send(response.data);
    }
  } catch (err) {
    res
      .status(500)
      .json({ error: "Failed to fetch camera list", details: err.message });
  }
});

export default router;
