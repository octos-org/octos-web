import {chromium, webkit, expect} from '@playwright/test';
import {writeFile} from 'node:fs/promises';
import {hostname} from 'node:os';
import {setup} from './setup.mjs';

const {c, base, root: output} = await setup('history-order');
const session = process.env.OCTOS_LIVE_REVIEW_SESSION;
if (!session) throw Error('Set OCTOS_LIVE_REVIEW_SESSION to the existing conversation to inspect.');
const engine = process.env.OCTOS_LIVE_REVIEW_BROWSER ?? 'chromium';
const browser = await ({chromium, webkit}[engine]).launch();
const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
page.setDefaultTimeout(30000);
const errors = [], observations = [];
let hydrate, hydrationCount = 0;
page.on('pageerror', error => errors.push(error.message));
page.on('websocket', socket => socket.on('framereceived', frame => {
  try {
    const message = JSON.parse(String(frame.payload));
    if (message.result?.session_id === session && message.result.messages) {
      hydrate = message.result;
      hydrationCount++;
    }
  } catch {}
}));
try {
  await page.goto(base + 'login?redirect=%2Fchat');
  await page.getByTestId('token-input').fill(c.a.token);
  await page.getByTestId('login-button').click();
  await expect(page.getByTestId('chat-input')).toBeVisible();
  await page.getByTestId(`session-item-${session}`).getByTestId('session-switch-button').click();
  for (let cycle = 0; cycle < 3; cycle++) {
    const previousCount = hydrationCount;
    if (cycle > 0) {
      await page.reload();
      await expect.poll(() => hydrationCount).toBeGreaterThan(previousCount);
    } else {
      await expect.poll(() => Boolean(hydrate)).toBe(true);
    }
    const expected = [...hydrate.messages].sort((a, b) => a.seq - b.seq)
      .filter(row => row.role === 'user')
      .map(row => row.client_message_id ?? row.thread_id ?? row.turn_id);
    const rows = page.getByTestId('user-message');
    await expect(rows).toHaveCount(expected.length);
    const actual = await rows.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-thread-id')));
    observations.push({cycle, expectedThreadOrder: expected, actualThreadOrder: actual});
    if (process.env.OCTOS_LIVE_REVIEW_PRIVATE_HYDRATE) {
      await writeFile(process.env.OCTOS_LIVE_REVIEW_PRIVATE_HYDRATE, JSON.stringify(hydrate), {mode: 0o600});
    }
    await writeFile(new URL('observations.json', output), JSON.stringify({browser: engine, observations, errors}, null, 2));
    expect(actual).toEqual(expected);
    expect(new Set(actual).size).toBe(actual.length);
  }
  expect(errors).toEqual([]);
  await writeFile(new URL('results.json', output), JSON.stringify({result: 'PASS', browser: engine,
    runtimeWeb: process.env.OCTOS_LIVE_REVIEW_WEB_COMMIT ?? 'unspecified', runner: hostname(),
    operation: 'Read existing conversation and reload twice; no messages submitted',
    observations, pageErrors: errors}, null, 2));
  console.log(JSON.stringify({result: 'PASS', browser: engine, cycles: observations.length, pageErrors: errors}));
} finally {
  await browser.close();
}
