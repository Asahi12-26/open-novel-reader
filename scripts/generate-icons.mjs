// Deterministic original icon: a cream open book on evergreen. No external assets.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function crc32(buf) {
  let crc = 0xffffffff;
  for (const b of buf) { crc ^= b; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const tag = Buffer.from(type); const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([tag, data])));
  return Buffer.concat([size, tag, data, crc]);
}
function polygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i], [xj, yj] = points[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function png(size) {
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = (x + .5) / size, v = (y + .5) / size;
    let color = [30, 65, 56, 255];
    if (polygon(u, v, [[.20,.30],[.42,.26],[.49,.31],[.49,.72],[.42,.67],[.20,.71]]) ||
      polygon(u, v, [[.51,.31],[.58,.26],[.80,.30],[.80,.71],[.58,.67],[.51,.72]])) color = [241, 231, 204, 255];
    for (const line of [.40,.48,.56]) {
      if (u > .25 && u < .43 && Math.abs(v - (line - (u-.25)*.14)) < .005) color = [130, 146, 118, 255];
      if (u > .57 && u < .75 && Math.abs(v - (line + (u-.57)*.14)) < .005) color = [130, 146, 118, 255];
    }
    if (Math.abs(u-.71)+Math.abs(v-.19)<.031) color = [198, 161, 100, 255];
    const offset = y * (size * 4 + 1) + 1 + x * 4;
    rows.set(color, offset);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8]=8; header[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT',deflateSync(rows)), chunk('IEND',Buffer.alloc(0))]);
}
mkdirSync(resolve(root,'public'), {recursive:true}); mkdirSync(resolve(root,'src-tauri/icons'), {recursive:true});
for (const [size,name] of [[192,'public/icon-192.png'],[512,'public/icon-512.png'],[32,'src-tauri/icons/32x32.png'],[128,'src-tauri/icons/128x128.png'],[256,'src-tauri/icons/128x128@2x.png'],[512,'src-tauri/icons/icon.png']]) writeFileSync(resolve(root,name),png(size));
const image = png(256); const ico = Buffer.alloc(22); ico.writeUInt16LE(1,2); ico.writeUInt16LE(1,4); ico[8]=0; ico.writeUInt16LE(1,10); ico.writeUInt16LE(32,12); ico.writeUInt32LE(image.length,14); ico.writeUInt32LE(22,18);
writeFileSync(resolve(root,'src-tauri/icons/icon.ico'),Buffer.concat([ico,image]));
console.log('Generated original PWA and Tauri icons.');
