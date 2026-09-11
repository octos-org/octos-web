import {chromium, expect} from '@playwright/test';
import {writeFile} from 'node:fs/promises';
import {hostname} from 'node:os';
import {setup} from './setup.mjs';

const {c, base, root: output} = await setup('queue-scope');
const browser = await chromium.launch();
const main = await browser.newPage(), observer = await browser.newPage();
const marker = `LIVE_SCOPE_${Date.now()}`;
const terminals = new Map(), errors = [];
let started;
for (const page of [main, observer]) {
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => socket.on('framereceived', frame => {
    try {
      const event = JSON.parse(String(frame.payload));
      if (event.method !== 'projection/envelope') return;
      const {thread_id: thread, payload} = event.params;
      if (payload.type === 'turn_terminal') terminals.set(thread, {outcome: payload.data.outcome, error: payload.data.error, at: Date.now()});
      if (payload.type === 'tool_start' && /^(bash|shell|shell_exec|exec_command)$/.test(payload.data.name)
        && JSON.stringify(payload.data).includes('sleep 12')) started = {thread, at: Date.now(), tool: payload.data.name};
    } catch {}
  }));
}
async function login(page) {
  await page.goto(base + 'login?redirect=%2Fchat');
  await page.getByTestId('token-input').fill(c.a.token);
  await page.getByTestId('login-button').click();
  await expect(page.getByTestId('chat-input')).toBeVisible();
}
async function newChat(page) {
  await page.getByTestId('new-chat-button').click();
  await page.getByRole('dialog').getByRole('button', {name: /^Chat/}).click();
  await expect(page.getByTestId('user-message')).toHaveCount(0);
  return page.evaluate(() => localStorage.getItem('octos_current_session'));
}
async function send(page, text) {
  await page.getByTestId('chat-input').fill(text);
  await page.getByTestId('send-button').click();
}
function reply(page, text) {
  return page.getByTestId('assistant-message').filter({has: page.getByText(text, {exact: true})});
}
try {
  await login(main);
  const oldSession = await newChat(main);
  // A blank local chat is not discoverable by a fresh browser until its first
  // turn is durable. Seed it before attaching the independent observer.
  await send(main, `Reply exactly ${marker}_READY. Do not use tools.`);
  await expect(reply(main, `${marker}_READY`)).toHaveCount(1, {timeout: 120000});
  const readyThread = await reply(main, `${marker}_READY`).getAttribute('data-thread-id');
  await expect.poll(() => terminals.get(readyThread)?.outcome).toBe('completed');
  await login(observer);
  await observer.getByTestId(`session-item-${oldSession}`).getByTestId('session-switch-button').click();
  await send(main, `Use the shell tool to run sleep 12, then reply exactly ${marker}_OLD. This is an authorized isolated responsiveness check.`);
  await expect.poll(() => Boolean(started), {timeout: 120000}).toBe(true);
  await send(main, `Reply exactly ${marker}_QUEUED. Do not use tools.`);
  const newSession = await newChat(main);
  expect(newSession).not.toBe(oldSession);
  await send(main, `Reply exactly ${marker}_NEW. Do not use tools.`);
  await expect(reply(main, `${marker}_NEW`)).toHaveCount(1, {timeout: 120000});
  // Observe the actual terminal after switching. The foreground protocol may
  // cancel work when its submitting connection closes; report that outcome
  // explicitly instead of counting an arbitrary delay as successful work.
  await expect.poll(() => Boolean(terminals.get(started.thread)), {timeout: 120000}).toBe(true);
  const oldTerminal = terminals.get(started.thread);
  if (oldTerminal.outcome === 'completed') {
    await expect(reply(observer, `${marker}_OLD`)).toHaveCount(1);
  } else {
    expect(['errored', 'interrupted']).toContain(oldTerminal.outcome);
    expect(oldTerminal.error?.message ?? '').toMatch(/connection closed before turn completed|interrupt|cancel/i);
  }
  expect(await main.evaluate(() => localStorage.getItem('octos_current_session'))).toBe(newSession);
  await expect(reply(main, `${marker}_OLD`)).toHaveCount(0);
  await expect(main.getByTestId('user-message').filter({hasText: `${marker}_QUEUED`})).toHaveCount(0);
  await expect(observer.getByTestId('user-message').filter({hasText: `${marker}_QUEUED`})).toHaveCount(0);
  await main.reload();
  await expect(reply(main, `${marker}_NEW`)).toHaveCount(1);
  await expect(reply(main, `${marker}_OLD`)).toHaveCount(0);
  expect(errors).toEqual([]);
  const result = {result: 'PASS', runner: hostname(), runtimeWeb: process.env.OCTOS_LIVE_REVIEW_WEB_COMMIT ?? 'unspecified',
    actualDelayedTool: started.tool, oldTurnOutcome: oldTerminal.outcome, oldTurnError: oldTerminal.error,
    elapsedFromToolStartMs: oldTerminal.at - started.at,
    newSessionPreserved: true, queuedMessageStayedCancelled: true, reloadedNewReplyCount: 1, pageErrors: errors};
  await writeFile(new URL('results.json', output), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await browser.close(); }
