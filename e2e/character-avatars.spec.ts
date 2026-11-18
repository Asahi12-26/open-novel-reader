import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const bookTitle = '纸上同行';
const title = `阅读 ${bookTitle}`;
const firstChapter = '第一章 渡口';
const secondChapter = '第二章 对岸';

async function prepareBook(page: Page) {
  await page.goto('/');
  const source = `${firstChapter}\n\n“先等雾散。”林青说。“船已经到了。”孟禾说。\n\n河面漂来一片叶子。\n\n${secondChapter}\n\n“系好缆绳。”林青说。“我去取灯。”苏远说。`;
  await page.getByLabel('导入小说文件', { exact: true }).setInputFiles({
    name: `${bookTitle}.txt`,
    mimeType: 'text/plain',
    buffer: Buffer.from(source),
  });
  const openBook = page.getByRole('button', { name: title, exact: true });
  await expect(openBook).toBeVisible();
  // Seed results from a previous recognition session so the browser test never contacts an AI provider.
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('open-novel-reader');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const tx = database.transaction(['chapters', 'characters', 'dialogues'], 'readwrite');
      tx.oncomplete = () => { database.close(); resolve(); };
      tx.onerror = () => { database.close(); reject(tx.error); };
      const chapters = tx.objectStore('chapters').getAll();
      chapters.onsuccess = () => {
        const sorted = chapters.result.sort((a, b) => a.index - b.index);
        const bookId = sorted[0].bookId as string;
        const ids = ['lin', 'meng', 'su'].map(id => `${bookId}:fixture:${id}`);
        ['林青', '孟禾', '苏远'].forEach((name, index) => tx.objectStore('characters').put({
          id: ids[index], bookId, name, aliases: [],
          identity: { version: 1, initialName: name, introducedAt: { chapterIndex: index === 2 ? 1 : 0, paragraphIndex: 0, offset: 0 }, events: [] },
        }));
        sorted.forEach((chapter, chapterIndex) => {
          const paragraph = chapter.paragraphs[0] as string;
          [...paragraph.matchAll(/“([^”]+)”/g)].forEach((match, index) => {
            const start = match.index! + 1;
            const text = match[1];
            tx.objectStore('dialogues').put({
              id: `${chapter.id}:fixture:${index}`, bookId, chapterId: chapter.id,
              paragraphIndex: 0, start, end: start + text.length, text,
              characterId: ids[index === 0 ? 0 : chapterIndex === 0 ? 1 : 2], confidence: 0.98, source: 'ai', updatedAt: Date.now(),
            });
          });
        });
      };
    };
  }));
  await openBook.click();
  return page.getByRole('dialog', { name: title, exact: true });
}

async function portraitFixture(page: Page) {
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 420;
    canvas.height = 280;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#32645b';
    ctx.fillRect(0, 0, 420, 280);
    ctx.fillStyle = '#e7c18b';
    ctx.beginPath();
    ctx.arc(180, 140, 82, 0, 2 * Math.PI);
    ctx.fill();
    return canvas.toDataURL('image/png').split(',')[1];
  });
  return { name: 'fixture.png', mimeType: 'image/png', buffer: Buffer.from(base64, 'base64') };
}

