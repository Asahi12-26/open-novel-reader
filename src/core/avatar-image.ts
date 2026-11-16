/** Untrusted uploads are inspected before they reach a browser image decoder. */
export const MAX_AVATAR_SOURCE_BYTES = 12 * 1024 * 1024;
export const AVATAR_SIZE = 256;
export const MAX_AVATAR_BYTES = 300 * 1024;
const MAX_DIMENSION = 8192;
const MAX_PIXELS = 25_000_000;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export interface AvatarCrop { x: number; y: number; size: number }
export interface PreparedAvatarImage {
  image: HTMLImageElement;
  width: number;
  height: number;
  dispose(): void;
}
interface Dimensions { width: number; height: number }
interface PngChunk { type: string; start: number; end: number }

const matches = (bytes: Uint8Array, offset: number, signature: number[]) =>
  signature.every((byte, index) => bytes[offset + index] === byte);
const tag = (bytes: Uint8Array, offset: number) =>
  String.fromCharCode(...bytes.subarray(offset, offset + 4));
const safeDimensions = ({ width, height }: Dimensions) =>
  width > 0 && height > 0 && width <= MAX_DIMENSION && height <= MAX_DIMENSION && width * height <= MAX_PIXELS;
const invalid = () => new Error('无法读取图片。请选择有效的静态 PNG、JPG 或 WebP 图片。');
const animated = () => new Error('请选择静态图片，头像不支持动画。');
const tooLarge = () => new Error('图片像素尺寸过大。请先将图片缩小后再试。');

function readPng(bytes: Uint8Array<ArrayBuffer>) {
  if (bytes.length < 45 || !matches(bytes, 0, PNG_SIGNATURE)) throw invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: PngChunk[] = [];
  let hasPixels = false;
  for (let start = PNG_SIGNATURE.length; start + 12 <= bytes.length;) {
    const length = view.getUint32(start);
    const type = tag(bytes, start + 4);
    const end = start + length + 12;
    if (end > bytes.length || chunks.length >= 4096) throw invalid();
    if (!chunks.length ? type !== 'IHDR' || length !== 13 : type === 'IHDR') throw invalid();
    if (['acTL', 'fcTL', 'fdAT'].includes(type)) throw animated();
    hasPixels ||= type === 'IDAT' && length > 0;
    chunks.push({ type, start, end });
    if (type === 'IEND') {
      if (length || end !== bytes.length || !hasPixels) throw invalid();
      return { width: view.getUint32(16), height: view.getUint32(20), chunks };
    }
    start = end;
  }
  throw invalid();
}

function readJpeg(bytes: Uint8Array<ArrayBuffer>): Dimensions {
  if (!matches(bytes, 0, [0xff, 0xd8]) || !matches(bytes, bytes.length - 2, [0xff, 0xd9])) throw invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let dimensions: Dimensions | undefined;
  for (let position = 2; position + 3 < bytes.length;) {
    if (bytes[position++] !== 0xff) throw invalid();
    while (bytes[position] === 0xff) position++;
    const marker = bytes[position++];
    if (marker === 0xda && dimensions) return dimensions;
    if (!marker || marker === 0xd9 || position + 2 > bytes.length) throw invalid();
    const length = view.getUint16(position);
    if (length < 2 || position + length > bytes.length) throw invalid();
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 8 || dimensions) throw invalid();
      dimensions = { height: view.getUint16(position + 3), width: view.getUint16(position + 5) };
    }
    position += length;
  }
  throw invalid();
}

function readWebP(bytes: Uint8Array<ArrayBuffer>): Dimensions {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 26 || view.getUint32(4, true) !== bytes.length - 8) throw invalid();
  let header: Dimensions | undefined;
  let frame: Dimensions | undefined;
  let start = 12;
  while (start + 8 <= bytes.length) {
    const type = tag(bytes, start);
    const size = view.getUint32(start + 4, true);
    const offset = start + 8;
    const end = offset + size + (size % 2);
    if (end > bytes.length) throw invalid();
    if (type === 'ANIM' || type === 'ANMF') throw animated();
    if (type === 'VP8X') {
      if (size !== 10 || header || start !== 12) throw invalid();
      if (bytes[offset] & 2) throw animated();
      header = {
        width: 1 + (view.getUint32(offset + 3, true) & 0xffffff),
        height: 1 + (bytes[offset + 7] | (bytes[offset + 8] << 8) | (bytes[offset + 9] << 16)),
      };
    }
    if (type === 'VP8 ' || type === 'VP8L') {
      if (frame) throw invalid();
      if (type === 'VP8 ') {
        if (size < 10 || (bytes[offset] & 1) || !matches(bytes, offset + 3, [0x9d, 0x01, 0x2a])) throw invalid();
        frame = { width: view.getUint16(offset + 6, true) & 0x3fff, height: view.getUint16(offset + 8, true) & 0x3fff };
      } else {
        if (size < 5 || bytes[offset] !== 0x2f) throw invalid();
        const bits = view.getUint32(offset + 1, true);
        frame = { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
      }
    }
    start = end;
  }
  if (!frame || start !== bytes.length || (header && (frame.width !== header.width || frame.height !== header.height))) throw invalid();
  return frame;
}

