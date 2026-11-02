import JSZip from 'jszip';
import type { Chapter } from '../types';

export const MAX_FILE_BYTES = 80 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 160 * 1024 * 1024;
const MAX_ENTRY_BYTES = 20 * 1024 * 1024;
export interface ParsedBook { title: string; author: string; language: string; cover?: string; chapters: Chapter[]; totalWords: number }

const stem = (name: string) => name.replace(/\.(txt|epub)$/i, '').replace(/[_]/g, ' ').trim().slice(0, 300) || '未命名书籍';
const heading = /^(?:第[零〇一二三四五六七八九十百千万两\d]+[章节回卷部篇集][\s\S]{0,55}|(?:chapter|book|part)\s+(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?:[\s.:—–-].{0,65})?|(?:序章|序言|前言|楔子|引子|后记|尾声|终章|prologue|epilogue|preface|introduction)(?:[\s.:：—–-].{0,55})?)$/i;

export function wordCount(text: string): number {
  return (text.match(/[\p{Script=Han}]/gu)?.length ?? 0) + (text.match(/[\p{Script=Latin}\p{N}]+(?:['’-][\p{Script=Latin}]+)*/gu)?.length ?? 0);
}

export function decodeText(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  if (view.length > MAX_FILE_BYTES) throw new Error('文件超过 80 MB 限制。请拆分后导入。');
  if (!view.length) throw new Error('这份 TXT 是空文件。');
  let text: string;
  try {
    if (view[0] === 0xff && view[1] === 0xfe) text = new TextDecoder('utf-16le', { fatal: true }).decode(view);
    else if (view[0] === 0xfe && view[1] === 0xff) text = new TextDecoder('utf-16be', { fatal: true }).decode(view);
    else text = new TextDecoder('utf-8', { fatal: true }).decode(view);
  } catch {
    try { text = new TextDecoder('gb18030', { fatal: true }).decode(view); }
    catch { throw new Error('无法识别文本编码。请将文件转换为 UTF-8 或 GB18030 后重试。'); }
  }
  const forbidden = text.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/g)?.length ?? 0;
  if (forbidden > Math.max(2, text.length * 0.002) || /^%PDF|^PK\u0003\u0004|^\x89PNG/.test(text)) {
    throw new Error('这看起来不是有效的纯文本小说。请选择 TXT 或无 DRM 的 EPUB。');
  }
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').normalize('NFC');
}

export function parseTxt(bytes: ArrayBuffer, filename: string, bookId: string): ParsedBook {
  const text = decodeText(bytes);
  if (!text.trim()) throw new Error('这份小说没有可阅读的正文。');
  const lines = text.split('\n');
  const author = lines.slice(0, 15).map(line => line.match(/^\s*(?:作者|author)\s*[:：]\s*(.{1,100})$/i)?.[1]).find(Boolean) || '未知作者';
  const chapters: Chapter[] = [];
  let title = '正文';
  let buffer: string[] = [];
  const flush = () => {
    const paragraphs = buffer.map(line => line.trim()).filter(Boolean);
    if (paragraphs.length) chapters.push({ id: `${bookId}:ch:${chapters.length}`, bookId, index: chapters.length, title, paragraphs });
    buffer = [];
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length <= 100 && heading.test(trimmed)) {
      flush();
      title = trimmed;
    } else {
      buffer.push(line);
      // Keep extremely large heading-less files navigable without changing text anchors later.
      if (buffer.length >= 2500) { flush(); title = `正文 · ${chapters.length + 1}`; }
    }
  }
  flush();
  if (!chapters.length) throw new Error('这份小说没有可阅读的正文。');
  return { title: stem(filename), author, language: /[\p{Script=Han}]/u.test(text.slice(0, 5000)) ? 'zh' : 'en', chapters, totalWords: wordCount(text) };
}

function xml(source: string, label: string): Document {
  const doc = new DOMParser().parseFromString(source, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error(`EPUB 的 ${label} 结构损坏。`);
  return doc;
}
function elements(root: Document | Element, tag: string): Element[] {
  return Array.from(root.getElementsByTagNameNS('*', tag));
}
function resolvePath(base: string, reference: string): string | null {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(reference)) return null;
  let raw: string;
  try { raw = decodeURIComponent(reference.split('#')[0].split('?')[0]); } catch { return null; }
  if (!raw) return base;
  const pieces = [...base.split('/').slice(0, -1), ...raw.split('/')];
  const result: string[] = [];
  for (const piece of pieces) {
    if (!piece || piece === '.') continue;
    if (piece === '..') { if (!result.length) return null; result.pop(); }
    else result.push(piece);
  }
  return result.join('/');
}

/** Text-only XHTML extraction: never mounts book HTML, scripts, CSS or remote resources. */
function readXhtml(source: string): { paragraphs: string[]; heading?: string; anchors: Map<string, number> } {
  const doc = new DOMParser().parseFromString(source, 'text/html');
  doc.querySelectorAll('script,style,iframe,object,embed,form,nav,svg,math,link,meta,head').forEach(el => el.remove());
  const rawTitle = doc.querySelector('h1,h2,h3')?.textContent?.trim();
  const title = rawTitle?.slice(0, 300);
  doc.querySelectorAll('br').forEach(el => el.replaceWith(doc.createTextNode('\n')));
  const paragraphs: string[] = [];
  const anchors = new Map<string, number>();
  const blockTags = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'BLOCKQUOTE', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'DD', 'DT', 'FIGCAPTION']);
  const visit = (node: Node) => {
    if (node.nodeType === 1) {
      const anchor = (node as Element).getAttribute('id') || (node as Element).getAttribute('name');
      if (anchor && !anchors.has(anchor)) anchors.set(anchor, paragraphs.length);
    }
    let pending = '';
    const flush = () => {
      const cleaned = pending.replace(/[\t\r ]+/g, ' ').trim().normalize('NFC');
      if (cleaned) paragraphs.push(cleaned);
      pending = '';
    };
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 1 && blockTags.has((child as Element).tagName)) { flush(); visit(child); }
      else if (child.nodeType === 1 || child.nodeType === 3) {
        if (child.nodeType === 1) {
          const inlineNodes = [child as Element, ...Array.from((child as Element).querySelectorAll('[id],[name]'))];
          for (const inline of inlineNodes) {
            const anchor = inline.getAttribute('id') || inline.getAttribute('name');
            if (anchor && !anchors.has(anchor)) anchors.set(anchor, paragraphs.length);
          }
        }
        pending += child.textContent || '';
      }
    }
    flush();
  };
  visit(doc.body);
  if (paragraphs.length > 1 && rawTitle === paragraphs[0]) {
    paragraphs.shift();
    for (const [anchor, index] of anchors) anchors.set(anchor, Math.max(0, index - 1));
  }
  return { paragraphs, heading: title, anchors };
}

