import { expect, test, type Page } from '@playwright/test';

async function addVolume(page: Page, title: string, line: string) {
  await page.getByLabel('导入小说文件', { exact: true }).setInputFiles({
    name: `${title}.txt`,
    mimeType: 'text/plain',
    buffer: Buffer.from(`第一章 初识\n\n${line}\n\n第二章 雾散\n\n夜色落在井旁。`),
  });
  await page.getByRole('button', { name: `阅读 ${title}`, exact: true }).click();
  const reader = page.getByRole('dialog', { name: `阅读 ${title}`, exact: true });
  await reader.getByRole('button', { name: '人物管理', exact: true }).click();
  const gallery = page.getByRole('dialog', { name: '书中的人物', exact: true });
  await gallery.getByRole('textbox', { name: '添加人物名称', exact: true }).fill('青禾');
  await gallery.getByRole('button', { name: '添加人物', exact: true }).click();
  const card = page.getByRole('dialog', { name: '人物卡片', exact: true });
  await expect(card.getByRole('heading', { name: '青禾', exact: true })).toBeVisible();
  await card.getByRole('button', { name: '关闭', exact: true }).click();
  await reader.locator('.reader-back').click();
  await expect(reader).toHaveCount(0);
}

test('series supports explicit volume order and reversible cross-book associations', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await addVolume(page, '渡口正传', '青禾走向渡口，船头挂着一盏灯。');
  await addVolume(page, '雪夜前传', '这个叫青禾的人提早到达客店。');
  await page.getByRole('button', { name: '书籍系列', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '书籍系列', exact: true });
  await panel.getByRole('textbox', { name: '新系列名称', exact: true }).fill('渡口纪事');
  await panel.getByRole('button', { name: '创建系列', exact: true }).click();
  const available = panel.getByRole('combobox', { name: '添加书籍到系列', exact: true });
  await available.selectOption({ label: '渡口正传' });
  await panel.getByRole('button', { name: '加入系列', exact: true }).click();
  await expect(panel.getByRole('button', { name: '阅读 渡口正传', exact: true })).toBeVisible();
  await available.selectOption({ label: '雪夜前传' });
  await panel.getByRole('button', { name: '加入系列', exact: true }).click();
  await panel.getByRole('button', { name: '上移 雪夜前传', exact: true }).click();
  await expect(panel.locator('.series-volumes .series-book-button')).toHaveText(['雪夜前传', '渡口正传']);

  await panel.getByText('系列人物', { exact: true }).click();
  await panel.getByRole('combobox', { name: '系列人物所属书籍', exact: true }).selectOption({ label: '渡口正传' });
  await panel.getByRole('combobox', { name: '系列人物', exact: true }).selectOption({ label: '青禾' });
  await panel.getByRole('combobox', { name: '关联人物所属书籍', exact: true }).selectOption({ label: '雪夜前传' });
  await panel.getByRole('combobox', { name: '关联人物', exact: true }).selectOption({ label: '青禾' });
  const associate = panel.getByRole('button', { name: '关联为同一人物', exact: true });
  await expect(associate).toBeDisabled();
  await panel.getByRole('checkbox', { name: '确认这是同一个人物', exact: true }).check();
  await expect(panel.getByRole('checkbox', { name: '允许两本书共享各自的本机头像', exact: true })).not.toBeChecked();
  await associate.click();
  const group = panel.getByRole('list', { name: '已确认的跨书人物身份', exact: true });
  await expect(group.getByText('雪夜前传 · 青禾')).toBeVisible();
  await panel.getByRole('button', { name: '解除关联', exact: true }).click();
  await expect(group).toHaveCount(0);
  await panel.getByRole('button', { name: '撤销上次关联修改', exact: true }).click();
  await expect(group.getByText('雪夜前传 · 青禾')).toBeVisible();
  await panel.getByRole('button', { name: '移除系列', exact: true }).click();
  await panel.getByRole('button', { name: '确认移除系列', exact: true }).click();
  await expect(panel.getByRole('combobox', { name: '选择系列', exact: true })).toHaveCount(0);
  await panel.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByRole('button', { name: '阅读 渡口正传', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '阅读 雪夜前传', exact: true })).toBeVisible();
});