test('portrait upload and manual dialogue changes persist across chapters, offline restart and backup restore', async ({ page, context, browser }, info) => {
  test.skip(info.project.name === 'mobile', 'The desktop flow verifies backup download and restore.');
  test.setTimeout(80_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reader = await prepareBook(page);
  const inline = reader.locator('.dialogue-avatar-trigger');
  const gallery = page.getByRole('dialog', { name: '书中的人物', exact: true });
  const detail = page.getByRole('dialog', { name: '人物卡片', exact: true });
  await expect(reader.getByRole('heading', { name: firstChapter, exact: true })).toBeVisible();
  await expect(inline).toHaveCount(2);
  await expect(inline.nth(0)).toHaveAccessibleName('查看人物 林青 的头像与资料');
  await expect(inline.nth(1)).toHaveAccessibleName('查看人物 孟禾 的头像与资料');
  await expect(reader.locator('[data-paragraph="1"] .dialogue-avatar-trigger')).toHaveCount(0);
  await inline.nth(0).click();
  await expect(detail).toBeVisible();
  await detail.getByLabel('选择人物头像图片', { exact: true }).setInputFiles(await portraitFixture(page));
  await detail.getByRole('slider', { name: '头像缩放', exact: true }).fill('1.4');
  await detail.getByRole('button', { name: '保存头像', exact: true }).click();
  await expect(detail.locator('img[src^="blob:"]').first()).toBeVisible();
  await detail.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(inline.nth(0).locator('img')).toBeVisible();
  await expect(inline.nth(1).locator('img')).toHaveCount(0);

  await reader.getByRole('button', { name: '人物管理', exact: true }).click();
  await expect(gallery.getByRole('button', { name: '查看人物 苏远', exact: true })).toHaveCount(0);
  await gallery.getByRole('button', { name: '查看人物 林青', exact: true }).click();
  const rename = detail.getByRole('textbox', { name: '人物 林青 名称', exact: true });
  await rename.fill('林青岩');
  await detail.getByRole('button', { name: '保存名称', exact: true }).click();
  await expect(detail.getByRole('textbox', { name: '人物 林青岩 名称', exact: true })).toHaveValue('林青岩');
  await page.screenshot({ path: 'artifacts/qa/v05-character-profile.png' });
  await detail.getByRole('button', { name: '关闭', exact: true }).click();

  await reader.getByRole('button', { name: '说话人物：孟禾，点击纠正', exact: true }).click();
  const correction = page.getByRole('dialog', { name: '这一句，是谁说的？', exact: true });
  await correction.getByRole('button', { name: '林青岩', exact: true }).click();
  await expect(inline.nth(1)).toHaveAccessibleName('查看人物 林青岩 的头像与资料');
  await expect(inline.nth(1).locator('img')).toBeVisible();
  await reader.getByRole('button', { name: '说话人物：林青岩，点击纠正', exact: true }).last().click();
  await correction.getByRole('textbox', { name: '新人物名称', exact: true }).fill('新来的船工');
  await correction.getByRole('button', { name: '新建并指定', exact: true }).click();
  await expect(inline.nth(1)).toHaveAccessibleName('查看人物 新来的船工 的头像与资料');
  await expect(inline.nth(1).locator('img')).toHaveCount(0);

  await inline.nth(0).click();
  await detail.getByText('合并人物', { exact: true }).click();
  await detail.getByRole('combobox', { name: '合并 林青岩', exact: true }).selectOption({ label: '孟禾' });
  await detail.getByRole('button', { name: '确认合并', exact: true }).click();
  await expect(detail.getByRole('heading', { name: '孟禾', exact: true })).toBeVisible();
  await expect(detail.locator('img[src^="blob:"]').first()).toBeVisible();
  await detail.getByText('身份变更记录', { exact: false }).first().click();
  await expect(detail.getByText('合并保留的头像', { exact: true })).toBeVisible();
  await detail.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(inline.nth(0)).toHaveAccessibleName('查看人物 孟禾 的头像与资料');
  await reader.getByRole('button', { name: '下一章', exact: true }).click();
  await expect(reader.getByRole('heading', { name: secondChapter, exact: true })).toBeVisible();
  await expect(inline.nth(0)).toHaveAccessibleName('查看人物 孟禾 的头像与资料');
  await expect(inline.nth(0).locator('img')).toBeVisible();
  await reader.getByRole('button', { name: '阅读排版设置', exact: true }).click();
  const setting = reader.getByRole('checkbox', { name: '显示对白人物头像', exact: true });
  await setting.uncheck();
  await expect(inline).toHaveCount(0);
  await expect(reader.getByRole('button', { name: '说话人物：孟禾，点击纠正', exact: true })).toBeVisible();
  await setting.check();
  await reader.getByRole('button', { name: '关闭排版设置', exact: true }).click();

  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(reader.getByRole('heading', { name: secondChapter, exact: true })).toBeVisible();
  await expect(inline.nth(0).locator('img')).toBeVisible();
  await context.setOffline(false);
  await reader.locator('.reader-back').click();

  await page.evaluate(() => Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true }));
  await page.getByRole('button', { name: '备份或恢复书库', exact: true }).click();
  const exported = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出完整 ZIP', exact: true }).click();
  const download = await exported;
  expect(download.suggestedFilename()).toMatch(/\.zip$/);
  const backup = await readFile((await download.path())!);
  const restored = await browser.newPage({ reducedMotion: 'reduce' });
  try {
    await restored.goto('/');
    await restored.getByRole('button', { name: '备份或恢复书库', exact: true }).click();
    await restored.getByLabel('恢复备份文件', { exact: true }).setInputFiles({ name: 'library-backup.zip', mimeType: 'application/zip', buffer: backup });
    await restored.getByRole('radio', { name: '替换本机书库', exact: true }).check();
    await expect(restored.getByRole('button', { name: '确认替换并恢复', exact: true })).toBeDisabled();
    await restored.getByRole('radio', { name: '合并到本机书库', exact: true }).check();
    await restored.getByRole('button', { name: '合并并恢复', exact: true }).click();
    await expect(restored.getByText('备份已恢复', { exact: true })).toBeVisible();
    await restored.getByRole('dialog', { name: '你的阅读空间', exact: true }).getByRole('button', { name: '关闭', exact: true }).click();
    const restoredReader = restored.getByRole('dialog', { name: title, exact: true });
    if (!(await restoredReader.isVisible())) await restored.getByRole('button', { name: title, exact: true }).click();
    await expect(restoredReader.getByRole('heading', { name: secondChapter, exact: true })).toBeVisible();
    await expect(restoredReader.locator('.dialogue-avatar-trigger').nth(0).locator('img')).toBeVisible();
  } finally {
    await restored.close();
  }
});

test('touch portrait controls and character cards fit a narrow reader', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'Uses mobile touch input.');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reader = await prepareBook(page);
  const portrait = reader.getByRole('button', { name: '查看人物 林青 的头像与资料', exact: true });
  await portrait.tap();
  const detail = page.getByRole('dialog', { name: '人物卡片', exact: true });
  await detail.getByLabel('选择人物头像图片', { exact: true }).setInputFiles(await portraitFixture(page));
  await detail.getByRole('button', { name: '保存头像', exact: true }).tap();
  await expect(detail.locator('img[src^="blob:"]').first()).toBeVisible();
  await expect.poll(() => detail.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: 'artifacts/qa/v05-mobile-character-profile.png' });
  await detail.getByRole('button', { name: '关闭', exact: true }).tap();
  await expect(portrait.locator('img')).toBeVisible();
  await portrait.tap();
  await detail.getByRole('button', { name: '恢复默认头像', exact: true }).tap();
  await expect(page.getByText('已恢复默认头像。', { exact: true })).toBeVisible();
  await detail.getByRole('button', { name: '关闭', exact: true }).tap();
  await expect(portrait.locator('img')).toHaveCount(0);
  await reader.getByRole('button', { name: '说话人物：林青，点击纠正', exact: true }).tap();
  await page.getByRole('dialog', { name: '这一句，是谁说的？', exact: true }).getByRole('button', { name: '未知人物', exact: true }).tap();
  await expect(reader.getByRole('button', { name: '未知人物头像，点击纠正', exact: true })).toBeVisible();
});
