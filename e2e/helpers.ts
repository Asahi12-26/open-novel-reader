import { expect, type Page } from '@playwright/test';
import JSZip from 'jszip';

export function textNovel() {
  return Buffer.from(`第一章 山间来信\n\n${Array.from({ length: 65 }, (_, i) => `第${i + 1}段：清晨的风越过山谷，把远方的消息送到窗前。林晚翻开信纸，慢慢读起了那些久违的字句。她说：“我们明天就出发吧。”`).join('\n\n')}\n\n第二章 归途\n\n第一段归途文字：新的章节从这里开始。\n\n第二段归途文字：日光落在桥上。`, 'utf8');
}

export async function importText(page: Page, name = '稳定锚点.txt') {
  await page.getByLabel('导入小说文件', { exact: true }).setInputFiles({ name, mimeType: 'text/plain', buffer: textNovel() });
  await expect(page.getByRole('button', { name: `阅读 ${name.replace(/\.txt$/i, '')}`, exact: true })).toBeVisible();
}

export async function progress(page: Page): Promise<{ bookId: string; chapterId: string; paragraphIndex: number; offset: number } | undefined> {
  return page.evaluate(() => new Promise<{ bookId: string; chapterId: string; paragraphIndex: number; offset: number } | undefined>((resolve, reject) => {
    const request = indexedDB.open('open-novel-reader');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const read = database.transaction('progress').objectStore('progress').getAll();
      read.onerror = () => { database.close(); reject(read.error); };
      read.onsuccess = () => { database.close(); resolve(read.result[0]); };
    };
  }));
}

export async function epubNovel(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('OPS/package.opf', '<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>真实 EPUB 测试</dc:title><dc:creator>Open Reader Tests</dc:creator><dc:language>en</dc:language></metadata><manifest><item id="second" href="second.xhtml" media-type="application/xhtml+xml"/><item id="first" href="first.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="first"/><itemref idref="second"/></spine></package>');
  zip.file('OPS/nav.xhtml', '<html><body><nav><ol><li><a href="first.xhtml">Arrival</a></li><li><a href="second.xhtml">Homecoming</a></li></ol></nav></body></html>');
  zip.file('OPS/first.xhtml', '<html><body><h1>Arrival</h1><p>“Welcome home,” Ada said.</p><p>The old library was still there.</p><script>window.__epubScriptExecuted=true</script></body></html>');
  zip.file('OPS/second.xhtml', '<html><body><h1>Homecoming</h1><p>The journey continued in another chapter.</p></body></html>');
  return zip.generateAsync({ type: 'nodebuffer' });
}
