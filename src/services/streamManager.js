/**
 * Stream Manager - Multi-Device Type Support
 *
 * NVR devices: MJPEG streams
 * Multidetector devices: H.264 streams
 * Replay streams: Convert adhbinary to MJPEG
 *
 * Supports both http:// and https:// device URLs.
 * VPN tunnel URLs (e.g. https://frontgate.kamsware.kamsguard.com) are HTTPS.
 */

import { EventEmitter } from "events";
import http from "http";
import https from "https";
import { URL } from "url";

// Pick http or https based on the URL
function transportFor(url) {
  return url.startsWith("https://") ? https : http;
}

// For HTTPS connections to VPN tunnel devices with internal certs.
// rejectUnauthorized: false — remove once devices have publicly valid certs.
const httpsOptions = { rejectUnauthorized: false };

export class StreamManager extends EventEmitter {
  constructor(options = {}) {
    super();

    this.streams = new Map();
    this.maxStreams = options.maxStreams || 100;
    this.defaultTimeout = options.timeout || 30000;

    this.totalStreamsCreated = 0;
    this.totalStreamsFailed = 0;
  }

  /**
   * Start a live stream from a NetVu device.
   * Supports both MJPEG (NVR) and H.264 (Multidetector).
   */
  async startLiveStream(deviceIp, cam = 1, options = {}) {
    const streamId = `live_${deviceIp}_${cam}_${Date.now()}`;

    if (this.streams.size >= this.maxStreams) {
      throw new Error(`Maximum streams limit reached (${this.maxStreams})`);
    }

    const resolution = options.resolution || "hi";
    const format = options.format || "mjpeg";
    const deviceType = options.deviceType || "nvr";

    let base = deviceIp;
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(base)) base = `http://${base}`;
    const url = new URL(
      `/display_pic.cgi?cam=${cam}&res=${resolution}&format=${format}&id=${Date.now()}`,
      base,
    ).toString();

    console.log(`[StreamManager][LIVE] Starting live stream: ${streamId}`);
    console.log(`[StreamManager][LIVE] Device Type: ${deviceType}`);
    console.log(`[StreamManager][LIVE] Format: ${format}`);
    console.log(`[StreamManager][LIVE] URL: ${url}`);

    const stream = await this._createLiveStream(
      streamId,
      url,
      "live",
      format,
      options,
    );

