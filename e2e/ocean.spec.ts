import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { immutableLibrary, revealOcean, seedOcean, tapOceanBook, visibleOceanBook } from './ocean-fixtures';

test('book ocean moves with staggered phases while the hover target stays lifted and stable', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await seedOcean(page);
  await page.screenshot({ path: 'artifacts/qa/ocean-default.png' });
  await revealOcean(page);
  const ocean = page.locator('.book-ocean');
  await expect(ocean).toHaveAttribute('data-motion', 'running');
  await page.mouse.move(5, 5);
  const sample = () => page.locator('.ocean-book-float').evaluateAll(elements => elements.slice(0, 4).map(element => ({ transform: getComputedStyle(element).transform, y: element.getBoundingClientRect().y })));
  const before = await sample();
  await expect.poll(async () => (await sample()).filter((state, index) => state.transform !== before[index]?.transform).length).toBeGreaterThan(1);
  const transforms = (await sample()).map(state => state.transform);
  expect(new Set(transforms).size).toBeGreaterThan(1);

  const book = await visibleOceanBook(page, 1);
  const slot = page.locator(`.ocean-book-slot[data-book-id="${book.id}"]`);
  const fixedBox = await slot.boundingBox();
  const floating = slot.locator('.ocean-book-float');
  const floatingBefore = await floating.boundingBox();
  await slot.hover();
  await expect(slot).toHaveClass(/is-active/);
  const lift = async () => { const rect = (await floating.boundingBox())!; return floatingBefore!.y + floatingBefore!.height / 2 - rect.y - rect.height / 2; };
  await expect.poll(lift).toBeGreaterThanOrEqual(50);
  const lockedPhase = await floating.evaluate(element => ['--wave-y', '--wave-rx', '--wave-ry', '--wave-rz'].map(name => getComputedStyle(element).getPropertyValue(name)));
  // Observe a live hover for long enough to cross animation frames and detect drift.
  await page.waitForTimeout(350);
  expect(await floating.evaluate(element => ['--wave-y', '--wave-rx', '--wave-ry', '--wave-rz'].map(name => getComputedStyle(element).getPropertyValue(name)))).toEqual(lockedPhase);
  expect(await slot.evaluate(element => element.matches(':hover'))).toBe(true);
  expect(Math.abs((await slot.boundingBox())!.y - fixedBox!.y)).toBeLessThan(1);
  writeFileSync('artifacts/qa/ocean-hover-metrics.json', JSON.stringify({ hoverLiftPx: await lift(), hoverTopShiftPx: floatingBefore!.y - (await floating.boundingBox())!.y, fixedSlotDisplacementPx: (await slot.boundingBox())!.y - fixedBox!.y, lockedPhase }, null, 2));
  await page.screenshot({ path: 'artifacts/qa/ocean-hover.png' });
  await page.mouse.move(5, 5);
  await page.getByRole('button', { name: '切换深浅主题', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: 'artifacts/qa/ocean-dark.png' });
});

test('keyboard opening and reverse transition preserve the ocean origin, scroll and book data', async ({ page }) => {
  await seedOcean(page, 48);
  await revealOcean(page);
  await page.mouse.move(1100, 600);
  const beforeWheel = await page.evaluate(() => window.scrollY);
  await page.mouse.wheel(0, 700);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(beforeWheel + 500);
  const book = await visibleOceanBook(page, 1);
  const slot = page.locator(`.ocean-book-slot[data-book-id="${book.id}"]`);
  const open = slot.getByRole('button', { name: `阅读 ${book.title}`, exact: true });
  await open.focus();
  const initialScroll = await page.evaluate(() => window.scrollY);
  const origin = await slot.boundingBox();
  const stored = await immutableLibrary(page);
  await open.press('Enter');
  const reader = page.getByRole('dialog', { name: `阅读 ${book.title}`, exact: true });
  await expect(reader).toBeVisible();
  // The open phase is deliberately brief; RAF observation cannot skip it as
  // the normal assertion retry backoff can when polling a transient state.
  await page.waitForFunction(() => document.querySelector('.reader')?.getAttribute('data-cover-phase') === 'open', undefined, { polling: 'raf', timeout: 3000 });
  await expect(reader.locator('.reader-cover-flight')).toBeVisible();
  await page.waitForTimeout(80); // Capture the visible hinge movement, midway through its visual phase.
  await page.screenshot({ path: 'artifacts/qa/ocean-opening.png' });
  await expect(reader.locator('.reader-cover-flight')).toHaveCount(0);
  await reader.getByRole('button', { name: '回到书架', exact: true }).first().click();
  await expect(reader).toHaveCount(0);
  await expect(slot).toBeVisible();
  expect(Math.abs(await page.evaluate(() => window.scrollY) - initialScroll)).toBeLessThan(2);
  const returned = await slot.boundingBox();
  expect(Math.abs(returned!.x - origin!.x)).toBeLessThan(1);
  expect(Math.abs(returned!.y - origin!.y)).toBeLessThan(2);
  expect(await immutableLibrary(page)).toEqual(stored);
});

