import {chromium, expect} from '@playwright/test';
import {writeFile} from 'node:fs/promises';
import {hostname} from 'node:os';
import {setup} from './setup.mjs';

const {c, base, root: output} = await setup('citation-links');
const session = process.env.OCTOS_LIVE_REVIEW_SESSION;
const source = process.env.OCTOS_LIVE_REVIEW_SOURCE_URL;
if (!session || !source) throw Error('Set the existing session and expected public source URL.');
const browser = await chromium.launch();
const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
const errors = [];
const sourceRequests = [], sourceResponses = [];
page.on('pageerror', error => errors.push(error.message));
page.context().on('request', request => {
  if (request.isNavigationRequest() && request.url() === source) sourceRequests.push(request.url());
});
page.context().on('response', response => {
  if (response.request().isNavigationRequest() && response.url() === source) sourceResponses.push(response.status());
});
page.setDefaultTimeout(30000);
try {
  await page.goto(base + 'login?redirect=%2Fchat');
  await page.getByTestId('token-input').fill(c.a.token);
  await page.getByTestId('login-button').click();
  await expect(page.getByTestId('chat-input')).toBeVisible();
  await page.getByTestId(`session-item-${session}`).getByTestId('session-switch-button').click();
  const link = page.getByTestId('assistant-message').locator('.prose a').filter({hasText: source});
  for (let cycle = 0; cycle < 3; cycle++) {
    if (cycle) await page.reload();
    await expect(link).toHaveCount(1);
    await expect(link).toHaveAttribute('href', source);
    await expect(link).toHaveText(source);
  }
  const popupPromise = page.waitForEvent('popup');
  await link.click();
  const popup = await popupPromise;
  await popup.waitForLoadState('domcontentloaded');
  expect(sourceRequests).toContain(source);
  const destinationContainsLocation = (await popup.locator('body').innerText()).includes('上海');
  await page.screenshot({path: new URL('persisted-citation.png', output).pathname, animations: 'disabled'});
  expect(errors).toEqual([]);
  const result = {result: 'PASS', runner: hostname(), runtimeWeb: process.env.OCTOS_LIVE_REVIEW_WEB_COMMIT,
    runtimeCore: process.env.OCTOS_LIVE_REVIEW_CORE_COMMIT, operation: 'Read the existing failed answer and reload twice; no messages submitted',
    sourceURL: source, exactHrefChecks: 3, actualClickedRequestURL: sourceRequests[0], sourceResponseStatuses: sourceResponses,
    finalDestinationURL: popup.url(), destinationContainsLocation, pageErrors: errors,
    limitation: 'PASS verifies the application link and actual navigation request. External redirects and destination readability are recorded separately.'};
  await writeFile(new URL('results.json', output), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await browser.close(); }
