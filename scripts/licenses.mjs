// Inventory the installed npm dependency tree; do not contact a registry.
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = process.cwd();
const lockPath = resolve(root, 'package-lock.json');
if (!existsSync(lockPath)) throw new Error('Run npm install to create the exact dependency lock first.');
const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
const rows = [];
const compatible = new Set(['MIT','ISC','Apache-2.0','BSD-2-Clause','BSD-3-Clause','0BSD','Unlicense','CC0-1.0','BlueOak-1.0.0','Zlib']);
const permits = expression => expression.replace(/[()]/g,'').split(/\s+OR\s+/).some(alternative => alternative.split(/\s+AND\s+/).every(part => compatible.has(part.trim())));
for (const [path, entry] of Object.entries(lock.packages ?? {})) {
  if (!path) continue;
  let manifest = {};
  try { manifest = JSON.parse(readFileSync(resolve(root,path,'package.json'),'utf8')); } catch {}
  const license = typeof manifest.license === 'string' ? manifest.license : (entry.license ?? 'UNKNOWN');
  rows.push({ name: manifest.name ?? path.split('node_modules/').at(-1), version: entry.version, license, development: !!entry.dev, compatible: permits(license), path });
}
rows.sort((a,b)=>a.name.localeCompare(b.name));
mkdirSync(resolve(root,'artifacts'),{recursive:true});
writeFileSync(resolve(root,'artifacts/dependency-licenses.json'),JSON.stringify(rows,null,2));
const needsReview = rows.filter(x => !x.development && !x.compatible);
console.log(`Inventoried ${rows.length} locked npm packages; ${rows.filter(x=>!x.development).length} runtime packages. Full report: artifacts/dependency-licenses.json`);
if (needsReview.length) { console.error('Runtime dependency licenses needing review:', needsReview.map(x=>`${x.name}@${x.version}: ${x.license}`).join('\n')); process.exitCode=1; }
else console.log('Runtime SPDX expressions have a recognized permissive license option. Preserve upstream notices when distributing.');
