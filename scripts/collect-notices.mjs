// Preserve upstream notices for distribution. Downloads are data, never executed.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { resolve, relative, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const noticeName = name => /^(?:LICEN[CS]E|NOTICE|COPYING|COPYRIGHT|AUTHORS)(?:$|[._-])/i.test(basename(name));
const root = process.cwd();
const cacheDir = resolve('artifacts/crate-archives');
mkdirSync(cacheDir, { recursive: true });
mkdirSync('docs/licenses', { recursive: true });
const inventory = (() => {
  for (const name of ['artifacts/rust-licenses.json', 'artifacts/rust-dependency-licenses.json']) {
    try { return JSON.parse(readFileSync(name, 'utf8')).packages; } catch { /* optional metadata cache */ }
  }
  return [];
})();
const licenseByCrate = new Map(inventory.map(p => [`${p.name}@${p.version}`, p.license]));
const crates = readFileSync('src-tauri/Cargo.lock', 'utf8').split('[[package]]').slice(1).map(text => ({
  ecosystem: 'cargo',
  name: text.match(/^name = "([^"]+)"/m)?.[1],
  version: text.match(/^version = "([^"]+)"/m)?.[1],
  registry: text.match(/^source = "([^"]+)"/m)?.[1],
  checksum: text.match(/^checksum = "([^"]+)"/m)?.[1],
})).filter(p => p.registry?.startsWith('registry+')).map(p => ({
  ...p, license: licenseByCrate.get(`${p.name}@${p.version}`) ?? 'see upstream',
  source: `https://static.crates.io/crates/${p.name}/${p.name}-${p.version}.crate`,
}));

function textNotice(bytes) {
  if (bytes.length > 2 * 1024 * 1024 || bytes.subarray(0, 8192).includes(0)) return null;
  return bytes.toString('utf8').replaceAll('\r\n', '\n').trimEnd();
}