export async function parseEpub(bytes: ArrayBuffer, filename: string, bookId: string): Promise<ParsedBook> {
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error('文件超过 80 MB 限制。请拆分后导入。');
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(bytes, { checkCRC32: false }); }
  catch { throw new Error('无法打开 EPUB。文件可能已损坏，或并非 EPUB 格式。'); }
  const entries = Object.values(zip.files);
  if (entries.length > 8000) throw new Error('EPUB 文件条目过多，已停止解压。');
  let expandedSize = 0;
  for (const entry of entries) {
    const size = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize || 0;
    if (size > MAX_ENTRY_BYTES) throw new Error('EPUB 中的单个文件过大。');
    expandedSize += size;
  }
  if (expandedSize > MAX_EXPANDED_BYTES) throw new Error('EPUB 解压后的体积超过安全限制。');
  const read = async (path: string) => {
    const entry = zip.file(path);
    if (!entry) throw new Error(`EPUB 缺少必要文件：${path.slice(0, 120)}`);
    return entry.async('string');
  };
  const encryption = zip.file('META-INF/encryption.xml');
  if (encryption) {
    const enc = xml(await encryption.async('string'), '加密清单');
    const algorithms = elements(enc, 'EncryptionMethod').map(el => el.getAttribute('Algorithm'));
    if (algorithms.some(alg => alg !== 'http://www.idpf.org/2008/embedding' && alg !== 'http://ns.adobe.com/pdf/enc#RC')) {
      throw new Error('这本 EPUB 使用 DRM 加密，暂时无法阅读。请导入无 DRM 的版本。');
    }
  }
  const container = xml(await read('META-INF/container.xml'), 'container.xml');
  const packagePath = elements(container, 'rootfile')[0]?.getAttribute('full-path');
  if (!packagePath || packagePath.includes('..') || /^[a-z]+:/i.test(packagePath)) throw new Error('EPUB 缺少有效的内容包路径。');
  const opf = xml(await read(packagePath), 'OPF');
  const items = new Map(elements(opf, 'item').map(el => [el.getAttribute('id') || '', el]));
  const navLabels = new Map<string, string>();
  const navTargets: { path: string; fragment: string; label: string }[] = [];
  const registerNavigation = (base: string, href: string, label: string) => {
    const path = resolvePath(base, href);
    if (!path || !label) return;
    let fragment: string;
    try { fragment = decodeURIComponent(href.split('#')[1] || ''); } catch { fragment = ''; }
    const shortLabel = label.slice(0, 300);
    if (!navLabels.has(path)) navLabels.set(path, shortLabel);
    if (!navTargets.some(target => target.path === path && target.fragment === fragment)) navTargets.push({ path, fragment, label: shortLabel });
  };
  const navItem = [...items.values()].find(el => el.getAttribute('properties')?.split(/\s+/).includes('nav'));
  if (navItem) {
    const navPath = resolvePath(packagePath, navItem.getAttribute('href') || '');
    if (navPath && zip.file(navPath)) {
      const nav = new DOMParser().parseFromString(await read(navPath), 'text/html');
      nav.querySelectorAll('a[href]').forEach(el => {
        const label = el.textContent?.trim();
        if (label) registerNavigation(navPath, el.getAttribute('href') || '', label);
      });
    }
  }
  const ncxItem = [...items.values()].find(el => el.getAttribute('media-type') === 'application/x-dtbncx+xml');
  if (ncxItem) {
    const ncxPath = resolvePath(packagePath, ncxItem.getAttribute('href') || '');
    if (ncxPath && zip.file(ncxPath)) {
      const ncx = xml(await read(ncxPath), '目录');
      for (const point of elements(ncx, 'navPoint')) {
        const ref = elements(point, 'content')[0]?.getAttribute('src');
        const label = elements(point, 'text')[0]?.textContent?.trim();
        if (ref && label) registerNavigation(ncxPath, ref, label);
      }
    }
  }
  const chapters: Chapter[] = [];
  for (const ref of elements(opf, 'itemref')) {
    if (ref.getAttribute('linear') === 'no') continue;
    const item = items.get(ref.getAttribute('idref') || '');
    if (!item) throw new Error('EPUB 的阅读顺序引用了不存在的章节。');
    if (!/^(application\/xhtml\+xml|text\/html)$/.test(item.getAttribute('media-type') || '')) continue;
    const path = resolvePath(packagePath, item.getAttribute('href') || '');
    if (!path) throw new Error('EPUB 包含无效的章节地址。');
    const content = readXhtml(await read(path));
    if (!content.paragraphs.length) continue; // Raster cover/title pages have no readable text.
    const boundaries = navTargets.filter(target => target.path === path).map(target => ({ ...target, index: target.fragment ? content.anchors.get(target.fragment) : 0 })).filter((target): target is typeof target & { index: number } => target.index !== undefined).sort((a, b) => a.index - b.index);
    const distinct = boundaries.filter((target, index) => !index || target.index !== boundaries[index - 1].index);
    if (distinct.length > 1) {
      if (distinct[0].index > 0) distinct.unshift({ path, fragment: '', label: content.heading || '序言', index: 0 });
      for (let i = 0; i < distinct.length; i++) {
        const target = distinct[i];
        const paragraphs = content.paragraphs.slice(target.index, distinct[i + 1]?.index);
        if (paragraphs.length) chapters.push({ id: `${bookId}:ch:${chapters.length}`, bookId, index: chapters.length, title: target.label, paragraphs, sourcePath: path + (target.fragment ? `#${target.fragment}` : '') });
      }
    } else {
      chapters.push({ id: `${bookId}:ch:${chapters.length}`, bookId, index: chapters.length, title: navLabels.get(path) || content.heading || `第 ${chapters.length + 1} 节`, paragraphs: content.paragraphs, sourcePath: path });
    }
  }
  if (!chapters.length) throw new Error('EPUB 没有可阅读的文字章节。图片型 EPUB 暂不支持。');
  let cover: string | undefined;
  const coverId = elements(opf, 'meta').find(el => el.getAttribute('name') === 'cover')?.getAttribute('content');
  const coverItem = [...items.values()].find(el => el.getAttribute('properties')?.split(/\s+/).includes('cover-image')) || (coverId ? items.get(coverId) : undefined);
  if (coverItem) {
    const mime = coverItem.getAttribute('media-type') || '';
    const path = resolvePath(packagePath, coverItem.getAttribute('href') || '');
    const entry = path && zip.file(path);
    if (/^image\/(jpeg|png|webp|gif)$/.test(mime) && entry) {
      const data = await entry.async('uint8array');
      if (data.byteLength <= 3 * 1024 * 1024) cover = `data:${mime};base64,${await entry.async('base64')}`;
    }
  }
  return {
    title: elements(opf, 'title')[0]?.textContent?.trim().slice(0, 300) || stem(filename),
    author: elements(opf, 'creator')[0]?.textContent?.trim().slice(0, 200) || '未知作者',
    language: elements(opf, 'language')[0]?.textContent?.trim().slice(0, 100) || 'und',
    cover, chapters, totalWords: chapters.reduce((sum, chapter) => sum + wordCount(chapter.paragraphs.join('\n')), 0),
  };
}
