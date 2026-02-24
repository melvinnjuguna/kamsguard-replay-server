// testVpartsMP4.js
import fs from "fs";
import http from "http";
import https from "https";
import { URL } from "url";
import { spawn } from "child_process";

// ================= CONFIG =================
const CONFIG = {
  deviceIp: "192.168.1.75",
  camera: 1,
  secondsBack: 3600, // 1 minute
  outputFile: "output.mp4",
  frameRate: 25,
};
// ==========================================

function httpGetBuffer(url) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const client = urlObj.protocol === "https:" ? https : http;

    client
      .get(url, (res) => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      })
      .on("error", reject);
  });
}

function findH264Offset(buffer) {
  for (let i = 0; i < buffer.length - 4; i++) {
    if (
      buffer[i] === 0x00 &&
      buffer[i + 1] === 0x00 &&
      (buffer[i + 2] === 0x01 || (buffer[i + 2] === 0x00 && buffer[i + 3] === 0x01))
    ) {
      return i;
    }
  }
  return -1;
}

async function fetchVparts(deviceIp, cam, secondsBack) {
  const now = Math.floor(Date.now() / 1000);
  const startTime = now - secondsBack;
  const range = secondsBack;

  const vpartsUrl = `http://${deviceIp}/vparts.cgi?format=csv&listlength=100&pathstyle=long&time=${startTime}&range=${range}&domain=0&cam=${cam}`;
  const data = await httpGetBuffer(vpartsUrl);
  const lines = data.toString().split("\n").filter((l) => l.trim());

  const parFiles = lines
    .map((line) => {
      const cols = line.split(",").map((c) => c.trim());
      const path = cols[3];
      const start = Number(cols[4]);
      const end = Number(cols[5]);
      if (!path || !path.toUpperCase().endsWith(".PAR")) return null;
      return {
        path: "/" + path.replace(/\\/g, "/"),
        start,
        end,
        duration: end - start,
      };
    })
    .filter(Boolean);

  return parFiles;
}

async function convertFirstPARtoMP4() {
  console.log(`⏱ Fetching PAR files for the last ${CONFIG.secondsBack} seconds...`);
  const vparts = await fetchVparts(CONFIG.deviceIp, CONFIG.camera, CONFIG.secondsBack);

  if (!vparts.length) {
    console.error("❌ No PAR files found in this range.");
    return;
  }

  const par = vparts[0];
  console.log(`✅ Found 1 PAR file: ${par.path}`);
  console.log(`   Start: ${new Date(par.start * 1000).toISOString()}`);
  console.log(`   End:   ${new Date(par.end * 1000).toISOString()}`);
  console.log(`   Duration: ${par.duration} sec`);

  try {
    console.log("📥 Downloading PAR file...");
    const normalizedPath = "/" + par.path.replace(/^\/+/, "");
const buffer = await httpGetBuffer(`http://${CONFIG.deviceIp}${normalizedPath}`);
    console.log(`✅ Downloaded ${(buffer.length / 1024 / 1024).toFixed(2)} MB`);

    const offset = findH264Offset(buffer);
    if (offset < 0) {
      console.error("❌ No H.264 stream found.");
      return;
    }
    console.log(`🎬 H.264 stream starts at offset: ${offset}`);

    const rawVideo = buffer.slice(offset);

    console.log("⚙️ Converting to MP4 using ffmpeg...");
    const ffmpeg = spawn("ffmpeg", [
      "-y",
      "-f",
      "h264",
      "-r",
      String(CONFIG.frameRate),
      "-i",
      "pipe:0",
      "-c:v",
      "copy",
      CONFIG.outputFile,
    ]);

    ffmpeg.stdin.write(rawVideo);
    ffmpeg.stdin.end();

    ffmpeg.stderr.on("data", (data) => process.stdout.write(data.toString()));

    ffmpeg.on("close", (code) => {
      if (code === 0) console.log(`\n✅ MP4 created successfully: ${CONFIG.outputFile}`);
      else console.error(`❌ ffmpeg exited with code ${code}`);
    });
  } catch (err) {
    console.error("❌ Error:", err.message);
  }
}

convertFirstPARtoMP4();