function npmNotices(packageDir) {
  const found = [];
  const walk = (dir, depth) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, item.name);
      if (item.isFile() && noticeName(item.name)) {
        const text = textNotice(readFileSync(path));
        if (text) found.push({ file: relative(packageDir, path).replaceAll('\\', '/'), text });
      } else if (item.isDirectory() && depth < 3 && /^(?:licen[cs]es?|notices?|legal)$/i.test(item.name)) walk(path, depth + 1);
    }
  };
  walk(packageDir, 0);
  if (!found.length) {
    for (const item of readdirSync(packageDir, { withFileTypes: true }).filter(x => x.isFile() && /^README(?:\.|$)/i.test(x.name))) {
      const text = readFileSync(resolve(packageDir, item.name), 'utf8');
      const marker = text.match(/^#{1,4}\s+Licen[cs]e\s*\r?\n/im);
      const remainder = marker ? text.slice(marker.index + marker[0].length) : '';
      const end = remainder.search(/^#{1,4}\s/m);
      const section = end < 0 ? remainder : remainder.slice(0, end);
      if (section && /Permission is hereby granted|Redistribution and use|Apache License|Mozilla Public License/i.test(section)) found.push({ file: `${item.name} (License section only)`, text: section.trim() });
    }
  }
  return found;
}

const npmPackages = [];
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
for (const [path, p] of Object.entries(lock.packages)) {
  if (!path || p.dev) continue;
  const dir = resolve(path);
  if (!existsSync(dir)) { npmPackages.push({ ecosystem: 'npm', name: path.split('node_modules/').at(-1), version: p.version, error: 'Runtime entry is not installed on this platform; no local notices collected.', notices: [] }); continue; }
  const pkg = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8'));
  const notices = npmNotices(dir);
  npmPackages.push({ ecosystem: 'npm', name: pkg.name, version: pkg.version, license: pkg.license ?? p.license, source: `https://registry.npmjs.org/${pkg.name}/-/${pkg.name.split('/').at(-1)}-${pkg.version}.tgz`, notices, missing: !notices.length });
}

async function downloadCrate(p) {
  const cache = resolve(cacheDir, `${p.name}-${p.version}.crate`);
  for (const candidate of [cache, resolve('artifacts/mpl-crates', `${p.name}-${p.version}.crate`)]) {
    if (existsSync(candidate)) {
      const bytes = readFileSync(candidate);
      if (sha256(bytes) === p.checksum) { if (candidate !== cache) copyFileSync(candidate, cache); return bytes; }
    }
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(p.source, {
      headers: { 'User-Agent': 'OpenNovelReader-notice-collection/0.1 (https://github.com/Asahi12-26/open-novel-reader)' },
      signal: AbortSignal.timeout(30000),
    });
    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      const delay = Math.min(10, Math.max(1, Number(response.headers.get('Retry-After')) || attempt + 1));
      await new Promise(resolve => setTimeout(resolve, delay * 1000)); continue;
    }
    if (!response.ok) throw new Error(`Archive HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== p.checksum) throw new Error('Archive does not match Cargo.lock SHA256');
    writeFileSync(cache, bytes); return bytes;
  }
  throw new Error('Archive download retry exhausted');
}

function sourceHeader(text) {
  // Retain only leading comments; never copy implementation source into notices.
  const source = text.replace(/^\uFEFF/, '');
  if (/^\s*\/\/[!/]/.test(source)) return null; // Rust API docs can contain code examples.
  const header = source.match(/^\s*(?:(?:\/\*[\s\S]*?\*\/\s*)|(?:\/\/[^\n]*(?:\n|$)\s*))+/)?.[0]?.split(/\r?\n\s*\/\/[!/]/)[0]?.split(/\r?\n\s*\/\*[!*]/)[0]?.trim();
  return header && header.length < 12000 && /copyright|SPDX|This Source Code Form|Redistribution and use|Permission is hereby granted|Licensed under the (?:Apache|MIT|BSD)/i.test(header) ? header : null;
}

function crateNotices(p, bytes) {
  const tar = gunzipSync(bytes, { maxOutputLength: 160 * 1024 * 1024 });
  const notices = [], headers = [], seenHeaders = new Set();
  let vcs, manifest;
  const prefix = `${p.name}-${p.version}/`;
  for (let off = 0; off + 512 <= tar.length;) {
    const header = tar.subarray(off, off + 512);
    if (header.every(x => x === 0)) break;
    const name = header.subarray(0, 100).toString().replace(/\0.*$/s, '');
    const size = parseInt(header.subarray(124, 136).toString().replace(/\0.*$/s, '').trim(), 8) || 0;
    if (off + 512 + size > tar.length || size < 0) throw new Error('Malformed tar member');
    const type = header[156];
    if ((type === 0 || type === 48) && name.startsWith(prefix)) {
      const file = name.slice(prefix.length);
      const data = tar.subarray(off + 512, off + 512 + size);
      if (file === '.cargo_vcs_info.json') { try { vcs = JSON.parse(data.toString()); } catch { /* old crates */ } }
      if (file === 'Cargo.toml') manifest = data.toString();
      if (noticeName(file)) {
        const text = textNotice(data); if (text) notices.push({ file, text });
      } else if (/\.(?:rs|c|h|cpp|hpp|js|ts)$/i.test(file)) {
        const text = sourceHeader(data.subarray(0, 16000).toString('utf8'));
        if (text && !seenHeaders.has(text)) { headers.push({ file: `${file} (leading license/copyright comment only)`, text }); seenHeaders.add(text); }
      }
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  // Separate comments can carry additional copyright attributions, even where a
  // common LICENSE file is present. Exact duplicate comments are kept only once.
  notices.push(...headers);
  const packageLicense = manifest?.match(/^license\s*=\s*"([^"]+)"/m)?.[1] ?? p.license;
  let fallback = null;
  if (!notices.some(n => noticeName(n.file)) && packageLicense === 'MPL-2.0') {
    notices.push({ file: 'MPL-2.0 full template accompanying upstream source-header notices', text: readFileSync('docs/licenses/MPL-2.0.txt', 'utf8') });
    fallback = 'MPL source-header notices plus the full MPL-2.0 template and exact source link.';
  }
  const repository = manifest?.match(/^repository\s*=\s*"([^"]+)"/m)?.[1];
  return { license: packageLicense, notices, fallback, missing: !notices.length, sourceHeaderOnly: !notices.some(n => noticeName(n.file)), provenance: { repository, commit: vcs?.git?.sha1, path: vcs?.path_in_vcs ?? '' } };
}

const upstreamPromises = new Map();
async function upstreamNotices(provenance) {
  const match = provenance.repository?.match(/github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/);
  if (!match || !/^[a-f0-9]{40}$/i.test(provenance.commit ?? '')) throw new Error('No exact GitHub repository commit in published crate provenance.');
  const owner = match[1], repo = match[2].replace(/\.git$/, ''), commit = provenance.commit;
  const key = `${owner}__${repo}__${commit}`;
  if (!upstreamPromises.has(key)) upstreamPromises.set(key, (async () => {
    const dir = resolve('artifacts/upstream-notices'); mkdirSync(dir, { recursive: true });
    const path = resolve(dir, `${key}.json`);
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
    const headers = { 'User-Agent': 'OpenNovelReader-notice-collection/0.1 (https://github.com/Asahi12-26/open-novel-reader)' };
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${commit}?recursive=1`, { headers, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Pinned upstream tree HTTP ${response.status}`);
    const tree = (await response.json()).tree ?? [];
    const files = tree.filter(p => p.type === 'blob' && p.size <= 2 * 1024 * 1024 && (noticeName(p.path) || /(?:^|\/)(?:licen[cs]es?|notices?|legal)\/[^/]+\.(?:txt|md|rst)$/i.test(p.path)));
    const result = { owner, repo, commit, files, texts: {} };
    writeFileSync(path, JSON.stringify(result, null, 2)); return result;
  })());
  const snapshot = await upstreamPromises.get(key);
  const components = (provenance.path ?? '').split('/').filter(Boolean);
  const ancestors = new Set(['']); while (components.length) { ancestors.add(components.join('/')); components.pop(); }
  const chosen = snapshot.files.filter(p => {
    const parent = p.path.split('/').slice(0, -1).join('/');
    if (ancestors.has(parent)) return true;
    return [...ancestors].some(a => p.path.startsWith(a ? `${a}/` : '') && /^(?:licen[cs]es?|notices?|legal)\/[^/]+\.(?:txt|md|rst)$/i.test(a ? p.path.slice(a.length + 1) : p.path));
  }).slice(0, 24);
  const notices = [];
  for (const file of chosen) {
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/${commit}/${file.path}`;
    let text = snapshot.texts[file.path];
    if (!text) {
      const response = await fetch(url, { headers: { 'User-Agent': 'OpenNovelReader-notice-collection/0.1' }, signal: AbortSignal.timeout(30000) });
      if (!response.ok) continue;
      text = textNotice(Buffer.from(await response.arrayBuffer()));
      if (text) snapshot.texts[file.path] = text;
    }
    if (text) notices.push({ file: `published crate's pinned upstream repository: ${url}`, text });
  }
  writeFileSync(resolve('artifacts/upstream-notices', `${key}.json`), JSON.stringify(snapshot, null, 2));
  return notices;
}

let cursor = 0, completed = 0;
const rustPackages = [];
await Promise.all(Array.from({ length: 4 }, async () => {
  while (cursor < crates.length) {
    const p = crates[cursor++];
    try {
      const collected = crateNotices(p, await downloadCrate(p));
      if (collected.sourceHeaderOnly && !collected.fallback) {
        try {
          const recovered = await upstreamNotices(collected.provenance);
          if (recovered.length) { collected.notices.push(...recovered); collected.missing = false; collected.sourceHeaderOnly = false; collected.upstreamRecovered = recovered.length; }
          else if (collected.missing) collected.error = 'No standalone notice found in crate or its exact upstream repository ancestors.';
        } catch (error) { if (collected.missing) collected.error = String(error); }
      }
      rustPackages.push({ ...p, checksumVerified: true, ...collected });
    }
    catch (error) { rustPackages.push({ ...p, error: String(error), notices: [], missing: true }); }
    completed++;
    if (completed % 100 === 0) console.log(`Collected ${completed}/${crates.length} locked crate archives.`);
  }
}));

// Some workspace subcrates omit repository and license files, but publish the
// exact same VCS commit as their root crate. Retain that root's original notices.
for (const p of rustPackages.filter(p => p.missing && p.provenance?.commit && p.provenance?.path)) {
  const workspaceRoot = rustPackages.find(other => other !== p && other.provenance?.commit === p.provenance.commit && !other.provenance?.path && other.notices.some(n => noticeName(n.file)));
  if (!workspaceRoot) continue;
  const originals = workspaceRoot.notices.filter(n => noticeName(n.file));
  p.notices.push(...originals.map(n => ({ file: `same-commit workspace root ${workspaceRoot.name}@${workspaceRoot.version}: ${n.file}; source ${workspaceRoot.source}`, text: n.text })));
  p.workspaceRecovered = `${workspaceRoot.name}@${workspaceRoot.version} (${p.provenance.commit})`;
  p.missing = false; p.sourceHeaderOnly = false; delete p.error;
}

const packages = [...npmPackages, ...rustPackages].sort((a, b) => a.ecosystem.localeCompare(b.ecosystem) || a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
const output = [
  'OPEN NOVEL READER — DEPENDENCY LICENSES AND NOTICES',
  '',
  'This distribution retains upstream license/copyright notices for installed npm runtime packages and, conservatively, all registry versions in Cargo.lock. The Cargo set includes build tools and other-platform dependencies, so this is not a target-specific linked-closure claim.',
  'License alternatives remain as offered by upstream. The project selects permissive options where available; MPL-covered source retains its MPL rights. See THIRD_PARTY_NOTICES.md and docs/RUST_DEPENDENCIES.md in https://github.com/Asahi12-26/open-novel-reader for source-availability details.',
  'Only notices and leading license/copyright comments are reproduced here, not implementation source. Identical notice text is printed once and referenced by notice number thereafter. Exact source archives are linked for every package.', '',
];
const duplicateTexts = new Map();
let noticeCount = 0;
for (const p of packages) {
  output.push('='.repeat(78), `${p.ecosystem}: ${p.name}@${p.version}`, `Upstream license expression: ${p.license ?? 'see upstream'}`, `Exact source archive: ${p.source ?? 'not installed'}`);
  if (p.checksum) output.push(`Cargo.lock source SHA256: ${p.checksum}`);
  if (p.fallback) output.push(`Notice handling: ${p.fallback}`);
  if (p.error || p.missing) output.push(`COLLECTION NOTE: ${p.error ?? 'No standalone notice or leading license comment found; see the exact upstream source.'}`);
  for (const item of p.notices) {
    const digest = sha256(item.text);
    output.push('', `Upstream file: ${item.file}`);
    if (duplicateTexts.has(digest)) output.push(`Identical complete notice text is retained above as NOTICE ${duplicateTexts.get(digest)}.`);
    else {
      noticeCount++; duplicateTexts.set(digest, noticeCount);
      output.push(`----- BEGIN NOTICE ${noticeCount} -----`, item.text, `----- END NOTICE ${noticeCount} -----`);
    }
  }
  output.push('');
}
writeFileSync('docs/licenses/DEPENDENCY_NOTICES.txt', output.join('\n'));
copyFileSync('LICENSE', 'docs/licenses/AGPL-3.0.txt');
const summary = {
  npmRuntimePackages: npmPackages.length,
  lockedCrateVersions: crates.length,
  verifiedCrateArchives: rustPackages.filter(p => p.checksumVerified).length,
  uniqueNoticeTexts: noticeCount,
  missingOrFailed: packages.filter(p => p.missing || p.error).map(({ notices, ...p }) => p),
  sourceHeaderOnly: rustPackages.filter(p => p.sourceHeaderOnly).map(({ notices, ...p }) => p),
  noticeFileBytes: statSync('docs/licenses/DEPENDENCY_NOTICES.txt').size,
};
writeFileSync('artifacts/notice-collection-report.json', JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ ...summary, missingOrFailed: summary.missingOrFailed.map(p => ({ package: `${p.ecosystem}:${p.name}@${p.version}`, error: p.error ?? 'No upstream notice found.' })), sourceHeaderOnly: summary.sourceHeaderOnly.map(p => `${p.name}@${p.version}`) }, null, 2));
if (summary.missingOrFailed.length) process.exitCode = 1;
