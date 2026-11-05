import { readFileSync, readdirSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
if (process.env.RELEASE_TAG !== `v${version}`) throw new Error('Release tag must match package.json version.');
const input = join(root, 'release-artifacts');
const output = join(root, 'release-upload');
const binaries = readdirSync(input, { recursive: true }).filter(file => /\.(exe|apk)$/.test(file));
if (binaries.some(file => /unsigned|candidate/i.test(file))) throw new Error('Unsigned compile candidates cannot be included in release assets.');
const windows = binaries.filter(file => file.endsWith('.exe'));
const android = binaries.filter(file => file.endsWith('.apk'));
if (windows.length !== 1 || android.length !== 1) throw new Error('Expected exactly one Windows installer and one Android APK.');
mkdirSync(output, { recursive: true });
const files = [
  [join(input, windows[0]), `Open-Novel-Reader_${version}_windows-x64-setup.exe`],
  [join(input, android[0]), `Open-Novel-Reader_${version}_android-arm64.apk`],
  [join(input, 'THIRD_PARTY_LICENSES.zip'), 'THIRD_PARTY_LICENSES.zip'],
];
const checksums = [];
for (const [source, name] of files) {
  // ASCII names remain identical after GitHub's asset-name normalization.
  copyFileSync(source, join(output, name));
  checksums.push(`${createHash('sha256').update(readFileSync(source)).digest('hex')}  ${name}`);
}
writeFileSync(join(output, 'SHA256SUMS.txt'), `${checksums.join('\n')}\n`);
console.log(`Prepared ${files.length} release assets and SHA256SUMS.txt with matching download names.`);
