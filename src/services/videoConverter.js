/**
 * Video Converter - PAR to MP4 conversion utilities
 * Handles NetVu PAR format conversion to browser-compatible MP4
 */

import { spawn } from 'child_process';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
import fs from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';
import { URL } from 'url';

// ── ffprobePath from ffprobe-static is an object: { path: '...' }
// Normalise so we always have a plain string regardless of package version.
const FFMPEG = ffmpegInstaller.path;
const FFPROBE = ffprobeInstaller.path;

// ====== DOWNLOAD ======

/**
 * Download a file from URL to local path.
 * Supports both http and https, and follows redirects once.
 */
export async function downloadFile(url, outputPath) {
  return new Promise((resolve, reject) => {
    console.log(`[VideoConverter] Downloading: ${url}`);

    // ── Validate URL format ─────────────────────────────────────────────
    if (!url || typeof url !== 'string') {
      return reject(new Error(`Invalid URL: ${url}`));
    }

    // Trim any whitespace
    url = url.trim();

    // Ensure URL has protocol
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return reject(new Error(`URL missing protocol: ${url}`));
    }

    // Parse URL
    let urlObj;
    try {
      urlObj = new URL(url);
    } catch (err) {
      return reject(new Error(`Invalid URL format: ${url} - ${err.message}`));
    }

    // Validate hostname
    if (!urlObj.hostname || urlObj.hostname === 'undefined' || urlObj.hostname === 'null') {
      return reject(new Error(`Invalid hostname in URL: ${url}`));
    }

    const client  = urlObj.protocol === 'https:' ? https : http;
    const file    = fs.createWriteStream(outputPath);

    const request = client.get(url, {
      headers: {
        'Accept': '*/*',
        'Connection': 'keep-alive',
        'Host': urlObj.host
      }
    }, (response) => {
      // Follow a single redirect (devices sometimes issue 302)
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.close();
        fs.unlink(outputPath, () => {});
        const redirectUrl = response.headers.location;
        console.log(`[VideoConverter] Following redirect to: ${redirectUrl}`);
        return downloadFile(redirectUrl, outputPath)
          .then(resolve).catch(reject);
      }

      if (response.statusCode !== 200) {
        file.close();
        fs.unlink(outputPath, () => {});
        return reject(new Error(`Download failed with status ${response.statusCode}`));
      }

      let downloadedBytes = 0;
      const totalBytes = parseInt(response.headers['content-length'] || '0');

      response.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        if (totalBytes > 0) {
          const pct = ((downloadedBytes / totalBytes) * 100).toFixed(1);
          process.stdout.write(`\r[VideoConverter] Progress: ${pct}% (${(downloadedBytes / 1024 / 1024).toFixed(2)} MB)`);
        }
      });

      response.pipe(file);

      file.on('finish', () => {
        file.close();
        console.log(`\n[VideoConverter] Download complete: ${outputPath}`);
        resolve(outputPath);
      });
    });

    request.on('error', (err) => { 
      file.close();
      fs.unlink(outputPath, () => {}); 
      reject(new Error(`Download request failed: ${err.message}`));
    });
    
    file.on('error', (err) => { 
      fs.unlink(outputPath, () => {}); 
      reject(new Error(`File write failed: ${err.message}`));
    });

    // Set timeout
    request.setTimeout(60000, () => {
      request.destroy();
      file.close();
      fs.unlink(outputPath, () => {});
      reject(new Error('Download timeout after 60 seconds'));
    });
  });
}

// ====== CONVERSION ======

/**
 * Convert a SINGLE PAR file to MP4.
 * Used by the ZIP endpoint — one call per file, fully independent temp dirs.
 *
 * Strategy: try stream-copy first (fast, no quality loss).
 * If FFmpeg exits non-zero, fall back to libx264 re-encode.
 */
export async function convertParToMp4Single(parFilePath, outputPath) {
  // --- attempt 1: stream copy (no re-encode) ---
  const ok = await _ffmpegRun(
    ['-i', parFilePath, '-c', 'copy', '-movflags', '+faststart', '-y', outputPath],
    'stream-copy'
  );

  if (ok) return outputPath;

  // --- attempt 2: full re-encode ---
  console.log(`[VideoConverter] Stream-copy failed, re-encoding: ${path.basename(parFilePath)}`);
  await _ffmpegRunOrThrow(
    [
      '-i', parFilePath,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      '-f', 'mp4', '-y', outputPath
    ],
    'libx264 re-encode'
  );

  return outputPath;
}

/**
 * Convert PAR file(s) to a single MP4 by concatenating then encoding.
 * Kept for backwards compatibility — prefer convertParToMp4Single for
 * the ZIP flow where each PAR maps to its own MP4.
 */
