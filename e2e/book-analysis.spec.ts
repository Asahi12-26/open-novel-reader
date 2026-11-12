import { test, expect, type Page, type BrowserContext } from '@playwright/test';

const project = 'https://offline-book.supabase.co';
const publicKey = 'sb_publishable_offline_book_fixture';
const userId = '00000000-0000-4000-8000-000000000004';
const sessionKey = 'fixture-book-key-not-a-provider-credential';
const bookName = 'V04整书离线验证';

interface MockRequest { input: { chapter: string; known: { id: string; name: string }[]; dialogues: { id: string; text: string }[] }; authorized: boolean; maxCostUsd: number }

async function mockAccount(page: Page, context: BrowserContext) {
  const requests: MockRequest[] = [];
  await context.route('https://api.deepseek.com/**', route => route.abort('blockedbyclient'));
  await context.route(`${project}/**`, async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/functions/v1/deepseek-proxy') {
      const body = route.request().postDataJSON();
      if (body.action === 'status') return route.fulfill({ json: { ready: true, protocols: ['identity-v1'], upstreamChecked: false, models: ['deepseek-flash', 'deepseek-v4-pro'], limits: { maxTokens: 4096, maxRequestCostUsd: 0.1 } } });
      expect(body.action).toBe('analyze');
      expect(body.authorized).toBe(true);
      expect(body.maxCostUsd).toBeLessThanOrEqual(.1);
      requests.push(body);
      if (requests.length === 3) return route.fulfill({ status: 503, json: { error: 'OFFLINE_BOOK_FIXTURE_FAILURE' } });
      const speaker = String(body.input.chapter).includes('远行') ? 'Mara' : '林青';
      const knownId = body.input.known.find((person: { name: string }) => person.name === speaker)?.id || null;
      const identityText = '林青又名青鸟。';
      const identities = String(body.input.chapter).includes('约定') && knownId ? [{ characterId: knownId, kind: 'alias', value: '青鸟', evidence: { paragraphIndex: 0, start: 0, end: identityText.length, text: identityText }, confidence: .97 }] : [];
      return route.fulfill({ json: { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ dialogues: body.input.dialogues.map((item: { id: string }) => ({ id: item.id, speaker, characterId: knownId, confidence: .97 })), identities }) } }] } });
    }
    if (url.pathname === '/auth/v1/user') return route.fulfill({ json: { id: userId, aud: 'authenticated', role: 'authenticated', email: 'offline-book@example.invalid', app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, created_at: new Date().toISOString() } });
    if (url.pathname.startsWith('/rest/v1/')) return route.fulfill({ json: [] });
    return route.fulfill({ status: 400, json: { error: 'OFFLINE_FIXTURE_ONLY' } });
  });
  await page.addInitScript(({ project, publicKey, userId }) => {
    const encode = (value: object) => btoa(JSON.stringify(value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const token = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: userId, exp: expires, role: 'authenticated', aud: 'authenticated' })}.offlinefixture`;
    localStorage.setItem('onr.cloud.public-config', JSON.stringify({ url: project, anonKey: publicKey }));
    localStorage.setItem('onr.auth.offline-book.supabase.co', JSON.stringify({ access_token: token, refresh_token: 'offline-book-refresh', token_type: 'bearer', expires_in: 3600, expires_at: expires, user: { id: userId, aud: 'authenticated', role: 'authenticated', email: 'offline-book@example.invalid', app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, created_at: new Date().toISOString() } }));
  }, { project, publicKey, userId });
  return requests;
}

async function loadKey(page: Page) {
  await page.getByRole('button', { name: '设置与云同步', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '你的阅读空间', exact: true });
  await settings.getByRole('button', { name: 'AI 模型', exact: true }).click();
  await settings.getByLabel('DeepSeek API Key', { exact: true }).fill(sessionKey);
  await settings.getByRole('button', { name: '载入密钥', exact: true }).click();
  await expect(settings.getByRole('button', { name: '清除密钥', exact: true })).toBeEnabled();
  await settings.getByRole('button', { name: '关闭', exact: true }).click();
}

async function openBookPanel(page: Page) {
  const reader = page.getByRole('dialog', { name: `阅读 ${bookName}`, exact: true });
  await reader.getByRole('button', { name: '章节人物识别', exact: true }).click();
  await page.getByRole('dialog', { name: '听见故事里的人', exact: true }).getByRole('button', { name: '整书分析', exact: true }).click();
  return page.getByRole('dialog', { name: '整本书深度分析', exact: true });
}

test('whole-book consent advances chapters, restores checkpoints, protects manual edits and hides future characters', async ({ page, context }) => {
  test.setTimeout(100_000);
  const requests = await mockAccount(page, context);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const prose = Array.from({ length: 16 }, (_, i) => `第${i + 1}段。${'这是用于检查阅读位置的原创安静段落，没有人物对白。'.repeat(5)}`).join('\n\n');
  const source = `第一章 初识\n\n林青说：“今天先整理地图。”\n\n${prose}\n\n第二章 约定\n\n林青又名青鸟。林青说：“明天我会准时到。”\n\n第三章 远行\n\nMara said, "I will bring the compass tomorrow."`;
  await page.getByLabel('导入小说文件', { exact: true }).setInputFiles({ name: `${bookName}.txt`, mimeType: 'text/plain', buffer: Buffer.from(source) });
  await expect(page.getByRole('button', { name: `阅读 ${bookName}`, exact: true })).toBeVisible();
  await loadKey(page);
  await page.getByRole('button', { name: `阅读 ${bookName}`, exact: true }).click();
  let panel = await openBookPanel(page);
  await expect(panel.getByRole('combobox', { name: '整书分析范围', exact: true })).toHaveValue('reading-progress');
  await panel.getByRole('combobox', { name: '整书分析范围', exact: true }).selectOption('deep');
  await expect(panel.getByRole('button', { name: '授权并开始整书分析', exact: true })).toBeDisabled();
  await expect(panel.getByText('全书范围', { exact: true })).toBeVisible();
  await expect(panel.getByRole('combobox', { name: '整书分析范围', exact: true })).toHaveValue('deep');
  expect(requests).toHaveLength(0);
  await panel.getByRole('checkbox', { name: '授权整书任务', exact: true }).check();
  await panel.getByRole('button', { name: '授权并开始整书分析', exact: true }).click();
  await expect(panel.getByText('任务已安全停止', { exact: true })).toBeVisible();
  expect(requests).toHaveLength(3);
  expect(requests[0].input.chapter).toContain('初识');
  expect(requests[1].input.chapter).toContain('约定');
  expect(requests[1].input.known).toEqual(expect.arrayContaining([expect.objectContaining({ id: expect.any(String), name: '林青' })]));
  expect(requests[2].input.chapter).toContain('远行');
  await expect(panel.getByRole('checkbox', { name: '授权整书任务', exact: true })).not.toBeChecked();
  await expect(panel.getByRole('button', { name: '授权并继续整书任务', exact: true })).toBeDisabled();
  await panel.getByRole('button', { name: '关闭', exact: true }).click();
  let reader = page.getByRole('dialog', { name: `阅读 ${bookName}`, exact: true });
  const firstSpeaker = reader.locator('.character-tag').first();
  await reader.locator('.reader-scroller').hover();
  await page.mouse.wheel(0, 650);
  await expect(firstSpeaker).toHaveAccessibleName('说话人物：林青，点击纠正');
  await firstSpeaker.click();
  await page.getByRole('dialog', { name: '这一句，是谁说的？', exact: true }).getByRole('button', { name: '未知人物', exact: true }).click();
  await expect(reader.locator('.character-tag.manual')).toHaveCount(1);
  await reader.getByRole('navigation').getByRole('button', { name: /第一章 初识/ }).click();
  await expect(reader.locator('.reader-scroller')).toHaveJSProperty('scrollTop', 0);
  await page.reload();
  panel = await openBookPanel(page);
  await expect(panel.getByText('任务已安全停止', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: '授权并继续整书任务', exact: true })).toBeDisabled();
  await expect(panel.getByRole('spinbutton', { name: '整书任务累计总预算（美元）', exact: true })).toBeDisabled();
  await panel.getByRole('checkbox', { name: '授权整书任务', exact: true }).check();
  await expect(panel.getByRole('button', { name: '授权并继续整书任务', exact: true })).toBeDisabled();
  expect(requests).toHaveLength(3);
  await panel.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '回到书架', exact: true }).click();
  await loadKey(page);
  await page.getByRole('button', { name: `阅读 ${bookName}`, exact: true }).click();
  panel = await openBookPanel(page);
  await panel.getByRole('checkbox', { name: '授权整书任务', exact: true }).check();
  await panel.getByRole('button', { name: '授权并继续整书任务', exact: true }).click();
  await expect(panel.getByText('整书分析完成', { exact: true })).toBeVisible();
  expect(requests).toHaveLength(4);
  expect(requests[3].input.dialogues.map(row => row.id)).toEqual(requests[2].input.dialogues.map(row => row.id));
  await panel.getByRole('button', { name: '返回阅读并保留结果', exact: true }).click();
  reader = page.getByRole('dialog', { name: `阅读 ${bookName}`, exact: true });
  await expect(reader.locator('.character-tag.manual')).toHaveCount(1);
  await expect(reader.getByRole('button', { name: '说话人物：未知，点击纠正', exact: true }).first()).toBeVisible();
  await reader.getByRole('button', { name: '人物管理', exact: true }).click();
  const people = page.getByRole('dialog', { name: '书中的人物', exact: true });
  const futureAlias = people.getByRole('button', { name: '移除 林青 的别名 青鸟', exact: true });
  await expect(people.getByRole('textbox', { name: '人物 Mara 名称', exact: true })).toHaveCount(0);
  await expect(futureAlias).toHaveCount(0);
  await people.getByRole('checkbox', { name: '显示全书人物信息（可能剧透）', exact: true }).check();
  await expect(people.getByRole('textbox', { name: '人物 Mara 名称', exact: true })).toBeVisible();
  await expect(futureAlias).toBeVisible();
  await people.getByRole('checkbox', { name: '显示全书人物信息（可能剧透）', exact: true }).uncheck();
  await expect(people.getByRole('textbox', { name: '人物 Mara 名称', exact: true })).toHaveCount(0);
  await expect(futureAlias).toHaveCount(0);
  await people.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '查看整书任务', exact: true }).click();
  panel = page.getByRole('dialog', { name: '整本书深度分析', exact: true });
  await page.screenshot({ path: 'artifacts/qa/v04-book-analysis-offline-results.png' });

  // A new, explicitly authorized reading-session task can wait without fees and follow scrolling.
  await panel.getByRole('button', { name: '新建整书任务', exact: true }).click();
  await panel.getByRole('combobox', { name: '整书分析范围', exact: true }).selectOption('reading-progress');
  await panel.getByRole('checkbox', { name: '授权整书任务', exact: true }).check();
  await panel.getByRole('button', { name: '授权并开始整书分析', exact: true }).click();
  await expect(panel.getByText('等待阅读推进', { exact: true })).toBeVisible();
  expect(requests).toHaveLength(4);
  await panel.getByRole('button', { name: '返回阅读并继续任务', exact: true }).click();
  await reader.locator('.reader-scroller').hover();
  await page.mouse.wheel(0, 1100);
  await expect.poll(() => requests.length).toBe(5);
  expect(requests[4].input.chapter).toContain('初识');
  expect(requests[4].input.dialogues.map(row => row.id)).toEqual(requests[0].input.dialogues.map(row => row.id));
  expect(JSON.stringify(requests[4].input)).not.toMatch(/青鸟|Mara/);
  await expect(page.getByRole('complementary', { name: '整书分析任务', exact: true }).getByText('等待阅读推进', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '停止整书分析会话', exact: true }).click();
  await reader.getByRole('button', { name: '下一章', exact: true }).click();
  await expect(reader.getByRole('heading', { name: '第二章 约定', exact: true })).toBeVisible();
  expect(requests).toHaveLength(5);
});