/** Check the actual container, regardless of filename or OS-supplied MIME. */
export async function inspectAvatarSource(source: Blob) {
  if (!source.size || source.size > MAX_AVATAR_SOURCE_BYTES) throw new Error('请选择不超过 12 MiB 的图片。');
  const bytes = new Uint8Array(await source.arrayBuffer());
  let type: string;
  let dimensions: Dimensions;
  if (matches(bytes, 0, PNG_SIGNATURE)) {
    type = 'image/png';
    const png = readPng(bytes);
    dimensions = { width: png.width, height: png.height };
  } else if (matches(bytes, 0, [0xff, 0xd8])) {
    type = 'image/jpeg'; dimensions = readJpeg(bytes);
  } else if (tag(bytes, 0) === 'RIFF' && tag(bytes, 8) === 'WEBP') {
    type = 'image/webp'; dimensions = readWebP(bytes);
  } else {
    throw invalid();
  }
  if (!safeDimensions(dimensions)) throw tooLarge();
  return { type, ...dimensions };
}

export async function prepareAvatarImage(source: Blob): Promise<PreparedAvatarImage> {
  const { type } = await inspectAvatarSource(source);
  const url = URL.createObjectURL(new Blob([source], { type }));
  const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(invalid());
      image.src = url;
    });
    const dimensions = { width: image.naturalWidth, height: image.naturalHeight };
    if (!safeDimensions(dimensions)) throw tooLarge();
    return { image, ...dimensions, dispose: () => URL.revokeObjectURL(url) };
  } catch (failure) {
    URL.revokeObjectURL(url);
    throw failure;
  } finally {
    image.onload = null;
    image.onerror = null;
  }
}

export async function cropAvatarImage(source: PreparedAvatarImage, { x, y, size }: AvatarCrop): Promise<Blob> {
  if (![x, y, size].every(Number.isFinite) || x < 0 || y < 0 || size < 1 || x + size > source.width + 0.001 || y + size > source.height + 0.001) {
    throw new Error('裁剪区域超出图片范围。请重新调整。');
  }
  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前阅读器无法编辑图片。');
  context.imageSmoothingQuality = 'high';
  context.drawImage(source.image, x, y, size, size, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
  const encoded = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('头像无法生成。')), 'image/png');
  });
  const bytes = new Uint8Array(await encoded.arrayBuffer());
  const { chunks } = readPng(bytes);
  // Keep only the canvas-generated raster. Discard optional metadata.
  return new Blob([bytes.subarray(0, 8), ...chunks.filter(chunk => ['IHDR', 'IDAT', 'IEND'].includes(chunk.type)).map(chunk => bytes.subarray(chunk.start, chunk.end))], { type: 'image/png' });
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function validCrc(bytes: Uint8Array<ArrayBuffer>, chunk: PngChunk) {
  let value = 0xffffffff;
  for (let i = chunk.start + 4; i < chunk.end - 4; i++) value = crcTable[(value ^ bytes[i]) & 255] ^ (value >>> 8);
  return ((value ^ 0xffffffff) >>> 0) === new DataView(bytes.buffer, bytes.byteOffset).getUint32(chunk.end - 4);
}

/** Accept only metadata-free 8-bit canvas rasters from backups and cloud storage. */
export async function validateAvatarImage(blob: Blob): Promise<string> {
  if (!blob.size || blob.size > MAX_AVATAR_BYTES || blob.type !== 'image/png') throw invalid();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const { width, height, chunks } = readPng(bytes);
  const channels = bytes[25] === 6 ? 4 : bytes[25] === 2 ? 3 : 0;
  if (width !== AVATAR_SIZE || height !== AVATAR_SIZE || !channels || bytes[24] !== 8 ||
      bytes[26] || bytes[27] || bytes[28] || chunks.slice(1, -1).some(chunk => chunk.type !== 'IDAT') ||
      chunks.some(chunk => !validCrc(bytes, chunk))) throw invalid();
  const compressed = chunks.slice(1, -1).map(chunk => bytes.subarray(chunk.start + 8, chunk.end - 4));
  const pixels = new Blob(compressed).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  const stride = 1 + width * channels;
  const expected = stride * height;
  let count = 0;
  try {
    for (;;) {
      const { value, done } = await pixels.read();
      if (done) break;
      if (count + value.length > expected) throw invalid();
      for (let row = (stride - count % stride) % stride; row < value.length; row += stride) {
        if (value[row] > 4) throw invalid();
      }
      count += value.length;
    }
    if (count !== expected) throw invalid();
  } catch {
    await pixels.cancel().catch(() => undefined);
    throw invalid();
  } finally {
    pixels.releaseLock();
  }
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), number => number.toString(16).padStart(2, '0')).join('');
}
