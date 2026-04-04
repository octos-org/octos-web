import { chromium } from 'playwright';

const URL = process.env.BASE_URL || 'http://localhost:5174';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const errors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', err => errors.push(err.message));

  const failedReqs = [];
  page.on('requestfailed', req => failedReqs.push(`${req.method()} ${req.url()} - ${req.failure()?.errorText}`));

  const httpErrors = [];
  page.on('response', resp => {
    if (resp.status() >= 400) httpErrors.push(`${resp.status()} ${resp.url()}`);
  });

  // Track all navigations
  page.on('framenavigated', frame => {
    if (frame === page.mainFrame()) {
      console.log(`NAVIGATED to: ${frame.url()}`);
    }
  });

  console.log(`Opening ${URL}...`);

  await page.goto(URL, { timeout: 30000, waitUntil: 'commit' });
  console.log(`Initial URL: ${page.url()}`);

  // Wait for any redirects to settle
  await page.waitForTimeout(8000);
  console.log(`Final URL: ${page.url()}`);
  console.log(`Title: ${await page.title()}`);

  const bodyText = await page.textContent('body');
  console.log(`Body (first 300): ${bodyText?.slice(0, 300)}`);

  await page.screenshot({ path: '/tmp/admin-page.png', fullPage: true });
  console.log('Screenshot: /tmp/admin-page.png');

  if (errors.length) { console.log('\nConsole errors:'); errors.forEach(e => console.log(`  ${e}`)); }
  if (failedReqs.length) { console.log('\nFailed requests:'); failedReqs.forEach(r => console.log(`  ${r}`)); }
  if (httpErrors.length) { console.log('\nHTTP errors:'); httpErrors.forEach(r => console.log(`  ${r}`)); }

  await browser.close();
})();