export async function convertParToMp4(parFiles, outputPath, options = {}) {
  const args = [];

  if (parFiles.length === 1) {
    args.push('-i', parFiles[0]);
  } else {
    const concatList = path.join(path.dirname(outputPath), 'concat.txt');
    fs.writeFileSync(concatList, parFiles.map(f => `file '${f}'`).join('\n'));
    args.push('-f', 'concat', '-safe', '0', '-i', concatList);
  }

  args.push(
    '-c:v', 'libx264',
    '-preset', options.preset || 'fast',
    '-crf', String(options.quality || 23),
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    '-f', 'mp4', '-y', outputPath
  );

  await _ffmpegRunOrThrow(args, 'concat+encode');

  // Clean up concat list
  const concatList = path.join(path.dirname(outputPath), 'concat.txt');
  if (fs.existsSync(concatList)) fs.unlinkSync(concatList);

  return outputPath;
}

/**
 * Fast stream-copy attempt, falling back to full re-encode.
 * Original API — kept for any callers outside the ZIP flow.
 */
export async function convertParToMp4Fast(parFiles, outputPath) {
  if (parFiles.length === 1) {
    return convertParToMp4Single(parFiles[0], outputPath);
  }
  // Multiple files: concat then try copy, fall back to encode
  return convertParToMp4(parFiles, outputPath);
}

// ====== ANALYSIS ======

/**
 * Analyse a PAR file with ffprobe to extract codec / duration info.
 * Non-critical — callers should wrap in try/catch.
 */
export async function analyzeParFile(parFilePath) {
  return new Promise((resolve, reject) => {
    console.log(`[VideoConverter] Analysing: ${parFilePath}`);

    // FIX: use the resolved FFPROBE path — ffprobePath was never defined before
    const ffprobe = spawn(FFPROBE, ['-i', parFilePath, '-hide_banner']);

    let output = '';
    ffprobe.stderr.on('data', (data) => { output += data.toString(); });

    ffprobe.on('close', () => {
      const info = {
        hasVideo:   output.includes('Video:'),
        hasAudio:   output.includes('Audio:'),
        videoCodec: (output.match(/Video: (\w+)/)     || [])[1] || null,
        audioCodec: (output.match(/Audio: (\w+)/)     || [])[1] || null,
        duration:   null,
        bitrate:    null
      };

      const dur = output.match(/Duration: (\d+):(\d+):(\d+)/);
      if (dur) {
        info.duration = parseInt(dur[1]) * 3600 + parseInt(dur[2]) * 60 + parseInt(dur[3]);
      }

      const br = output.match(/bitrate: (\d+) kb\/s/);
      if (br) info.bitrate = parseInt(br[1]);

      console.log(`[VideoConverter] Analysis:`, info);
      resolve(info);
    });

    ffprobe.on('error', reject);
  });
}

// ====== UTILITIES ======

/**
 * Clean up a temporary directory (non-throwing).
 */
export async function cleanupTemp(tempDir) {
  return new Promise((resolve) => {
    fs.rm(tempDir, { recursive: true, force: true }, (err) => {
      if (err) console.error(`[VideoConverter] Cleanup error: ${err.message}`);
      resolve();
    });
  });
}

/**
 * Check whether FFmpeg is present and executable.
 */
export async function checkFFmpegAvailable() {
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, ['-version']);
    p.on('close', (code) => resolve(code === 0));
    p.on('error', ()     => resolve(false));
  });
}

/**
 * Rough conversion-time estimate (for UI hints only).
 */
export function estimateConversionTime(fileSizeMB, durationSeconds) {
  const totalSeconds = Math.ceil((durationSeconds / 60) * 7.5 + fileSizeMB / 50);
  return { seconds: totalSeconds, formatted: _formatDuration(totalSeconds) };
}

// ====== PRIVATE HELPERS ======

/**
 * Run FFmpeg with the given args.
 * Returns true on success, false on non-zero exit (does NOT throw).
 */
function _ffmpegRun(args, label = '') {
  return new Promise((resolve) => {
    console.log(`[VideoConverter] FFmpeg (${label}): ffmpeg ${args.join(' ')}`);
    const p = spawn(FFMPEG, args);

    p.stderr.on('data', (data) => {
      const m = data.toString().match(/time=(\d+):(\d+):(\d+)/);
      if (m) process.stdout.write(`\r[VideoConverter] (${label}) ${m[1]}h${m[2]}m${m[3]}s`);
    });

    p.on('close', (code) => {
      process.stdout.write('\n');
      if (code === 0) {
        console.log(`[VideoConverter] ✅ ${label} succeeded`);
      } else {
        console.warn(`[VideoConverter] ⚠️  ${label} exited ${code}`);
      }
      resolve(code === 0);
    });

    p.on('error', () => resolve(false));
  });
}

/**
 * Run FFmpeg and throw on failure.
 */
async function _ffmpegRunOrThrow(args, label = '') {
  const ok = await _ffmpegRun(args, label);
  if (!ok) throw new Error(`FFmpeg (${label}) failed`);
}

function _formatDuration(seconds) {
  if (seconds < 60)   return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export default {
  downloadFile,
  convertParToMp4Single,
  convertParToMp4,
  convertParToMp4Fast,
  analyzeParFile,
  cleanupTemp,
  checkFFmpegAvailable,
  estimateConversionTime
};