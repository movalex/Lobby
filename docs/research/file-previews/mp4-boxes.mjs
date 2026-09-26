// Top-level ISO-BMFF box scan (reads 16-byte headers only; never decodes media).
//   node mp4-boxes.mjs fixtures/video.mp4 fixtures/truncated.mp4
// - faststart: 'moov' precedes 'mdat' (progressive playback without fetching the file tail)
// - truncated: a top-level box claims bytes past EOF (catches the "first 30% of bytes" fixture that
//   ffprobe and poster extraction both accept)
import { open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function scanTopLevelBoxes(file, maxBoxes = 64) {
  const fh = await open(file, 'r');
  try {
    const { size: fileSize } = await fh.stat();
    const boxes = [];
    let pos = 0;
    const hdr = Buffer.alloc(16);
    while (pos + 8 <= fileSize && boxes.length < maxBoxes) {
      await fh.read(hdr, 0, 16, pos);
      let size = hdr.readUInt32BE(0);
      const type = hdr.toString('latin1', 4, 8);
      if (size === 1) size = Number(hdr.readBigUInt64BE(8)); // 64-bit largesize
      else if (size === 0) size = fileSize - pos; // box runs to EOF
      if (size < 8) throw new Error(`corrupt box at offset ${pos}`);
      boxes.push({ type, pos, size });
      pos += size;
    }
    const moov = boxes.findIndex((b) => b.type === 'moov');
    const mdat = boxes.findIndex((b) => b.type === 'mdat');
    return {
      fileSize,
      boxes,
      faststart: moov !== -1 && (mdat === -1 || moov < mdat),
      truncated: boxes.some((b) => b.pos + b.size > fileSize),
    };
  } finally {
    await fh.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const f of process.argv.slice(2)) {
    const r = await scanTopLevelBoxes(f);
    console.log(f, r.boxes.map((b) => b.type).join(','), `faststart=${r.faststart}`, `truncated=${r.truncated}`);
  }
}
