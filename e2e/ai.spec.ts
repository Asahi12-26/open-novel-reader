import { test, expect, type Page, type BrowserContext } from '@playwright/test';

const key = 'fixture-key-not-a-provider-credential';
const bookName = 'V03离线人物验证';

async function mockProvider(context: BrowserContext) {
  let modelCalls = 0;
  let otherExternalCalls = 0;
  const requests: { input: { dialogues: { id: string }[] } }[] = [];
  await context.route('https://**/*', route => { otherExternalCalls++; return route.abort('blockedbyclient'); });
  await context.route('https://api.deepseek.com/models', async route => {
    expect(route.request().method()).toBe('GET');
    expect(await route.request().headerValue('authorization')).toBe(`Bearer ${key}`);
    expect(route.request().postData()).toBeNull();
    modelCalls++;
    return route.fulfill({ json: { data: [{ id: 'deepseek-flash' }] } });
  });
  await context.route('https://api.deepseek.com/chat/completions', async route => {
    const request = route.request();
    expect(request.method()).toBe('POST');
    expect(await request.headerValue('authorization')).toBe(`Bearer ${key}`);
    expect(request.postData()).not.toContain(key);
    const body = request.postDataJSON();
    expect(body).toMatchObject({ model: 'deepseek-flash', max_tokens: 4096, stream: false });
    const input = JSON.parse(body.messages[1].content);
    requests.push({ input });
    if (requests.length === 2) return route.fulfill({ status: 503, json: { error: 'OFFLINE_FIXTURE_FAILURE' } });
    return route.fulfill({ json: { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ dialogues: input.dialogues.map((item: { id: string }) => ({ id: item.id, speaker: '林青', confidence: 0.96 })) }) } }] } });
  });
  return { requests, get modelCalls() { return modelCalls; }, get otherExternalCalls() { return otherExternalCalls; } };
}

async function loadKey(page: Page) {
  await page.getByRole('button', { name: '应用设置', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '你的阅读空间', exact: true });
  await settings.getByRole('button', { name: 'AI 配置', exact: true }).click();
  await settings.getByLabel('DeepSeek API Key', { exact: true }).fill(key);
  await settings.getByRole('button', { name: '载入密钥', exact: true }).click();
  await expect(settings.getByRole('button', { name: '清除密钥', exact: true })).toBeEnabled();
  await settings.getByRole('button', { name: '关闭', exact: true }).click();
}

async function openAnalysis(page: Page) {
  const reader = page.getByRole('dialog', { name: `阅读 ${bookName}`, exact: true });
  await reader.getByRole('button', { name: '章节人物识别', exact: true }).click();
  return page.getByRole('dialog', { name: '听见故事里的人', exact: true });
}

test('guest BYOK guide makes only the explicit read-only provider check and clears the key on reload', async ({ page, context }) => {
  const fixture = await mockProvider(context);
  await page.goto('/');
  await page.getByRole('button', { name: '按需配置 AI', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '你的阅读空间', exact: true });
  const field = dialog.getByLabel('DeepSeek API Key', { exact: true });
  const checkModel = dialog.getByRole('button', { name: '测试连接（仅查询模型）', exact: true });
  await expect(dialog.getByRole('heading', { name: '模型与预算', exact: true })).toBeVisible();
  await expect(checkModel).toBeDisabled();
  await field.fill(key);
  await dialog.getByRole('button', { name: '载入密钥', exact: true }).click();
  await expect(field).toHaveValue('');
  await expect(dialog.getByText('已载入当前会话', { exact: true })).toBeVisible();
  expect(fixture.modelCalls).toBe(0);
  await checkModel.click();
  await expect(dialog.getByText('模型查询成功，可用模型 DeepSeek Flash。本次未生成文本。', { exact: true })).toBeVisible();
  expect(fixture.otherExternalCalls).toBe(0);
  expect(fixture.modelCalls).toBe(1);
  expect(fixture.requests).toHaveLength(0);
  await page.reload();
  await page.getByRole('button', { name: '按需配置 AI', exact: true }).click();
  await expect(field).toHaveValue('');
  await expect(dialog.getByText('尚未载入密钥', { exact: true })).toBeVisible();
  await expect(checkModel).toBeDisabled();
});

