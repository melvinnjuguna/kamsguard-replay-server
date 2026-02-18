import fs from "fs";

const inputFile = "Multidetector_cam1_2026-02-16T05-30-39.par";
const outputFile = "cleaned_stream.h264";

console.log(`🚀 Starting extraction from: ${inputFile}`);

// Read the entire PAR file into memory
const buffer = fs.readFileSync(inputFile);
const outputStream = fs.createWriteStream(outputFile);

let startOffset = -1;
let segmentsFound = 0;

// Scan the buffer for H.264 Start Codes: 00 00 00 01 or 00 00 01
for (let i = 0; i < buffer.length - 3; i++) {
  // Check for 4-byte (00 00 00 01) or 3-byte (00 00 01) start codes
  const isFourByte = buffer[i] === 0 && buffer[i+1] === 0 && buffer[i+2] === 0 && buffer[i+3] === 1;
  const isThreeByte = buffer[i] === 0 && buffer[i+1] === 0 && buffer[i+2] === 1;

  if (isFourByte || isThreeByte) {
    // If we already found a previous start code, write the data between them
    if (startOffset !== -1) {
      outputStream.write(buffer.subarray(startOffset, i));
      segmentsFound++;
    }
    startOffset = i;
    // Skip ahead if it was a 4-byte code to avoid double-counting
    if (isFourByte) i += 3; 
  }
}

// Write the final chunk
if (startOffset !== -1) {
  outputStream.write(buffer.subarray(startOffset));
}

outputStream.on('finish', () => {
  console.log(`✅ Extraction complete!`);
  console.log(`📦 Saved ${segmentsFound} video segments to ${outputFile}`);
  console.log(`👉 Now run: ffmpeg -r 25 -i ${outputFile} -c copy final_output.mp4`);
});

outputStream.end();
