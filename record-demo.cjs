const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: '/tmp/demo-videos/', size: { width: 1440, height: 900 } },
  });
  const page = await context.newPage();
  const TOKEN = 'test-token-123';
  const BASE = 'http://localhost:5174';

  // Login
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await page.locator('button', { hasText: 'Auth Token' }).click();
  await page.locator('[data-testid="token-input"]').fill(TOKEN);
  await page.locator('[data-testid="login-button"]').click();
  await page.waitForURL('**/', { timeout: 15000 });
  await page.waitForTimeout(1500);

  // Navigate to Notebooks
  await page.locator('button', { hasText: 'Notebooks' }).click();
  await page.waitForURL('**/notebooks', { timeout: 5000 });
  await page.waitForTimeout(1500);

  // Create a new notebook
  await page.locator('button', { hasText: 'New Notebook' }).click();
  await page.waitForTimeout(500);
  await page.locator('input[placeholder="Notebook title..."]').fill('Physics 101 Demo');
  await page.waitForTimeout(500);
  await page.locator('button', { hasText: 'Create' }).last().click();
  await page.waitForURL('**/notebooks/*', { timeout: 5000 });
  await page.waitForTimeout(1500);

  // Show Sources tab
  await page.getByRole('main').getByRole('button', { name: 'Sources', exact: true }).click();
  await page.waitForTimeout(1000);

  // Add a text source
  await page.locator('button', { hasText: 'Paste Text' }).click();
  await page.waitForTimeout(500);
  const physicsText = "Newton's First Law states that an object at rest stays at rest unless acted upon by an external force. Newton's Second Law: F = ma. Newton's Third Law: For every action there is an equal and opposite reaction.";
  await page.locator('input[placeholder="Title (optional)"]').fill('Newton Laws');
  await page.locator('textarea').fill(physicsText);
  await page.waitForTimeout(500);
  await page.locator('button', { hasText: 'Add' }).last().click();
  await page.waitForTimeout(1500);

  // Show Chat tab
  await page.getByRole('main').getByRole('button', { name: 'Chat', exact: true }).click();
  await page.waitForTimeout(1000);

  // Send a message
  const chatInput = page.locator('input[placeholder="Ask about your sources..."]');
  await chatInput.fill('What are Newton\'s three laws?');
  await page.waitForTimeout(500);
  await page.locator('button').filter({ has: page.locator('svg') }).last().click();
  await page.waitForTimeout(8000); // Wait for response

  // Show Notes tab
  await page.getByRole('main').getByRole('button', { name: 'Notes', exact: true }).click();
  await page.waitForTimeout(1000);

  // Create a note
  await page.locator('button', { hasText: 'New Note' }).click();
  await page.waitForTimeout(500);
  await page.locator('textarea').first().fill('Key takeaway: Newton\'s laws form the foundation of classical mechanics.');
  await page.locator('button', { hasText: 'Save' }).last().click();
  await page.waitForTimeout(1500);

  // Show Studio tab
  await page.getByRole('main').getByRole('button', { name: 'Studio', exact: true }).click();
  await page.waitForTimeout(2000);

  // Show Library page
  await page.locator('button', { hasText: 'Notebooks' }).click();
  await page.waitForURL('**/notebooks', { timeout: 5000 });
  await page.waitForTimeout(1500);

  // Done
  await page.waitForTimeout(1000);
  await context.close();
  await browser.close();

  console.log('Demo video saved to /tmp/demo-videos/');
})().catch(console.error);
