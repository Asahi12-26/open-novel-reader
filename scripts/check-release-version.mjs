import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const json = name => JSON.parse(readFileSync(join(root, name), 'utf8'));
const manifest = json('package.json');
const lock = json('package-lock.json');
const tauri = json('src-tauri/tauri.conf.json');
const cargo = readFileSync(join(root, 'src-tauri/Cargo.toml'), 'utf8').match(/^\[package\]\s*\n[\s\S]*?^version = "([^"]+)"/m)?.[1];
const cargoLock = readFileSync(join(root, 'src-tauri/Cargo.lock'), 'utf8').match(/^\[\[package\]\]\s*\nname = "open-novel-reader"\s*\nversion = "([^"]+)"/m)?.[1];
const versions = [manifest.version, lock.version, lock.packages?.['']?.version, tauri.version, cargo, cargoLock];
if (!versions.every(value => value === manifest.version)) throw new Error('package, npm lock, Tauri, Cargo and Cargo lock release versions must match.');
if (tauri.identifier !== 'io.github.opennovelreader.app') throw new Error('Changing the released application id breaks upgrades.');
// Advance this baseline when preparing a new release after the current Beta.
const lastPublishedAndroidCode = 4001; // v0.4.0-beta.1, signed with the persistent release key.
if (!Number.isInteger(tauri.bundle.android.versionCode) || tauri.bundle.android.versionCode <= lastPublishedAndroidCode) throw new Error(`Android release versionCode must exceed the last published code ${lastPublishedAndroidCode}. Increment it for every subsequent published version.`);
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${manifest.version}`) throw new Error('Git tag must match the release version.');
console.log(`Consistent release version: ${manifest.version}; Android code ${tauri.bundle.android.versionCode}.`);
