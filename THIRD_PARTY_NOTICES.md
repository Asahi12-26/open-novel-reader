# Third-party notices

Open Novel Reader source is licensed AGPL-3.0-only; see LICENSE. Its bundled example story and procedural book icon are original project content under the same license. User-imported books retain their original rights and are not granted an AGPL license by importing them.

The selected direct runtime dependencies offer permissive terms compatible with an AGPL application when their notices are preserved:

| Package | Upstream license option used |
| --- | --- |
| React / React DOM | MIT |
| Dexie | Apache-2.0 |
| JSZip | MIT (dual licensed MIT OR GPL-3.0-or-later) |
| DOMPurify | Apache-2.0 (dual licensed Apache-2.0 OR MPL-2.0) |
| Motion | MIT |
| Lucide React | ISC |
| Supabase JS | MIT |
| Tauri JS API / Rust core | MIT OR Apache-2.0 |
| pako (JSZip transitive dependency) | MIT AND Zlib |

Exact installed versions and npm transitive dependency license expressions are recorded by `npm run licenses` in the generated `artifacts/dependency-licenses.json`. Retain all upstream LICENSE / NOTICE files in source or associated distribution notices. Build tools are not incorporated merely because they run during compilation; any runtime they bundle still needs its applicable notices.

The script checks recognized permissive SPDX alternatives for runtime npm packages and fails on unknown/unreviewed expressions. It does not prove Rust dependency compliance before Cargo resolves the native dependency tree; generate and commit Cargo.lock on the first successful Rust build, inventory that locked tree and retain the resulting notices before stable native distribution. No proprietary DRM parser, external book content, voice asset or remote font is included.

AGPL network/source obligations apply to modified network-served versions. The repository and “source” link should remain available alongside a hosted deployment. For license interpretation see the [official AGPL text](https://www.gnu.org/licenses/agpl-3.0.html) and upstream package files.
