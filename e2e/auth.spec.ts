import { test, expect } from '@playwright/test';
import { importText } from './helpers';

test('account settings remain usable on a narrow offline device without sending credentials', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await importText(page, '离线账号书架.txt');
  await page.getByRole('button', { name: '关闭提示', exact: true }).click();
  await context.setOffline(true);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '账号与云同步', exact: true }).click();
  const account = page.locator('.account-panel');
  await expect(account.getByRole('heading', { name: '登录阅见', exact: true })).toBeVisible();
  const config = account.locator('.auth-config');
  if (!(await config.getAttribute('open') !== null)) await config.locator('summary').click();
  await expect(account.getByLabel('Supabase 项目地址', { exact: true })).toBeVisible();
  await expect(account.getByLabel('Publishable / anon 公开密钥', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: 'artifacts/qa/auth-v02-mobile.png' });
  await page.getByRole('dialog', { name: '你的阅读空间' }).getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '阅读 离线账号书架', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '阅读 离线账号书架', exact: true })).toBeVisible();
});

test('invalid recovery mail opens its own dialog and never restores a saved reader session', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await importText(page, '恢复入口保护.txt');
  await page.getByRole('button', { name: '关闭提示', exact: true }).click();
  await page.getByRole('button', { name: '阅读 恢复入口保护', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '阅读 恢复入口保护', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => new Promise<string | undefined>((resolve, reject) => {
    const request = indexedDB.open('open-novel-reader');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => { const database = request.result; const read = database.transaction('settings').objectStore('settings').get('readerSession'); read.onsuccess = () => { database.close(); resolve(read.result?.value); }; read.onerror = () => { database.close(); reject(read.error); }; };
  }))).toBeTruthy();
  await page.goto('/?auth=recovery#error=access_denied&error_code=otp_expired');
  await expect(page.getByRole('dialog', { name: '设置新的登录密码', exact: true })).toBeVisible();
  await expect(page.locator('.reader')).toHaveCount(0);
  await expect(page.locator('input[type=password]')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await page.getByRole('dialog', { name: '设置新的登录密码', exact: true }).getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByRole('button', { name: '阅读 恢复入口保护', exact: true })).toBeVisible();
});
