import { test, expect } from '@playwright/test';
import { importText } from './helpers';

test('mobile touch layout imports and reads without horizontal overflow', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '导入', exact: true })).toBeVisible();
  await importText(page, '随身书架.txt');
  await page.getByRole('button', { name: '关闭提示', exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: 'test-results/mobile-bookshelf.png', fullPage: true });
  await page.getByRole('button', { name: '阅读 随身书架', exact: true }).tap();
  const reader = page.getByRole('dialog', { name: '阅读 随身书架', exact: true });
  await expect(reader.getByRole('heading', { name: '第一章 山间来信', exact: true })).toBeVisible();
  await reader.getByRole('button', { name: '展开目录', exact: true }).tap();
  await reader.locator('.toc-list').getByRole('button').filter({ hasText: '第二章 归途' }).tap();
  await expect(reader.getByRole('heading', { name: '第二章 归途', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect((await reader.boundingBox())!.y).toBe(0);
  await page.screenshot({ path: 'test-results/mobile-reader.png' });
  await reader.getByRole('button', { name: '返回书架', exact: true }).tap();
  await expect(reader).toHaveCount(0);
  await expect(page.getByRole('button', { name: '阅读 随身书架', exact: true })).toBeVisible();
});
