/**
 * Test NetVu HTTP Client
 *
 * Quick test to verify the silence detection works
 */

import { netVuHttpGet } from "./src/utils/netvuClient.js";

const DEVICE_IP = "192.168.1.50";

console.log("Testing NetVu HTTP Client");
console.log("=========================\n");

// Test 1: Camera List
console.log("Test 1: Camera List");
console.log("-------------------");
try {
  const response = await netVuHttpGet(
    `http://${DEVICE_IP}/camlist.cgi`,
    500,
    10000,
  );
  console.log("✅ Success!");
  console.log(`Status: ${response.status}`);
  console.log(`Data length: ${response.data.length} bytes`);
  console.log(`Preview: ${response.data.substring(0, 100)}...`);

  // Try parsing as JSON
  try {
    const json = JSON.parse(response.data);
    console.log(`✅ Valid JSON with ${json.cameras?.length || 0} cameras`);
  } catch (e) {
    console.log("⚠ Not valid JSON");
  }
} catch (err) {
  console.log("❌ Failed:", err.message);
}

console.log("\n");

// Test 2: Events
console.log("Test 2: Events List");
console.log("-------------------");
try {
  const response = await netVuHttpGet(
    `http://${DEVICE_IP}/events.cgi?format=csv&time=0&listlength=-30`,
    500,
    10000,
  );
  console.log("✅ Success!");
  console.log(`Status: ${response.status}`);
  console.log(`Data length: ${response.data.length} bytes`);

  const lines = response.data.split("\n").filter((l) => l.trim());
  console.log(`✅ Parsed ${lines.length} event lines`);
  console.log(`Preview: ${response.data.substring(0, 200)}...`);
} catch (err) {
  console.log("❌ Failed:", err.message);
}

console.log("\n=========================");
console.log("Test Complete!");