test('offline AI UI requires consent and resumes saved work after reload without resending completed chunks', async ({ page, context }) => {
  test.setTimeout(65000);
  const fixture = await mockProvider(context);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const source = `第一章 见面\n\n${Array.from({ length: 13 }, (_, i) => `林青说：“第${i + 1}句话，明天见。”`).join('\n\n')}\n\n第二章 静景\n\n这里是没有对白的安静段落。`;
  await page.getByLabel('导入小说文件', { exact: true }).setInputFiles({ name: `${bookName}.txt`, mimeType: 'text/plain', buffer: Buffer.from(source) });
  await expect(page.getByRole('button', { name: `阅读 ${bookName}`, exact: true })).toBeVisible();
  expect(fixture.otherExternalCalls).toBe(0); expect(fixture.requests).toHaveLength(0);
  await loadKey(page);
  await page.getByRole('button', { name: `阅读 ${bookName}`, exact: true }).click();
  let panel = await openAnalysis(page);
  await panel.getByRole('combobox', { name: '选择分析章节', exact: true }).selectOption({ label: '2. 第二章 静景' });
  await expect(panel.getByRole('button', { name: '授权并分析所选章节', exact: true })).toBeDisabled();
  await panel.getByRole('combobox', { name: '选择分析章节', exact: true }).selectOption({ label: '1. 第一章 见面' });
  await expect(panel.getByRole('button', { name: '授权并分析所选章节', exact: true })).toBeDisabled();
  expect(fixture.requests).toHaveLength(0);
  await panel.getByRole('checkbox').check();
  await panel.getByRole('button', { name: '授权并分析所选章节', exact: true }).click();
  await expect(panel.getByText('分析失败', { exact: true })).toBeVisible();
  await expect(panel.getByText(/12 句对白 · 12 句已归属/)).toBeVisible();
  expect(fixture.requests).toHaveLength(2);
  await expect(panel.getByRole('checkbox')).not.toBeChecked();
  await expect(panel.getByRole('button', { name: '从上次进度继续', exact: true })).toBeDisabled();
  await panel.getByRole('combobox', { name: '选择分析章节', exact: true }).selectOption({ label: '2. 第二章 静景' });
  await expect(panel.getByRole('region', { name: '已保存的人物识别结果', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: '从上次进度继续', exact: true })).toHaveCount(0);
  await panel.getByRole('combobox', { name: '选择分析章节', exact: true }).selectOption({ label: '1. 第一章 见面' });
  await expect(panel.getByText('分析失败', { exact: true })).toBeVisible();
  await expect(panel.getByText(/12 句对白 · 12 句已归属/)).toBeVisible();
  await page.reload();
  await expect(page.getByRole('dialog', { name: `阅读 ${bookName}`, exact: true })).toBeVisible();
  panel = await openAnalysis(page);
  await expect(panel.getByText('分析失败', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: '从上次进度继续', exact: true })).toBeDisabled();
  await panel.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '回到书架', exact: true }).click();
  await loadKey(page);
  await page.getByRole('button', { name: `阅读 ${bookName}`, exact: true }).click();
  panel = await openAnalysis(page);
  await panel.getByRole('checkbox').check();
  await panel.getByRole('button', { name: '从上次进度继续', exact: true }).click();
  await expect(panel.getByText('识别完成', { exact: true })).toBeVisible();
  await expect(panel.getByText(/13 句对白 · 13 句已归属/)).toBeVisible();
  expect(fixture.requests).toHaveLength(3);
  expect(fixture.otherExternalCalls).toBe(0);
  expect(fixture.requests[0].input.dialogues).toHaveLength(12);
  expect(fixture.requests[2].input.dialogues.map(item => item.id)).toEqual(fixture.requests[1].input.dialogues.map(item => item.id));
  await page.screenshot({ path: 'artifacts/qa/v03-ai-offline-results.png' });
  await panel.getByRole('button', { name: '在正文查看与纠正', exact: true }).click();
  const reader = page.getByRole('dialog', { name: `阅读 ${bookName}`, exact: true });
  await reader.getByRole('button', { name: '说话人物：林青，点击纠正', exact: true }).first().click();
  await page.getByRole('dialog', { name: '这一句，是谁说的？', exact: true }).getByRole('button', { name: '未知人物', exact: true }).click();
  await expect(reader.locator('.character-tag.manual')).toHaveCount(1);
});
