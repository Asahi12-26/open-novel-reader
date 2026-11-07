import { test, expect, type Page, type BrowserContext } from '@playwright/test';

const project = 'https://offline-ai.supabase.co';
const publicKey = 'sb_publishable_offline_browser_fixture';
const userId = '00000000-0000-4000-8000-000000000003';
const key = 'fixture-key-not-a-provider-credential';
const bookName = 'V03离线人物验证';

async function mockAccount(page: Page, context: BrowserContext) {
  let statusCalls = 0;
  const requests: { input: { dialogues: { id: string }[] } }[] = [];
  await context.route('https://api.deepseek.com/**', route => route.abort('blockedbyclient'));
  await context.route(`${project}/**`, async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/functions/v1/deepseek-proxy') {
      const body = route.request().postDataJSON();
      if (body.action === 'status') {
        expect(body.apiKey).toBeUndefined(); statusCalls++;
        return route.fulfill({ json: { ready: true, upstreamChecked: false, models: ['deepseek-flash', 'deepseek-v4-pro'], limits: { maxTokens: 4096, maxRequestCostUsd: 0.1 } } });
      }
      expect(body.action).toBe('analyze');
      requests.push(body);
      if (requests.length === 2) return route.fulfill({ status: 503, json: { error: 'OFFLINE_FIXTURE_FAILURE' } });
      return route.fulfill({ json: { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ dialogues: body.input.dialogues.map((item: { id: string }) => ({ id: item.id, speaker: '林青', confidence: 0.96 })) }) } }] } });
    }
    if (url.pathname === '/auth/v1/user') return route.fulfill({ json: { id: userId, aud: 'authenticated', role: 'authenticated', email: 'offline-ai@example.invalid', app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, created_at: new Date().toISOString() } });
    if (url.pathname.startsWith('/rest/v1/')) return route.fulfill({ json: [] });
    return route.fulfill({ status: 400, json: { error: 'OFFLINE_FIXTURE_ONLY' } });
  });
  await page.addInitScript(({ project, publicKey, userId }) => {
    const encode = (value: object) => btoa(JSON.stringify(value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const token = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: userId, exp: expires, role: 'authenticated', aud: 'authenticated' })}.offlinefixture`;
    localStorage.setItem('onr.cloud.public-config', JSON.stringify({ url: project, anonKey: publicKey }));
    localStorage.setItem('onr.auth.offline-ai.supabase.co', JSON.stringify({ access_token: token, refresh_token: 'offline-refresh-fixture', token_type: 'bearer', expires_in: 3600, expires_at: expires, user: { id: userId, aud: 'authenticated', role: 'authenticated', email: 'offline-ai@example.invalid', app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, created_at: new Date().toISOString() } }));
  }, { project, publicKey, userId });
  return { requests, get statusCalls() { return statusCalls; } };
}

async function loadKey(page: Page) {
  await page.getByRole('button', { name: '设置与云同步', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '你的阅读空间', exact: true });
  await settings.getByRole('button', { name: 'AI 模型', exact: true }).click();
  await settings.getByLabel('DeepSeek API Key', { exact: true }).fill(key);
  await settings.getByRole('button', { name: '载入密钥', exact: true }).click();
  await expect(settings.getByRole('button', { name: '清除密钥', exact: true })).toBeEnabled();
  await settings.getByRole('button', { name: '关闭', exact: true }).click();
}

async function openAnalysis(page: Page) {
  const reader = page.getByRole('dialog', { name: `阅读 ${bookName}`, exact: true });
  await reader.getByRole('button', { name: '人物识别', exact: true }).click();
  return page.getByRole('dialog', { name: '听见故事里的人', exact: true });
}

test('offline AI UI requires consent and resumes saved work after reload without resending completed chunks', async ({ page, context }) => {
  test.setTimeout(65000);
  const fixture = await mockAccount(page, context);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const source = `第一章 见面\n\n${Array.from({ length: 13 }, (_, i) => `林青说：“第${i + 1}句话，明天见。”`).join('\n\n')}\n\n第二章 静景\n\n这里是没有对白的安静段落。`;
  await page.getByLabel('导入小说文件', { exact: true }).setInputFiles({ name: `${bookName}.txt`, mimeType: 'text/plain', buffer: Buffer.from(source) });
  await expect(page.getByRole('button', { name: `阅读 ${bookName}`, exact: true })).toBeVisible();
  await page.getByRole('button', { name: '设置与云同步', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '你的阅读空间', exact: true });
  await settings.getByRole('button', { name: 'AI 模型', exact: true }).click();
  await settings.getByRole('button', { name: '检查代理（不调用模型）', exact: true }).click();
  await expect(settings.getByText('代理已连接，登录验证通过。尚未调用 DeepSeek。', { exact: true })).toBeVisible();
  expect(fixture.statusCalls).toBe(1); expect(fixture.requests).toHaveLength(0);
  await settings.getByRole('button', { name: '关闭', exact: true }).click();
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
  expect(fixture.requests[0].input.dialogues).toHaveLength(12);
  expect(fixture.requests[2].input.dialogues.map(item => item.id)).toEqual(fixture.requests[1].input.dialogues.map(item => item.id));
  await page.screenshot({ path: 'artifacts/qa/v03-ai-offline-results.png' });
  await panel.getByRole('button', { name: '在正文查看与纠正', exact: true }).click();
  const reader = page.getByRole('dialog', { name: `阅读 ${bookName}`, exact: true });
  await reader.getByRole('button', { name: '说话人物：林青，点击纠正', exact: true }).first().click();
  await page.getByRole('dialog', { name: '这一句，是谁说的？', exact: true }).getByRole('button', { name: '未知人物', exact: true }).click();
  await expect(reader.locator('.character-tag.manual')).toHaveCount(1);
});
