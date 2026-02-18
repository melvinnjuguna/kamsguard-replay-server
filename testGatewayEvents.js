import { netVuHttpGet } from './netvuClient.js';

const NVR_IP = '192.168.1.50';
const FV3_IP = '192.168.1.80';

console.log('Testing Gateway Events\n');

// Test NVR
console.log('=== NVR Events ===');
const nvrResponse = await netVuHttpGet(
  `http://${NVR_IP}/events.cgi?format=csv&time=0&listlength=-30`,
  500,
  10000
);

const nvrLines = nvrResponse.data.split('\n').filter(l => l.trim());
console.log(`Total lines: ${nvrLines.length}`);
console.log('\nFirst 3 events:');
nvrLines.slice(0, 3).forEach(line => {
  const parts = line.split(',');
  console.log(`  ID=${parts[0]}, Cam=${parts[1]}, Type=${parts[2]}`);
});

console.log('\n=== FV3 Events ===');
const fv3Response = await netVuHttpGet(
  `http://${FV3_IP}/events.cgi?format=csv&time=0&listlength=-30`,
  500,
  10000
);

const fv3Lines = fv3Response.data.split('\n').filter(l => l.trim());
console.log(`Total lines: ${fv3Lines.length}`);
console.log('\nFirst 3 events:');
fv3Lines.slice(0, 3).forEach(line => {
  const parts = line.split(',');
  console.log(`  ID=${parts[0]}, Cam=${parts[1]}, Type=${parts[2]}`);
});