/**
 * test-par-inspector.js - In-memory PAR file inspector
 * 
 * Usage: node test-par-inspector.js
 * 
 * This script will:
 * 1. Connect to your device
 * 2. List PAR files
 * 3. Fetch PAR content into memory
 * 4. Analyze headers and look for VAR references
 * 5. Show a report
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';

// ============================================================================
// CONFIGURATION - Edit these values for your device
// ============================================================================

const CONFIG = {
  deviceIp: '192.168.1.75',
  username: null,
  password: null,
  camera: 1,
  hoursBack: 1,
};

// ============================================================================
// Helper Functions
// ============================================================================

function buildUrl(path) {
  if (CONFIG.username && CONFIG.password) {
    return `http://${CONFIG.username}:${CONFIG.password}@${CONFIG.deviceIp}${path}`;
  }
  return `http://${CONFIG.deviceIp}${path}`;
}

function httpGetBuffer(url) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const client = urlObj.protocol === 'https:' ? https : http;

    const req = client.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return httpGetBuffer(res.headers.location).then(resolve).catch(reject);
      }

      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
      }

      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

function httpGetText(url) {
  return httpGetBuffer(url).then(buf => buf.toString());
}

function analyzeHeader(buffer) {
  const header = buffer.slice(0, Math.min(512, buffer.length));
  const hex = header.toString('hex');

  let format = 'Unknown/Proprietary';
  const magicBytes = hex.slice(0, 16);

  if (hex.includes('667479706d70') || hex.includes('66747970')) format = 'MP4/fMP4 (MPEG-4)';
  else if (hex.startsWith('000001')) format = 'Raw H.264 NAL stream';
  else if (hex.includes('6d6f6f76')) format = 'MP4 (moov atom found)';
  else if (hex.includes('6d646174')) format = 'MP4 (mdat atom found)';
  else if (header.toString('ascii', 0, 4) === 'RIFF') format = 'AVI (RIFF container)';
  else if (hex.startsWith('1a45dfa3')) format = 'Matroska/WebM (MKV)';
  else if (header.toString('utf8', 0, 5) === '<?xml') format = 'XML/ADH (NetVu proprietary)';

  return { format, magicBytes, header };
}

function findVARReferences(buffer) {
  const text = buffer.toString('utf8');
  const regex = /\\?[\w\\\/-]+\.VAR/gi;
  const matches = text.match(regex);
  return matches || [];
}

function formatHexDisplay(buffer, length = 128) {
  const hex = buffer.slice(0, Math.min(length, buffer.length)).toString('hex');
  const lines = [];
  for (let i = 0; i < hex.length; i += 32) {
    const offset = (i / 2).toString(16).padStart(8, '0');
    const hexPart = hex.slice(i, i + 32).match(/.{1,2}/g).join(' ');
    lines.push(`   ${offset}  ${hexPart}`);
  }
  return lines.join('\n');
}

// ============================================================================
// Main Function
// ============================================================================

async function inspectPARFiles() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  In-Memory PAR Inspector');
  console.log('═══════════════════════════════════════════════════════════\n');

  console.log('📋 Configuration:');
  console.log(`   Device IP: ${CONFIG.deviceIp}`);
  console.log(`   Camera: ${CONFIG.camera}`);
  console.log(`   Authentication: ${CONFIG.username ? 'Yes' : 'No'}`);
  console.log(`   Search period: Last ${CONFIG.hoursBack} hour(s)\n`);

  // Step 1: Test connection
  try {
    await httpGetText(buildUrl('/'));
    console.log('✅ Device reachable\n');
  } catch (err) {
    console.error('❌ Cannot connect to device:', err.message);
    process.exit(1);
  }

  // Step 2: Get list of PAR files
  const now = Math.floor(Date.now() / 1000);
  const startTime = now - (CONFIG.hoursBack * 3600);
  const range = CONFIG.hoursBack * 3600;

  const vpartsUrl = buildUrl(
    `/vparts.cgi?format=csv&listlength=10&pathstyle=long&time=${startTime}&range=${range}&domain=0&cam=${CONFIG.camera}`
  );

  let vpartsData;
  try {
    vpartsData = await httpGetText(vpartsUrl);
  } catch (err) {
    console.error('❌ Failed to fetch PAR list:', err.message);
    process.exit(1);
  }

  const lines = vpartsData.split('\n').filter(l => l.trim());
  console.log(`✅ Found ${lines.length} recording(s)\n`);

  // Step 3: Inspect each PAR file
  for (const line of lines) {
    const parts = line.split(',').map(p => p.trim());
    const parPath = parts[3];
    const urlPath = parPath.replace(/\\/g, '/');

    console.log('──────────────────────────────────────────');
    console.log(`📹 PAR File: ${parPath}`);

    let buffer;
    try {
      buffer = await httpGetBuffer(buildUrl(urlPath));
      console.log(`   File size: ${(buffer.length / 1024 / 1024).toFixed(2)} MB`);
    } catch (err) {
      console.error('   ❌ Failed to fetch PAR content:', err.message);
      continue;
    }

    // Analyze header
    const headerAnalysis = analyzeHeader(buffer);
    console.log(`   Format: ${headerAnalysis.format}`);
    console.log(`   Magic Bytes: ${headerAnalysis.magicBytes}`);
    console.log('\n   Header (first 128 bytes):');
    console.log(formatHexDisplay(buffer));

    // Find VAR references
    const varFiles = findVARReferences(buffer);
    if (varFiles.length) {
      console.log('\n   Found VAR file references:');
      varFiles.forEach(v => console.log(`     • ${v}`));
    } else {
      console.log('\n   No VAR file references found.');
    }

    console.log('──────────────────────────────────────────\n');
  }

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Inspection Complete!');
  console.log('═══════════════════════════════════════════════════════════\n');
}

// Run
inspectPARFiles();
