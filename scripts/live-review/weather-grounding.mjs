import {chromium, expect} from '@playwright/test';
import {writeFile} from 'node:fs/promises';
import {hostname} from 'node:os';
import {setup} from './setup.mjs';

const {c, base, root: output} = await setup('weather-grounding');
const browser = await chromium.launch();
const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
page.setDefaultTimeout(30000);
const terminal = new Map(), events = [], errors = [], results = [];
page.on('pageerror', error => errors.push(error.message));
page.on('websocket', socket => socket.on('framereceived', frame => {
  try {
    const e = JSON.parse(String(frame.payload));
    if (e.method !== 'projection/envelope') return;
    const p = e.params;
    if (p.payload.type === 'turn_terminal') terminal.set(p.thread_id, p.payload.data.outcome);
    if (['tool_start', 'tool_end'].includes(p.payload.type)) events.push(p);
  } catch {}
}));
function urls(value) {
  if (value && typeof value === 'object') return Object.values(value).flatMap(urls);
  if (typeof value !== 'string') return [];
  return (value.match(/https?:\/\/[^\s"'<>]+/g) ?? []).flatMap(value => {
    try { return [new URL(value.replace(/[),]+$/, '')).href]; } catch { return []; }
  });
}
async function newChat() {
  await page.getByTestId('new-chat-button').click();
  await page.getByRole('dialog').getByRole('button', {name: /^Chat/}).click();
  await expect(page.getByTestId('user-message')).toHaveCount(0);
}
async function send(prompt, label, followup = false) {
  await page.getByTestId('chat-input').fill(prompt);
  await page.getByTestId('send-button').click();
  const user = page.getByTestId('user-message').filter({hasText: prompt});
  await expect(user).toHaveCount(1, {timeout: 180000});
  const thread = await user.getAttribute('data-thread-id');
  await expect.poll(() => terminal.get(thread), {timeout: 180000}).toBe('completed');
  const responses = page.locator(`[data-testid="assistant-message"][data-thread-id="${thread}"]`);
  const answer = (await responses.locator('.prose').allTextContents()).join('\n');
  const links = await responses.locator('.prose a[href]').evaluateAll(nodes => nodes
    .map(node => node.getAttribute('href')).filter(href => /^https?:\/\//.test(href)));
  const tools = events.filter(e => e.thread_id === thread);
  const starts = tools.filter(e => e.payload.type === 'tool_start');
  const lookups = starts.filter(e => ['web_fetch', 'web_search', 'get_weather'].includes(e.payload.data.name));
  const observedURLs = [...new Set(tools.flatMap(e => urls(e.payload.data)))];
  const supportedLinks = links.filter(href => observedURLs.includes(new URL(href).href));
  const result = {label, answer, characters: answer.length, links, observedURLs, supportedLinks,
    lookupCalls: lookups.length, tables: await responses.locator('table').count()};
  results.push(result);
  await writeFile(new URL('observations.json', output), JSON.stringify({results, pageErrors: errors}, null, 2));
  expect(lookups.length).toBeGreaterThan(0);
  expect(supportedLinks.length).toBeGreaterThan(0);
  if (followup) {
    expect(answer).toContain('北京');
    expect(answer).not.toContain('Saratoga');
    expect(result.tables).toBe(0);
    expect(answer.length).toBeLessThan(700);
  }
  return {result, tools, starts};
}
try {
  await page.goto(base + 'login?redirect=%2Fchat');
  await page.getByTestId('token-input').fill(c.a.token);
  await page.getByTestId('login-button').click();
  await expect(page.getByTestId('chat-input')).toBeVisible();
  await newChat();
  const extraction = await send('用 web_fetch 的 text 模式读取 https://www.weather.com.cn/weather/101020100.shtml，max_chars 设为 4000。根据实际返回的正文，用一句话告诉我上海今天的预报。', 'actual text extraction');
  expect(extraction.starts.some(e => e.payload.data.name === 'web_fetch'
    && /extract_mode[^\n]*text/.test(JSON.stringify(e.payload.data)))).toBe(true);
  const previews = extraction.tools.filter(e => e.payload.type === 'tool_end')
    .map(e => e.payload.data.output_preview ?? '').join('\n');
  expect(previews).toContain('weather.com.cn');
  expect(previews).not.toContain('.xyn-weather-box');
  expect(previews).not.toContain('var pagetype');
  await newChat();
  await send('上海今天的天气如何？', 'natural weather question');
  await send('北京呢', 'natural weather follow-up', true);
  expect(errors).toEqual([]);
  await writeFile(new URL('results.json', output), JSON.stringify({result: 'PASS', runner: hostname(),
    runtimeWeb: process.env.OCTOS_LIVE_REVIEW_WEB_COMMIT ?? 'unspecified',
    runtimeCore: process.env.OCTOS_LIVE_REVIEW_CORE_COMMIT ?? 'unspecified', results, pageErrors: errors,
    limitation: 'Verifies actual lookup and matching inline URLs; numerical weather facts and warning causes require separate source inspection.'}, null, 2));
  console.log(JSON.stringify({result: 'PASS', cases: results.length, pageErrors: errors}));
} finally {
  await browser.close();
}