test('mobile ocean scrolls, opens on one tap and respects reduced motion', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 412, height: 915 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    await seedOcean(page, 30);
    await revealOcean(page);
    const beforeScroll = await page.evaluate(() => window.scrollY);
    // Dispatch a trusted browser touch gesture over the covers, not a scripted
    // window.scrollBy, so accidentally preventing native scroll is detectable.
    const touch = await context.newCDPSession(page);
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 200, y: 680 }] });
    for (const y of [600, 520, 440, 360, 280, 220]) {
      await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 200, y }] });
      await page.waitForTimeout(20);
    }
    await page.waitForTimeout(90);
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await touch.detach();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(beforeScroll + 200);
    await expect(page.locator('.reader')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: 'artifacts/qa/ocean-mobile.png' });
    const book = await visibleOceanBook(page);
    await tapOceanBook(page, book);
    const reader = page.getByRole('dialog', { name: `阅读 ${book.title}`, exact: true });
    await expect(reader).toBeVisible();
    await expect(reader.getByRole('heading', { name: '第一章 来信', exact: true })).toBeVisible();
    await reader.getByRole('button', { name: '返回书架', exact: true }).tap();
    await expect(reader).toHaveCount(0);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.locator('.book-ocean')).toHaveAttribute('data-motion', 'reduced');
    const reducedBook = await visibleOceanBook(page);
    const reducedFloat = page.locator(`.ocean-book-slot[data-book-id="${reducedBook.id}"] .ocean-book-float`);
    await expect.poll(() => reducedFloat.evaluate(element => Number.parseFloat(getComputedStyle(element).getPropertyValue('--wave-y')))).toBe(0);
    const reducedRect = (await reducedFloat.boundingBox())!;
    await page.waitForTimeout(150);
    expect(Math.abs((await reducedFloat.boundingBox())!.y - reducedRect.y)).toBeLessThan(0.5);
    await tapOceanBook(page, reducedBook);
    await expect(page.getByRole('dialog', { name: `阅读 ${reducedBook.title}`, exact: true })).toBeVisible();
    await expect(page.locator('.reader-cover-flight')).toHaveCount(0);
  } finally { await context.close(); }
});

test('a large ocean renders a bounded window and recovers when opening a damaged test book', async ({ page }) => {
  await seedOcean(page, 240);
  await revealOcean(page);
  await expect.poll(() => page.locator('.ocean-book-slot').count()).toBeLessThan(100);
  await page.mouse.move(1100, 600);
  const beforeWheel = await page.evaluate(() => window.scrollY);
  await page.mouse.wheel(0, 1400);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(beforeWheel + 1000);
  const book = await visibleOceanBook(page, 1);
  const row = await page.locator(`.ocean-book-slot[data-book-id="${book.id}"]`).getAttribute('data-row');
  expect(Number(row)).toBeGreaterThan(0);
  // Deliberately corrupt only this authored fixture; never remove real user rows.
  await page.evaluate(async id => {
    if (!id.startsWith('qa-ocean-')) throw new Error('Refusing to alter a non-fixture book');
    const database = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('open-novel-reader'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const transaction = database.transaction('chapters', 'readwrite');
    transaction.objectStore('chapters').delete(`${id}:ch:0`);
    transaction.objectStore('chapters').delete(`${id}:ch:1`);
    await new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); });
    database.close();
  }, book.id);
  const stored = await immutableLibrary(page);
  await page.locator(`.ocean-book-slot[data-book-id="${book.id}"]`).getByRole('button', { name: `阅读 ${book.title}`, exact: true }).click();
  await expect(page.getByRole('status')).toContainText('没有可阅读的章节');
  await expect(page.locator('.reader')).toHaveCount(0);
  await expect(page.locator('.library-shell')).not.toHaveAttribute('inert', '');
  await expect(page.locator('.book-ocean')).toHaveAttribute('data-motion', 'running');
  const another = await visibleOceanBook(page, 2);
  await page.locator(`.ocean-book-slot[data-book-id="${another.id}"]`).getByRole('button', { name: `阅读 ${another.title}`, exact: true }).click();
  const reader = page.getByRole('dialog', { name: `阅读 ${another.title}`, exact: true });
  await expect(reader).toBeVisible();
  await reader.getByRole('button', { name: '回到书架', exact: true }).first().click();
  await expect(reader).toHaveCount(0);
  expect(await immutableLibrary(page)).toEqual(stored);
});
