// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { decodeText, parseEpub, parseTxt } from './parser';

const bytes = (text: string) => new TextEncoder().encode(text).buffer;

async function epubFixture(): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('OPS/package.opf', `<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>A Safe Book</dc:title><dc:creator>Test Author</dc:creator><dc:language>en</dc:language></metadata><manifest><item id="two" href="chapters/two.xhtml" media-type="application/xhtml+xml"/><item id="one" href="chapters/one.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>`);
  zip.file('OPS/nav.xhtml', '<html><body><nav><ol><li><a href="chapters/one.xhtml#start">Arrival</a></li><li><a href="chapters/two.xhtml">Departure</a></li></ol></nav></body></html>');
  zip.file('OPS/chapters/one.xhtml', '<html><body><h1 id="start">Wrong heading</h1><p>Hello <em>reader</em>.</p><script>alert("do not extract")</script><iframe src="https://example.com">bad</iframe><p>Second line.<br/>A verse.</p></body></html>');
  zip.file('OPS/chapters/two.xhtml', '<html><body><h2>Goodbye</h2><p>We return home.</p></body></html>');
  return zip.generateAsync({ type: 'arraybuffer' });
}

describe('TXT parsing', () => {
  it('keeps stable chapter/paragraph anchors and detects Chinese chapter headings', () => {
    const input = bytes('作者：某人\r\n前言\r\n这是前言。\r\n\r\n第一章 雨夜\r\n“你好。”她说。\r\n第二章 黎明\r\n太阳升起了。');
    const parsed = parseTxt(input, '测试.txt', 'book-stable');
    expect(parsed.author).toBe('某人');
    expect(parsed.language).toBe('zh');
    expect(parsed.chapters.map(chapter => chapter.title)).toEqual(['正文', '前言', '第一章 雨夜', '第二章 黎明']);
    expect(parsed.chapters[2].id).toBe('book-stable:ch:2');
    expect(parsed.chapters[2].paragraphs).toEqual(['“你好。”她说。']);
    expect(parseTxt(input, '测试.txt', 'book-stable').chapters).toEqual(parsed.chapters);
  });

  it('decodes GB18030 and UTF-16 BOM and rejects binary or malformed input', () => {
    const gbk = new Uint8Array([0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2, 0x20, 0xd3, 0xea, 0x0a, 0xd6, 0xd0, 0xce, 0xc4, 0xa1, 0xa3]).buffer;
    expect(decodeText(gbk)).toBe('第一章 雨\n中文。');
    expect(parseTxt(gbk, '雨.txt', 'rain').chapters[0].title).toBe('第一章 雨');
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00]).buffer)).toBe('AB');
    expect(() => decodeText(new Uint8Array([0, 0, 0, 0, 0, 3, 5, 2]).buffer)).toThrow('纯文本');
    expect(() => decodeText(new Uint8Array([0xff]).buffer)).toThrow('编码');
  });

  it('recognizes English chapter headings and retains non-heading prose', () => {
    const parsed = parseTxt(bytes('Chapter I\n“Good morning,” Ada said.\n\nChapter Two — Home\nThe road was quiet.\n\nEpilogue\nYears passed.'), 'Journey.txt', 'english');
    expect(parsed.chapters.map(chapter => chapter.title)).toEqual(['Chapter I', 'Chapter Two — Home', 'Epilogue']);
    expect(parsed.chapters[0].paragraphs).toEqual(['“Good morning,” Ada said.']);
    expect(parsed.totalWords).toBeGreaterThan(10);
  });
});

describe('EPUB parsing', () => {
  it('uses OPF spine order and navigation labels without mounting executable content', async () => {
    const parsed = await parseEpub(await epubFixture(), 'test.epub', 'epub-book');
    expect(parsed.title).toBe('A Safe Book');
    expect(parsed.author).toBe('Test Author');
    expect(parsed.chapters.map(chapter => chapter.title)).toEqual(['Arrival', 'Departure']);
    expect(parsed.chapters[0].paragraphs).toEqual(['Hello reader.', 'Second line.\nA verse.']);
    expect(parsed.chapters[1].sourcePath).toBe('OPS/chapters/two.xhtml');
  });

  it('rejects corrupted and DRM-protected packages', async () => {
    await expect(parseEpub(bytes('not an epub'), 'broken.epub', 'bad')).rejects.toThrow('无法打开');
    const zip = await JSZip.loadAsync(await epubFixture());
    zip.file('META-INF/encryption.xml', '<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#"><EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/></EncryptedData></encryption>');
    await expect(parseEpub(await zip.generateAsync({ type: 'arraybuffer' }), 'drm.epub', 'bad')).rejects.toThrow('DRM');
  });

  it('preserves fragment navigation when several chapters share one XHTML spine file', async () => {
    const zip = await JSZip.loadAsync(await epubFixture());
    zip.file('OPS/nav.xhtml', '<html><body><nav><a href="chapters/one.xhtml#opening">Opening</a><a href="chapters/one.xhtml#ending">Ending</a></nav></body></html>');
    zip.file('OPS/chapters/one.xhtml', '<html><body><section id="opening"><h1>Beginning</h1><p>First scene.</p></section><section id="ending"><h2>The end</h2><p>Last scene.</p></section></body></html>');
    const parsed = await parseEpub(await zip.generateAsync({ type: 'arraybuffer' }), 'fragments.epub', 'fragments');
    expect(parsed.chapters.map(chapter => chapter.title)).toEqual(['Opening', 'Ending', 'Goodbye']);
    expect(parsed.chapters[0].paragraphs).toEqual(['First scene.']);
    expect(parsed.chapters[1].paragraphs).toEqual(['The end', 'Last scene.']);
    expect(parsed.chapters[1].sourcePath).toBe('OPS/chapters/one.xhtml#ending');
  });
});
