import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const errors = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push(`PAGE ERROR: ${err.message}`));

  // Go to login
  const BASE_URL = process.env.BASE_URL || 'http://localhost:5174';
  await page.goto(`${BASE_URL}/admin/login`, { waitUntil: 'load' });
  await page.waitForTimeout(2000);

  // Click admin token tab
  await page.click('text=admin token').catch(() => {});
  await page.waitForTimeout(500);

  // Fill token
  const inputs = await page.$$('input');
  for (const input of inputs) {
    const type = await input.getAttribute('type');
    if (type === 'password' || type === 'text') {
      const adminToken = process.env.AUTH_TOKEN || 'test-admin-token-12345';
      await input.fill(adminToken);
      break;
    }
  }

  // Click login
  await page.click('button:has-text("Login")').catch(() => {});
  await page.waitForTimeout(3000);
  console.log('After login:', page.url());

  // Navigate to dspfac profile
  await page.click('text=dspfac').catch(async () => {
    // Try link
    await page.click('a >> text=dspfac').catch(() => console.log('Cannot find dspfac link'));
  });
  await page.waitForTimeout(2000);
  console.log('Profile page:', page.url());

  // Click LLM tab
  await page.click('text=LLM').catch(() => console.log('Cannot find LLM tab'));
  await page.waitForTimeout(2000);
  console.log('LLM page:', page.url());
  await page.screenshot({ path: '/tmp/llm-before.png', fullPage: true });

  // Click Add Fallback
  const addBtn = await page.$('button:has-text("Add Fallback")');
  if (addBtn) {
    console.log('Clicking Add Fallback...');
    await addBtn.click();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: '/tmp/llm-after.png', fullPage: true });

    // Check if fallback row appeared
    const body = await page.textContent('body');
    const hasFallback = body.includes('deepseek') || body.includes('Fallback #1');
    console.log('Fallback added:', hasFallback);
  } else {
    console.log('Add Fallback button NOT found');
    const body = await page.textContent('body');
    console.log('Body:', body?.slice(0, 300));
  }

  if (errors.length) { console.log('\nErrors:'); errors.forEach(e => console.log(`  ${e}`)); }

  await browser.close();
})();
