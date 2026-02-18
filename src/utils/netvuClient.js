/**
 * NetVu HTTP Client
 * 
 * Handles HTTP requests to NetVu devices with proper timeout handling.
 * NetVu devices often don't properly close HTTP connections, so we use
 * silence detection (no data received for X ms) to know when response is complete.
 *
 * Supports both http:// and https:// — VPN tunnel URLs are HTTPS.
 */

import http from 'http';
import https from 'https';

/**
 * Make an HTTP/HTTPS GET request to a NetVu device.
 * 
 * @param {string} url - Full URL to request (http:// or https://)
 * @param {number} silenceTimeout - MS of silence before considering response complete (default 500ms)
 * @param {number} maxTimeout - Maximum time to wait for any response (default 10000ms)
 * @returns {Promise<{status: number, headers: object, data: string}>}
 */
export function netVuHttpGet(url, silenceTimeout = 500, maxTimeout = 10000) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    let chunks = [];
    let totalBytes = 0;
    let silenceTimer = null;
    let maxTimer = null;
    let resolved = false;

    // Select transport based on protocol — VPN tunnel URLs are https://
    const isHttps = url.startsWith('https://');
    const transport = isHttps ? https : http;

    // For HTTPS: disable cert validation for internal/VPN tunnel devices whose
    // certs won't verify against public CAs. Remove once certs are valid.
    const requestOptions = isHttps
      ? { rejectUnauthorized: false }
      : {};

    const completeRequest = (req, res) => {
      if (resolved) return;
      resolved = true;

      if (silenceTimer) clearTimeout(silenceTimer);
      if (maxTimer) clearTimeout(maxTimer);

      req.destroy();
      
      const data = Buffer.concat(chunks).toString('utf8');
      
      console.log(`[NetVuClient] Request complete: ${url}`);
      console.log(`[NetVuClient] Total time: ${Date.now() - startTime}ms`);
      console.log(`[NetVuClient] Total bytes: ${totalBytes}`);
      
      resolve({
        status: res.statusCode,
        headers: res.headers,
        data: data
      });
    };

    console.log(`[NetVuClient] GET ${url}`);
    console.log(`[NetVuClient] Silence timeout: ${silenceTimeout}ms, Max timeout: ${maxTimeout}ms`);

    const req = transport.get(url, requestOptions, (res) => {
      console.log(`[NetVuClient] Connected - Status: ${res.statusCode}`);
      console.log(`[NetVuClient] Content-Type: ${res.headers['content-type']}`);

      if (res.statusCode !== 200) {
        let errorData = '';
        res.on('data', chunk => { errorData += chunk.toString(); });
        res.on('end', () => {
          if (!resolved) {
            resolved = true;
            if (silenceTimer) clearTimeout(silenceTimer);
            if (maxTimer) clearTimeout(maxTimer);
            reject(new Error(`HTTP ${res.statusCode}: ${errorData}`));
          }
        });
        return;
      }

      maxTimer = setTimeout(() => {
        if (!resolved) {
          console.warn(`[NetVuClient] Maximum timeout reached (${maxTimeout}ms)`);
          completeRequest(req, res);
        }
      }, maxTimeout);

      res.on('data', (chunk) => {
        chunks.push(chunk);
        totalBytes += chunk.length;

        if (silenceTimer) clearTimeout(silenceTimer);
        
        silenceTimer = setTimeout(() => {
          console.log(`[NetVuClient] Silence detected (${silenceTimeout}ms), completing request`);
          completeRequest(req, res);
        }, silenceTimeout);
      });

      res.on('end', () => {
        console.log(`[NetVuClient] Response stream ended normally`);
        if (!resolved) {
          completeRequest(req, res);
        }
      });

      res.on('error', (err) => {
        if (!resolved) {
          resolved = true;
          if (silenceTimer) clearTimeout(silenceTimer);
          if (maxTimer) clearTimeout(maxTimer);
          console.error(`[NetVuClient] Response error:`, err.message);
          reject(err);
        }
      });
    });

    req.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        if (silenceTimer) clearTimeout(silenceTimer);
        if (maxTimer) clearTimeout(maxTimer);
        console.error(`[NetVuClient] Request error:`, err.message);
        reject(err);
      }
    });

    req.on('timeout', () => {
      if (!resolved) {
        resolved = true;
        if (silenceTimer) clearTimeout(silenceTimer);
        if (maxTimer) clearTimeout(maxTimer);
        req.destroy();
        console.error(`[NetVuClient] Request timeout`);
        reject(new Error('Request timeout'));
      }
    });
  });
}

export default { netVuHttpGet };