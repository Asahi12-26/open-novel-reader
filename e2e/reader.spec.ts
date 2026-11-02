import { test, expect } from '@playwright/test';
import { epubNovel, importText, progress } from './helpers';

test('TXT import, paragraph anchors, typography, bookmarks and restart persistence', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await importText(page);
  await page.getByRole('button', { name: '关闭提示', exact: true }).click();
  await page.screenshot({ path: 'test-results/desktop-bookshelf.png', fullPage: true });
  await page.getByRole('button', { name: '阅读 稳定锚点', exact: true }).click();
  const reader = page.getByRole('dialog', { name: '阅读 稳定锚点', exact: true });
  await expect(reader.getByRole('heading', { name: '第一章 山间来信', exact: true })).toBeVisible();
  await expect(reader).toHaveCSS('opacity', '1');
  await page.screenshot({ path: 'test-results/desktop-reader.png' });
  await reader.locator('[data-paragraph="28"]').evaluate(element => element.scrollIntoView({ block: 'start' }));
  await expect.poll(async () => (await progress(page))?.paragraphIndex).toBeGreaterThan(20);
  const anchor = (await progress(page))!.paragraphIndex;
  await reader.getByRole('button', { name: '添加当前段落书签' }).click();
  await reader.getByRole('button', { name: '阅读排版设置' }).click();
  await reader.getByLabel('字号', { exact: true }).focus();
  await reader.getByLabel('字号', { exact: true }).press('End');
  await expect(reader.getByLabel('字号', { exact: true })).toHaveValue('36');
  await expect.poll(async () => (await progress(page))?.paragraphIndex).toBeGreaterThanOrEqual(anchor - 1);
  const anchorBox = await reader.locator(`[data-paragraph="${anchor}"]`).boundingBox();
  const scrollerBox = await reader.getByLabel('小说正文', { exact: true }).boundingBox();
  expect(anchorBox!.y + anchorBox!.height).toBeGreaterThan(scrollerBox!.y);
  expect(anchorBox!.y).toBeLessThan(scrollerBox!.y + scrollerBox!.height);
  await page.reload();
  await expect(page.getByRole('dialog', { name: '阅读 稳定锚点', exact: true })).toBeVisible();
  await expect.poll(async () => (await progress(page))?.paragraphIndex).toBeGreaterThanOrEqual(anchor - 1);
  await reader.getByRole('button', { name: '查看全部书签' }).click();
  await expect(page.getByRole('dialog', { name: '故事里的停靠点' }).getByRole('button').filter({ hasText: '清晨的风' })).toHaveCount(1);
  await page.getByRole('dialog', { name: '故事里的停靠点' }).getByRole('button', { name: '关闭', exact: true }).click();
  // A deep position from chapter one must never leak into the next chapter.
  await reader.getByRole('button', { name: '下一章', exact: true }).click();
  await expect(reader.getByRole('heading', { name: '第二章 归途', exact: true })).toBeVisible();
  await expect.poll(async () => (await progress(page))?.paragraphIndex).toBe(0);
  await page.reload();
  await expect(reader.getByRole('heading', { name: '第二章 归途', exact: true })).toBeVisible();
  await reader.getByRole('button', { name: '回到书架', exact: true }).first().click();
  await expect(reader).toHaveCount(0);
  await expect(page.getByRole('button', { name: '阅读 稳定锚点', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('EPUB imports real package/spine/navigation, stays readable and never executes book scripts', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('导入小说文件', { exact: true }).setInputFiles({ name: 'fixture.epub', mimeType: 'application/epub+zip', buffer: await epubNovel() });
  await page.getByRole('button', { name: '阅读 真实 EPUB 测试', exact: true }).click();
  const reader = page.getByRole('dialog', { name: '阅读 真实 EPUB 测试', exact: true });
  await expect(reader.getByText('“Welcome home,” Ada said.', { exact: true })).toBeVisible();
  await expect(reader.getByRole('heading', { name: 'Arrival', exact: true })).toBeVisible();
  expect(await page.evaluate(() => '__epubScriptExecuted' in window)).toBe(false);
  await reader.getByRole('button', { name: '下一章', exact: true }).click();
  await expect(reader.getByRole('heading', { name: 'Homecoming', exact: true })).toBeVisible();
  await expect(reader.getByText('The journey continued in another chapter.', { exact: true })).toBeVisible();
  await page.reload();
  await expect(reader.getByRole('heading', { name: 'Homecoming', exact: true })).toBeVisible();
});

test('installed production PWA reopens books with the network disconnected', async ({ page, context }) => {
  await page.goto('/');
  await importText(page, '离线阅读.txt');
  await page.getByRole('button', { name: '阅读 离线阅读', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '阅读 离线阅读', exact: true })).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready);
  // Prompt-based service workers control the next navigation after their first install.
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('dialog', { name: '阅读 离线阅读', exact: true })).toBeVisible();
  await expect(page.getByText('第1段：清晨的风越过山谷，把远方的消息送到窗前。林晚翻开信纸，慢慢读起了那些久违的字句。她说：“我们明天就出发吧。”', { exact: true })).toBeVisible();
  await context.setOffline(false);
});
