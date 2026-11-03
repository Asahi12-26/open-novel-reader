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

The distribution's [DEPENDENCY_NOTICES.txt](docs/licenses/DEPENDENCY_NOTICES.txt) retains original legal texts and copyright notices for 34 installed npm runtime packages and, conservatively, all 406 locked registry crate versions. Identical legal texts are reproduced once and referenced by notice number; every package has exact source attribution. Where a published crate omits its workspace LICENSE files, notices were recovered from its embedded exact upstream Git commit, or from a same-commit published workspace root crate. Source-header notices are retained without implementation source, with the full MPL template accompanying `selectors`.

Reproduce this collection with `node scripts/collect-notices.mjs` after `npm ci`. Source archives are downloaded with four workers from official crates.io storage, checked against Cargo.lock SHA-256 values, and cached under ignored `artifacts/`. A machine-readable collection report is written to `artifacts/notice-collection-report.json`; the current collection has no missing/failed packages. Include `docs/licenses/` and this notice document with binary distributions. This is conservative notice preservation, not a claim that all lockfile packages are linked into each binary.

The npm script checks recognized permissive SPDX alternatives and fails on unknown/unreviewed runtime expressions. `node scripts/rust-licenses.mjs` inventories the 406 registry package versions pinned by `src-tauri/Cargo.lock` using the primary crates.io version API, with three concurrent requests and a local ignored cache. The [locked Rust inventory](docs/RUST_DEPENDENCIES.md) gives exact versions, upstream license expressions and source archives. No metadata entries are missing in the reviewed snapshot. It includes build tools and other-platform dependencies; it is not the linked dependency closure of either distributed binary.

Rust packages other than the five MPL entries below offer a permissive option, including Unicode-3.0 and Apache-2.0 WITH LLVM-exception. For `r-efi`, choose MIT or Apache-2.0 rather than its alternative LGPL license. Unicode copyright and permission notices must be retained with distributions or their documentation; see the retained [Unicode license](docs/licenses/Unicode-3.0.txt) from [Unicode upstream](https://www.unicode.org/license.txt). Metadata inventory does not replace preservation of the upstream LICENSE / NOTICE / copyright files. No proprietary DRM parser, external book content, voice asset or remote font is included.

## MPL-2.0 source availability

The following upstream components are used without project-local modifications. Their source remains available under MPL-2.0, with its original notices and recipient rights. Download the exact published source archives below; they match Cargo.lock checksums and can be unpacked using any tar/gzip archive tool.

| Component | Exact source archive |
| --- | --- |
| cssparser 0.37.0 | [cssparser-0.37.0.crate](https://static.crates.io/crates/cssparser/cssparser-0.37.0.crate) |
| cssparser-macros 0.7.1 | [cssparser-macros-0.7.1.crate](https://static.crates.io/crates/cssparser-macros/cssparser-macros-0.7.1.crate) |
| dtoa-short 0.3.5 | [dtoa-short-0.3.5.crate](https://static.crates.io/crates/dtoa-short/dtoa-short-0.3.5.crate) |
| option-ext 0.2.0 | [option-ext-0.2.0.crate](https://static.crates.io/crates/option-ext/option-ext-0.2.0.crate) |
| selectors 0.38.0 | [selectors-0.38.0.crate](https://static.crates.io/crates/selectors/selectors-0.38.0.crate) |

See the [MPL-2.0 license text](docs/licenses/MPL-2.0.txt). Recipients may obtain, modify and redistribute those sources under MPL-2.0; the application's AGPL license does not remove these rights. Keep this notice and the upstream notices when redistributing binaries, and make any changes to MPL-covered files available under the applicable terms.

The five archives were individually downloaded and checked against Cargo.lock. No attached secondary-license-incompatibility notice was found outside the standard license text; `selectors` carries MPL notices in its source headers rather than a separate LICENSE file. The standard license's Exhibit B template is not itself an attached incompatibility notice. MPL 2.0 expressly lists AGPLv3 as a secondary license and permits combination subject to its conditions; this is the basis for finding no apparent compatibility blocker in this review. See [MPL 2.0 §§1.12 and 3.3](https://www.mozilla.org/en-US/MPL/2.0/) and [Mozilla FAQ Q25](https://www.mozilla.org/en-US/MPL/2.0/FAQ/). This is a source/metadata inspection, not a legal opinion or a guarantee about every target-specific distribution.

AGPL network/source obligations apply to modified network-served versions. The repository and “source” link should remain available alongside a hosted deployment. For license interpretation see the [official AGPL text](https://www.gnu.org/licenses/agpl-3.0.html) and upstream package files.
