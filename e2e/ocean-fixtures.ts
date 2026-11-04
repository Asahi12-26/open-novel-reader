import { expect, type Page } from '@playwright/test';

// These authored books live only in Playwright's fresh temporary browser context.
// The helpers never clear a database/store and never use a persistent user profile.
export async function seedOcean(page: Page, count = 36) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '我的书海', exact: true })).toBeVisible();
  await page.evaluate(async total => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('open-novel-reader');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const titles = ['山海之间', '长夜的灯', '风从海上来', '雨停之前', '星河信笺', '最后一班列车', '纸上的春天', '远山来客', '晴日手记', '月光书店', '慢慢走过四季', '落在窗前的信'];
    const authors = ['林岚', '许知遥', '秦川', '江晚'];
    const colors = ['#355e56', '#9e674d', '#4c5978', '#a58a52', '#6d526d', '#627a8e'];
    const transaction = database.transaction(['books', 'chapters', 'files'], 'readwrite');
    for (let i = 0; i < total; i++) {
      const id = `qa-ocean-${String(i).padStart(4, '0')}`;
      const title = `${titles[i % titles.length]}${i >= titles.length ? ` · ${Math.floor(i / titles.length) + 1}` : ''}`;
      const paragraphs = Array.from({ length: 32 }, (_, p) => `第${p + 1}段。雨后的石阶映着天空，林晚沿着河岸慢慢走来。她把信收在书页里，说：“等风停了，我们就继续出发。”这是为书海交互验证创作的独立短篇。`);
      const text = `第一章 来信\n\n${paragraphs.join('\n\n')}\n\n第二章 远行\n\n清晨的船停在岸边，新的故事从这里开始。`;
      transaction.objectStore('books').put({ id, title, author: authors[i % authors.length], format: 'txt', language: 'zh', coverColor: colors[i % colors.length], fingerprint: `authored-ocean-fixture-${i}`, totalWords: text.length, chapterCount: 2, createdAt: 1800000000000 - i, updatedAt: 1800000000000 - i, cloudEnabled: false });
      transaction.objectStore('chapters').put({ id: `${id}:ch:0`, bookId: id, index: 0, title: '第一章 来信', paragraphs });
      transaction.objectStore('chapters').put({ id: `${id}:ch:1`, bookId: id, index: 1, title: '第二章 远行', paragraphs: ['清晨的船停在岸边，新的故事从这里开始。'] });
      transaction.objectStore('files').put({ bookId: id, name: `${title}.txt`, mime: 'text/plain', bytes: new Blob([text], { type: 'text/plain' }) });
    }
    await new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error); });
    database.close();
  }, count);
  await page.reload();
  await expect(page.locator('.book-ocean')).toBeVisible();
}

export async function immutableLibrary(page: Page) {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('open-novel-reader'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const transaction = database.transaction(['books', 'chapters', 'files']);
    const rows = await Promise.all(['books', 'chapters', 'files'].map(store => new Promise<any[]>((resolve, reject) => { const request = transaction.objectStore(store).getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); })));
    database.close();
    const [books, chapters, files] = rows;
    return JSON.stringify({ books: books.sort((a, b) => a.id.localeCompare(b.id)), chapters: chapters.sort((a, b) => a.id.localeCompare(b.id)), files: await Promise.all(files.sort((a, b) => a.bookId.localeCompare(b.bookId)).map(async f => ({ bookId: f.bookId, name: f.name, text: await f.bytes.text() }))) });
  });
}

export async function visibleOceanBook(page: Page, order = 0) {
  return page.locator('.ocean-book-slot').evaluateAll((slots, index) => {
    const available = slots.filter(slot => { const r = slot.getBoundingClientRect(); return r.top >= 75 && r.bottom <= innerHeight - 90 && r.left >= 0 && r.right <= innerWidth; });
    const slot = available[index] as HTMLElement | undefined;
    if (!slot) throw new Error('No complete ocean book visible in the viewport');
    return { id: slot.dataset.bookId!, title: slot.querySelector('.book-open')!.getAttribute('aria-label')!.replace(/^阅读 /, '') };
  }, order);
}

export async function revealOcean(page: Page) {
  await page.locator('.book-ocean').evaluate(element => window.scrollTo({ top: element.getBoundingClientRect().top + window.scrollY - 100, behavior: 'instant' }));
  await expect.poll(() => page.locator('.ocean-book-slot').count()).toBeGreaterThan(2);
}

export async function tapOceanBook(page: Page, book: { id: string; title: string }) {
  const button = page.locator(`.ocean-book-slot[data-book-id="${book.id}"]`).getByRole('button', { name: `阅读 ${book.title}`, exact: true });
  await expect(button).toBeVisible();
  const rect = await button.boundingBox();
  if (!rect) throw new Error('Book reading target has no touchable rectangle');
  await page.touchscreen.tap(rect.x + rect.width / 2, rect.y + rect.height / 2);
}
