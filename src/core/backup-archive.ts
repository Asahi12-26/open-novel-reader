import JSZip from 'jszip';
import { MAX_AVATAR_BYTES } from './avatar';
import { MAX_FILE_BYTES } from './parser';

const MANIFEST = 'manifest.json';
const maxManifestBytes = 128 * 1024 * 1024;
export const MAX_BACKUP_BYTES = 256 * 1024 * 1024;
const maxEntries = 20_000;

export type ArchiveAsset = { path: string; bytes: Blob };
export const originalEntry = (index: number) => `files/${index}.bin`;
export const portraitEntry = (index: number) => `avatars/${index}.png`;
export function invalidBackup(): never {
  throw new Error('备份格式损坏或版本暂不支持，现有数据未被修改。');
}

const entryLimit = (path: string) =>
  path === MANIFEST ? maxManifestBytes : /^files\/(?:0|[1-9]\d{0,5})\.bin$/.test(path) ? MAX_FILE_BYTES :
    /^avatars\/(?:0|[1-9]\d{0,5})\.png$/.test(path) ? MAX_AVATAR_BYTES : 0;

/** A deliberately small ZIP subset. Validate all positions before the ZIP reader touches entry bytes. */
function inspectStorageZip(bytes: ArrayBuffer): Set<string> {
  if (bytes.byteLength < 22 || bytes.byteLength > MAX_BACKUP_BYTES) invalidBackup();
  const view = new DataView(bytes);
  const end = bytes.byteLength - 22;
  const short = (at: number) => view.getUint16(at, true);
  const long = (at: number) => view.getUint32(at, true);
  const names = new Set<string>();
  const runs: { start: number; end: number }[] = [];
  const count = short(end + 10); const directory = long(end + 16);
  if (long(end) !== 0x06054b50 || short(end + 4) !== 0 || short(end + 6) !== 0 ||
      short(end + 8) !== count || !count || count > maxEntries || short(end + 20) !== 0 ||
      directory + long(end + 12) !== end) invalidBackup();
  const decode = (at: number, length: number) => new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes, at, length));
  let cursor = directory;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || long(cursor) !== 0x02014b50) invalidBackup();
    const nameLength = short(cursor + 28); const size = long(cursor + 24); const crc = long(cursor + 16);
    const start = long(cursor + 42);
    if (!nameLength || nameLength > 40 || cursor + 46 + nameLength > end || short(cursor + 8) !== 0 || short(cursor + 10) !== 0 ||
        long(cursor + 20) !== size || short(cursor + 30) !== 0 || short(cursor + 32) !== 0 || short(cursor + 34) !== 0 ||
        start + 30 + nameLength + size > directory || long(start) !== 0x04034b50 || short(start + 6) !== 0 ||
        short(start + 8) !== 0 || long(start + 14) !== crc || long(start + 18) !== size || long(start + 22) !== size ||
        short(start + 26) !== nameLength || short(start + 28) !== 0) invalidBackup();
    const path = decode(cursor + 46, nameLength);
    const limit = entryLimit(path);
    if (!limit || size > limit || names.has(path) || decode(start + 30, nameLength) !== path) invalidBackup();
    names.add(path);
    runs.push({ start, end: start + 30 + nameLength + size });
    cursor += 46 + nameLength;
  }
  let covered = 0;
  for (const run of runs.sort((left, right) => left.start - right.start)) {
    if (run.start !== covered) invalidBackup();
    covered = run.end;
  }
  if (covered !== directory || cursor !== end || !names.has(MANIFEST)) invalidBackup();
  return names;
}

export async function writeBackupArchive(manifest: unknown, assets: ArchiveAsset[]): Promise<Blob> {
  const data = new TextEncoder().encode(JSON.stringify(manifest));
  if (assets.length >= maxEntries || data.byteLength > maxManifestBytes ||
      assets.reduce((total, item) => total + item.bytes.size + 220, data.byteLength + 220) > MAX_BACKUP_BYTES ||
      assets.some(item => !entryLimit(item.path) || item.bytes.size > entryLimit(item.path))) {
    throw new Error('备份超过文件或 256 MiB 总容量限制。原书库已保留，请将原文件另存。');
  }
  const zip = new JSZip();
  zip.file(MANIFEST, data, { createFolders: false });
  for (const { path, bytes } of assets) zip.file(path, await bytes.arrayBuffer(), { createFolders: false });
  // Stored entries make the actual bytes equal their validated sizes. Compressed
  // entries from arbitrary archives are outside this portable backup format.
  return new Blob([await zip.generateAsync({ type: 'arraybuffer', compression: 'STORE', streamFiles: false })], { type: 'application/zip' });
}

export async function readBackupArchive(file: Blob) {
  if (file.size > MAX_BACKUP_BYTES) throw new Error('备份超过 256 MiB 安全上限，现有数据未被修改。');
  try {
    const bytes = await file.arrayBuffer();
    const names = inspectStorageZip(bytes);
    const archive = await JSZip.loadAsync(bytes, { checkCRC32: true, createFolders: false });
    const manifest: unknown = JSON.parse(await archive.file(MANIFEST)!.async('text'));
    names.delete(MANIFEST);
    return { manifest, names, async read(path: string, mime: string) {
      const asset = names.has(path) && archive.file(path);
      if (!asset) invalidBackup();
      return new Blob([await asset.async('arraybuffer')], { type: mime });
    } };
  } catch { return invalidBackup(); }
}