    this.totalStreamsCreated++;
    return stream;
  }

  /**
   * Internal: create a live stream from a NetVu device.
   * Handles both MJPEG and H.264 formats, over http or https.
   */
  async _createLiveStream(streamId, url, type, format, options = {}) {
    return new Promise((resolve, reject) => {
      try {
        const urlObj = new URL(url);
        const transport = transportFor(url);
        const extraOptions = url.startsWith("https://") ? httpsOptions : {};
        let isResolved = false;

        console.log(
          `[StreamManager][LIVE][${format.toUpperCase()}] Connecting to device...`,
        );

        const request = transport.request(
          url,
          {
            headers: {
              Accept: "*/*",
              Connection: "keep-alive",
              Host: urlObj.host,
            },
            timeout: 10000,
            ...extraOptions,
          },
          (response) => {
            console.log(
              `[StreamManager][LIVE][${format.toUpperCase()}] Response status: ${response.statusCode}`,
            );
            console.log(
              `[StreamManager][LIVE][${format.toUpperCase()}] Content-Type: ${response.headers["content-type"]}`,
            );

            if (response.statusCode !== 200) {
              let errorData = "";
              response.on("data", (chunk) => {
                errorData += chunk.toString();
              });
              response.on("end", () => {
                console.error(
                  `[StreamManager][LIVE][${format.toUpperCase()}] Error response: ${errorData}`,
                );
                if (!isResolved) {
                  isResolved = true;
                  reject(
                    new Error(
                      `Device returned status ${response.statusCode}: ${errorData}`,
                    ),
                  );
                }
              });
              return;
            }

            let contentType = response.headers["content-type"];
            if (format === "h264") {
              contentType = "video/mp4";
            } else if (format === "mjpeg") {
              contentType = contentType || "multipart/x-mixed-replace";
            }

            const streamInstance = {
              id: streamId,
              type,
              url,
              format,
              contentType,
              request,
              deviceStream: response,
              clients: new Set(),
              startTime: Date.now(),
              stats: { bytes: 0, clients: 0, startTime: Date.now() },
              firstDataReceived: false,
            };

            response.on("data", (chunk) => {
              if (!streamInstance.firstDataReceived) {
                streamInstance.firstDataReceived = true;
                console.log(
                  `[StreamManager][LIVE][${format.toUpperCase()}] ✅ First data chunk received (${chunk.length} bytes)`,
                );
                const hex = chunk.slice(0, 16).toString("hex");
                console.log(
                  `[StreamManager][LIVE][${format.toUpperCase()}] First bytes (hex): ${hex}`,
                );
                if (!isResolved) {
                  isResolved = true;
                  this.streams.set(streamId, streamInstance);
                  this.emit("stream-started", {
                    streamId,
                    type,
                    contentType: streamInstance.contentType,
                    format,
                  });
                  console.log(
                    `[StreamManager][LIVE][${format.toUpperCase()}] ✅ Stream ${streamId} created and ready`,
                  );
                  resolve(streamInstance);
                }
              }

              streamInstance.stats.bytes += chunk.length;

              streamInstance.clients.forEach((client) => {
                try {
                  if (!client.destroyed && !client.writableEnded) {
                    client.write(chunk);
                  }
                } catch (err) {
                  console.error(
                    `[StreamManager][LIVE][${format.toUpperCase()}] Client write error:`,
                    err.message,
                  );
                }
              });
            });

            response.on("end", () => {
              console.log(
                `[StreamManager][LIVE][${format.toUpperCase()}] Device stream ended for ${streamId}`,
              );
              console.log(
                `[StreamManager][LIVE][${format.toUpperCase()}] Stats: ${(streamInstance.stats.bytes / 1024 / 1024).toFixed(2)} MB transferred`,
              );
              this.stopStream(streamId);
            });

            response.on("error", (err) => {
              console.error(
                `[StreamManager][LIVE][${format.toUpperCase()}] Device stream error:`,
                err.message,
              );
              this._handleStreamError(streamId, err);
            });

            setTimeout(() => {
              if (!streamInstance.firstDataReceived && !isResolved) {
                isResolved = true;
                reject(new Error("Timeout waiting for first data from device"));
              }
            }, 10000);
          },
        );

        request.on("error", (err) => {
          console.error(
            `[StreamManager][LIVE][${format.toUpperCase()}] HTTP request error:`,
            err.message,
          );
          if (!isResolved) {
            isResolved = true;
            reject(err);
          }
        });

        request.on("timeout", () => {
          console.error(
            `[StreamManager][LIVE][${format.toUpperCase()}] Connection timeout`,
          );
          request.destroy();
          if (!isResolved) {
            isResolved = true;
            reject(new Error("Connection timeout"));
          }
        });

        request.end();
      } catch (err) {
        console.error(
          `[StreamManager][LIVE] Failed to create stream:`,
          err.message,
        );
        this.totalStreamsFailed++;
        reject(err);
      }
    });
  }

  /**
   * Start a replay stream from a NetVu device.
   *
   * URL parameters:
   *  - fields=0    continuous stream until client disconnects (not a fixed burst)
   *  - speed=N     positive = fast-forward, negative = rewind, 1 = real-time
   *  - realtime=1  INTENTIONALLY OMITTED — it throttles frame delivery to match
   *                original recording pace, which causes the device to stall on
   *                sparse recordings and triggers the watchdog before any frames
   *                arrive. Without it the device pushes frames as fast as it can,
   *                which is what we want for both normal and variable-speed replay.
   */
  async startReplayStream(deviceIp, cam = 1, timestamp, options = {}) {
    const streamId = `replay_${deviceIp}_${cam}_${timestamp}_${Date.now()}`;

    if (this.streams.size >= this.maxStreams) {
      throw new Error(`Maximum streams limit reached (${this.maxStreams})`);
    }

    const speed = options.speed ?? 1;

    let base = deviceIp;
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(base)) base = `http://${base}`;
    const url = new URL(
      `/replay_pic.cgi?cam=${cam}&control=PLAY&time=${timestamp}&format=jpeg&fields=0&speed=${speed}&id=${Date.now()}`,
      base,
    ).toString();

    console.log(`[StreamManager][REPLAY] Starting replay stream: ${streamId}`);
    console.log(`[StreamManager][REPLAY] URL: ${url}`);
    console.log(
      `[StreamManager][REPLAY] Timestamp: ${new Date(timestamp * 1000).toISOString()}`,
    );
    console.log(`[StreamManager][REPLAY] Speed: ${speed}x`);
    console.log(`[StreamManager][REPLAY] Mode: PROXIED with MJPEG conversion`);

    const stream = await this._createReplayStream(streamId, url, "replay", options);

    this.totalStreamsCreated++;
    return stream;
  }

  /**
   * Internal: create a browser-compatible replay MJPEG stream, over http or https.
   *
   * Design:
   *  - Promise resolves only after the first complete JPEG frame is parsed.
   *  - Promise rejects with a clear "No recording found" message if the device
   *    closes the connection before sending a single frame.
   *  - A 20s watchdog rejects if the device hangs without sending or closing.
   *  - isResolved flag prevents double-resolve/double-reject in all race conditions.
   */
  async _createReplayStream(streamId, url, type, options = {}) {
    return new Promise((resolve, reject) => {
      try {
        const urlObj = new URL(url);
        const transport = transportFor(url);
        const extraOptions = url.startsWith("https://") ? httpsOptions : {};
        let isResolved = false;

        const watchdog = setTimeout(() => {
          if (!isResolved) {
            isResolved = true;
            console.error(
              `[StreamManager][REPLAY] Watchdog fired — no frames within 20s`,
            );
            request.destroy();
            reject(
              new Error(
                "No recording found: device did not send any frames within 20s. " +
                "The requested timestamp may fall in a gap between recorded segments.",
              ),
            );
          }
        }, 20000);

        const request = transport.get(
          url,
          {
            headers: {
              Accept: "*/*",
              Connection: "keep-alive",
              Host: urlObj.host,
            },
            timeout: 20000,
            ...extraOptions,
          },
          (response) => {
            console.log(
              `[StreamManager][REPLAY] Response status: ${response.statusCode}`,
            );
            console.log(
              `[StreamManager][REPLAY] Content-Type: ${response.headers["content-type"]}`,
            );

            if (response.statusCode !== 200) {
              let errorData = "";
              response.on("data", (chunk) => {
                errorData += chunk.toString();
              });
              response.on("end", () => {
                clearTimeout(watchdog);
                if (!isResolved) {
                  isResolved = true;
                  reject(
                    new Error(
                      `Device returned status ${response.statusCode}: ${errorData}`,
                    ),
                  );
                }
              });
              return;
            }

            const streamInstance = {
              id: streamId,
              type,
              url,
              contentType: "multipart/x-mixed-replace; boundary=frame",
              request,
              deviceStream: response,
              clients: new Set(),
              startTime: Date.now(),
              stats: { bytes: 0, frames: 0, clients: 0, startTime: Date.now() },
              buffer: Buffer.alloc(0),
            };

            response.on("data", (chunk) => {
              streamInstance.buffer = Buffer.concat([
                streamInstance.buffer,
                chunk,
              ]);

              // Parse complete JPEG frames from the buffer.
              // SOI = 0xFF 0xD8, EOI = 0xFF 0xD9
              let start = streamInstance.buffer.indexOf(
                Buffer.from([0xff, 0xd8]),
              );
              let end = streamInstance.buffer.indexOf(
                Buffer.from([0xff, 0xd9]),
                start + 2,
              );

              while (start !== -1 && end !== -1) {
                const frame = streamInstance.buffer.slice(start, end + 2);

                if (!isResolved) {
                  isResolved = true;
                  clearTimeout(watchdog);
                  this.streams.set(streamId, streamInstance);
                  this.emit("stream-started", {
                    streamId,
                    type,
                    contentType: streamInstance.contentType,
                  });
                  console.log(
                    `[StreamManager][REPLAY] ✅ First frame received (${frame.length} bytes), stream ${streamId} ready`,
                  );
                  resolve(streamInstance);
                }

                streamInstance.clients.forEach((client) => {
                  try {
                    if (!client.destroyed && !client.writableEnded) {
                      client.write(`--frame\r\n`);
                      client.write(`Content-Type: image/jpeg\r\n`);
                      client.write(`Content-Length: ${frame.length}\r\n`);
                      client.write(`\r\n`);
                      client.write(frame);
                      client.write(`\r\n`);
                    }
                  } catch (err) {
                    // Individual client write errors are non-fatal
                  }
                });

                streamInstance.stats.bytes += frame.length;
                streamInstance.stats.frames++;

                streamInstance.buffer = streamInstance.buffer.slice(end + 2);
                start = streamInstance.buffer.indexOf(
                  Buffer.from([0xff, 0xd8]),
                );
                end = streamInstance.buffer.indexOf(
                  Buffer.from([0xff, 0xd9]),
                  start + 2,
                );
              }
            });

            response.on("end", () => {
              console.log(
                `[StreamManager][REPLAY] Device stream ended for ${streamId}`,
              );
              console.log(
                `[StreamManager][REPLAY] Stats: ${streamInstance.stats.frames} frames, ${(streamInstance.stats.bytes / 1024 / 1024).toFixed(2)} MB`,
              );

              if (!isResolved) {
                isResolved = true;
                clearTimeout(watchdog);
                reject(
                  new Error(
                    "No recording found at the requested timestamp",
                  ),
                );
              } else {
                this.stopStream(streamId);
              }
            });

            response.on("error", (err) => {
              console.error(
                `[StreamManager][REPLAY] Device stream error:`,
                err.message,
              );
              clearTimeout(watchdog);
              if (!isResolved) {
                isResolved = true;
                reject(err);
              } else {
                this._handleStreamError(streamId, err);
              }
            });
          },
        );

        request.on("error", (err) => {
          console.error(
            `[StreamManager][REPLAY] HTTP request error: ${err.message}`,
          );
          clearTimeout(watchdog);
          if (!isResolved) {
            isResolved = true;
            reject(err);
          }
        });

        request.on("timeout", () => {
          console.error(`[StreamManager][REPLAY] Socket timeout — destroying connection`);
          request.destroy();
          // Watchdog handles the reject — don't double-reject here
        });
      } catch (err) {
        console.error(
          `[StreamManager][REPLAY] Failed to create stream:`,
          err.message,
        );
        this.totalStreamsFailed++;
        reject(err);
      }
    });
  }

  addClient(streamId, clientStream) {
    const stream = this.streams.get(streamId);
    if (!stream) {
      console.error(`[StreamManager] Stream ${streamId} not found`);
      return false;
    }

    stream.clients.add(clientStream);
    stream.stats.clients = stream.clients.size;

    const streamTypeLabel = stream.type.toUpperCase();
    console.log(
      `[StreamManager][${streamTypeLabel}] Client connected to ${streamId} (${stream.clients.size} total)`,
    );

    clientStream.on("close", () => {
      console.log(
        `[StreamManager][${streamTypeLabel}] Client disconnected from ${streamId}`,
      );
      stream.clients.delete(clientStream);
      stream.stats.clients = stream.clients.size;

      if (stream.clients.size === 0) {
        console.log(
          `[StreamManager][${streamTypeLabel}] No clients left, stopping stream ${streamId}`,
        );
        this.stopStream(streamId);
      }
    });

    clientStream.on("error", (err) => {
      if (err.code !== "EPIPE" && err.code !== "ECONNRESET") {
        console.error(
          `[StreamManager][${streamTypeLabel}] Client error:`,
          err.message,
        );
      }
      stream.clients.delete(clientStream);
      stream.stats.clients = stream.clients.size;
    });

    return true;
  }

  stopStream(streamId) {
    const stream = this.streams.get(streamId);

    if (!stream) {
      return false;
    }

    const streamTypeLabel = stream.type.toUpperCase();
    console.log(
      `[StreamManager][${streamTypeLabel}] Stopping stream: ${streamId}`,
    );

    try {
      if (stream.request) stream.request.destroy();
      if (stream.deviceStream) stream.deviceStream.destroy();

      stream.clients.forEach((client) => {
        if (!client.destroyed) {
          try {
            client.end();
          } catch (err) {
            // Ignore
          }
        }
      });

      if (stream.buffer) {
        stream.buffer = null;
      }

      this.streams.delete(streamId);

      const duration = Date.now() - stream.startTime;
      const frames = stream.stats.frames || "N/A";
      console.log(
        `[StreamManager][${streamTypeLabel}] Stream stopped: ${streamId}`,
      );
      console.log(
        `[StreamManager][${streamTypeLabel}] Duration: ${(duration / 1000).toFixed(1)}s, Frames: ${frames}, Bytes: ${(stream.stats.bytes / 1024 / 1024).toFixed(2)} MB`,
      );

      this.emit("stream-stopped", {
        streamId,
        duration,
        stats: stream.stats,
      });

      return true;
    } catch (err) {
      console.error(
        `[StreamManager][${streamTypeLabel}] Error stopping stream:`,
        err.message,
      );
      return false;
    }
  }

  _handleStreamError(streamId, error) {
    const stream = this.streams.get(streamId);
    const streamTypeLabel = stream ? stream.type.toUpperCase() : "UNKNOWN";
    console.error(
      `[StreamManager][${streamTypeLabel}] Error in stream ${streamId}:`,
      error.message,
    );
    this.emit("stream-error", { streamId, error });
    this.stopStream(streamId);
  }

  getStream(streamId) {
    return this.streams.get(streamId);
  }

  getActiveStreams() {
    return Array.from(this.streams.values()).map((s) => ({
      id: s.id,
      type: s.type,
      format: s.format,
      contentType: s.contentType,
      clients: s.clients.size,
      uptime: Date.now() - s.startTime,
      stats: s.stats,
    }));
  }

  getStats() {
    return {
      activeStreams: this.streams.size,
      maxStreams: this.maxStreams,
      totalCreated: this.totalStreamsCreated,
      totalFailed: this.totalStreamsFailed,
      availableSlots: this.maxStreams - this.streams.size,
    };
  }

  cleanup() {
    console.log(`[StreamManager] Cleaning up ${this.streams.size} streams...`);
    const streamIds = Array.from(this.streams.keys());
    streamIds.forEach((id) => this.stopStream(id));
    console.log("[StreamManager] Cleanup complete");
  }
}

export default StreamManager;