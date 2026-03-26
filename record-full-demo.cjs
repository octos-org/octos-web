/**
 * MoFa Notebook — Full Feature Demo Recording
 * Records a WebM video demonstrating ALL features.
 */
const { chromium } = require('playwright');

const TOKEN = 'test-token-123';
const BASE = 'http://localhost:5174';

async function delay(page, ms) {
  await page.waitForTimeout(ms);
}

async function annotate(page, text) {
  // Inject a floating annotation overlay
  await page.evaluate((t) => {
    let el = document.getElementById('demo-annotation');
    if (!el) {
      el = document.createElement('div');
      el.id = 'demo-annotation';
      el.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:99999;background:rgba(0,0,0,0.85);color:#fff;padding:12px 24px;border-radius:12px;font-size:18px;font-weight:600;pointer-events:none;transition:opacity 0.3s;font-family:system-ui;';
      document.body.appendChild(el);
    }
    el.textContent = t;
    el.style.opacity = '1';
  }, text);
  await delay(page, 2000);
}

async function clearAnnotation(page) {
  await page.evaluate(() => {
    const el = document.getElementById('demo-annotation');
    if (el) el.style.opacity = '0';
  });
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: '/tmp/demo-full/', size: { width: 1440, height: 900 } },
  });
  const page = await context.newPage();

  // ═══════════════════════════════════════════════════════════
  // 1. LOGIN
  // ═══════════════════════════════════════════════════════════
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await annotate(page, '1. Login with Auth Token');
  await page.locator('button', { hasText: 'Auth Token' }).click();
  await delay(page, 500);
  await page.locator('[data-testid="token-input"]').fill(TOKEN);
  await delay(page, 500);
  await page.locator('[data-testid="login-button"]').click();
  await page.waitForURL('**/', { timeout: 15000 });
  await delay(page, 1500);
  await clearAnnotation(page);

  // ═══════════════════════════════════════════════════════════
  // 2. CHAT MODE (existing feature)
  // ═══════════════════════════════════════════════════════════
  await annotate(page, '2. Chat Mode — AI Agent conversation');
  await delay(page, 2000);
  await clearAnnotation(page);

  // ═══════════════════════════════════════════════════════════
  // 3. NAVIGATE TO NOTEBOOKS
  // ═══════════════════════════════════════════════════════════
  await annotate(page, '3. Switch to Notebooks');
  await page.locator('button', { hasText: 'Notebooks' }).click();
  await page.waitForURL('**/notebooks', { timeout: 5000 });
  await delay(page, 1500);
  await clearAnnotation(page);

  // ═══════════════════════════════════════════════════════════
  // 4. TEMPLATES
  // ═══════════════════════════════════════════════════════════
  await annotate(page, '4. Template Library');
  const templateBtn = page.locator('button', { hasText: 'Templates' });
  if (await templateBtn.isVisible()) {
    await templateBtn.click();
    await delay(page, 2000);
  }
  await clearAnnotation(page);

  // ═══════════════════════════════════════════════════════════
  // 5. CREATE NOTEBOOK
  // ═══════════════════════════════════════════════════════════
  await annotate(page, '5. Create New Notebook');
  await page.locator('button', { hasText: 'New Notebook' }).click();
  await delay(page, 500);
  await page.locator('input[placeholder="Notebook title..."]').fill('Physics 101 — Newton\'s Laws');
  await delay(page, 800);
  await page.locator('button', { hasText: 'Create' }).last().click();
  await page.waitForURL('**/notebooks/*', { timeout: 5000 });
  await delay(page, 1500);
  await clearAnnotation(page);

  // ═══════════════════════════════════════════════════════════
  // 6. SOURCES — Add text
  // ═══════════════════════════════════════════════════════════
  await annotate(page, '6. Sources — Add Text Source');
  await page.getByRole('main').getByRole('button', { name: 'Sources', exact: true }).click();
  await delay(page, 800);

  await page.locator('button', { hasText: 'Paste Text' }).click();
  await delay(page, 500);
  await page.locator('input[placeholder="Title (optional)"]').fill('Newton\'s Laws of Motion');
  await page.locator('textarea').first().fill(
    'Newton\'s First Law (Law of Inertia): An object at rest stays at rest, and an object in motion stays in motion, unless acted upon by an external force.\n\n' +
    'Newton\'s Second Law: The acceleration of an object is directly proportional to the net force acting on it and inversely proportional to its mass. F = ma.\n\n' +
    'Newton\'s Third Law: For every action, there is an equal and opposite reaction. When object A exerts a force on object B, object B exerts an equal and opposite force on object A.'
  );
  await delay(page, 1000);
  await page.locator('button', { hasText: 'Add' }).last().click();
  await delay(page, 1500);
  await clearAnnotation(page);

  // Add URL source
  await annotate(page, '6b. Sources — Add URL Source');
  await page.locator('button', { hasText: 'Add URL' }).click();
  await delay(page, 500);
  await page.locator('input[placeholder="https://..."]').fill('https://en.wikipedia.org/wiki/Newton%27s_laws_of_motion');
  await delay(page, 800);
  await page.locator('button', { hasText: 'Add' }).last().click();
  await delay(page, 1500);
  await clearAnnotation(page);

  // ═══════════════════════════════════════════════════════════
  // 7. SOURCE CHECKBOXES
  // ═══════════════════════════════════════════════════════════
  await annotate(page, '7. Source Checkbox Filter');
  // Look for checkboxes in the sources panel
  const checkboxes = page.locator('input[type="checkbox"]');
  const checkboxCount = await checkboxes.count();
  if (checkboxCount > 0) {
    await checkboxes.first().click();
    await delay(page, 800);
    await checkboxes.first().click();
    await delay(page, 800);
  }
  await clearAnnotation(page);

  // ═══════════════════════════════════════════════════════════
  // 8. CHAT — Suggested Questions + Send Message
  // ═══════════════════════════════════════════════════════════
  await annotate(page, '8. Chat — Suggested Questions');
  await page.getByRole('main').getByRole('button', { name: 'Chat', exact: true }).click();
  await delay(page, 1500);

  // Check for suggested questions
  const suggestedBtn = page.locator('button', { hasText: 'Summarize' }).first();
  if (await suggestedBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await annotate(page, '8b. Click Suggested Question');
    await suggestedBtn.click();
    await delay(page, 8000); // Wait for AI response
  } else {
    // Type manually
    await annotate(page, '8b. Chat with AI');
    const chatInput = page.locator('input[placeholder="Ask about your sources..."]');
    if (await chatInput.isVisible()) {
      await chatInput.fill('Explain Newton\'s three laws of motion');
      await delay(page, 500);
      await page.locator('button').filter({ has: page.locator('svg.lucide-send') }).click();
      await delay(page, 8000); // Wait for response
    }
  }
  await clearAnnotation(page);

  // ═══════════════════════════════════════════════════════════
  // 9. SAVE TO NOTE
  // ═══════════════════════════════════════════════════════════
  await annotate(page, '9. Save Chat Reply to Note');
  const bookmarkBtn = page.locator('button').filter({ has: page.locator('svg.lucide-bookmark-plus') }).first();
  if (await bookmarkBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await bookmarkBtn.click();
    await delay(page, 1500);
  }
  await clearAnnotation(page);

  // ═══════════════════════════════════════════════════════════
  // 10. NOTES — Create & Edit
  // ═══════════════════════════════════════════════════════════
  await annotate(page, '10. Notes Panel — Create Note');
  await page.getByRole('main').getByRole('button', { name: 'Notes', exact: true }).click();
  await delay(page, 1000);

  const newNoteBtn = page.locator('button', { hasText: 'New Note' });
  if (await newNoteBtn.isVisible()) {
    await newNoteBtn.click();
    await delay(page, 500);
    await page.locator('textarea').first().fill('## Key Takeaways\n\n- F = ma is the foundation of classical mechanics\n- Every force has an equal and opposite reaction\n- Objects resist changes to their state of motion (inertia)');
    await delay(page, 800);
    await page.locator('button', { hasText: 'Save' }).last().click();
    await delay(page, 1500);
  }

  // Export note
  await annotate(page, '10b. Note Export');
  const exportBtn = page.locator('button', { hasText: 'Export' }).first();
  if (await exportBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
    await exportBtn.click();
    await delay(page, 1500);
  }
  await clearAnnotation(page);

  // ═══════════════════════════════════════════════════════════
  // 11. STUDIO — Show All Output Types
  // ═══════════════════════════════════════════════════════════
  await annotate(page, '11. Studio — Courseware Generation');
  await page.getByRole('main').getByRole('button', { name: 'Studio', exact: true }).click();
  await delay(page, 2000);
  await clearAnnotation(page);

  // 11a. Slides
  await annotate(page, '11a. Studio — Slides (PPT Generation)');
  const slidesBtn = page.locator('button', { hasText: 'Generate PPT courseware' }).first();
  if (await slidesBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
    await slidesBtn.click();
    await delay(page, 2000);
    // Close dialog if visible
    const closeBtn = page.locator('button', { hasText: 'Close' }).first();
    if (await closeBtn.isVisible({ timeout: 500 }).catch(() => false)) {
      await closeBtn.click();
    }
    const backBtn = page.locator('button', { hasText: 'Back' }).first();
    if (await backBtn.isVisible({ timeout: 500 }).catch(() => false)) {
      await backBtn.click();
    }
  }
  await clearAnnotation(page);
  await delay(page, 500);

  // 11b. Quiz
  await annotate(page, '11b. Studio — Quiz (Test Questions)');
  const quizBtn = page.locator('button', { hasText: 'Generate test questions' }).first();
  if (await quizBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
    await quizBtn.click();
    await delay(page, 2000);
    const backBtn2 = page.locator('button', { hasText: 'Back' }).first();
    if (await backBtn2.isVisible({ timeout: 500 }).catch(() => false)) await backBtn2.click();
  }
  await clearAnnotation(page);
  await delay(page, 500);

  // 11c. Flashcards
  await annotate(page, '11c. Studio — Flashcards');
  const flashBtn = page.locator('button', { hasText: 'Generate study cards' }).first();
  if (await flashBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
    await flashBtn.click();
    await delay(page, 2000);
    const backBtn3 = page.locator('button', { hasText: 'Back' }).first();
    if (await backBtn3.isVisible({ timeout: 500 }).catch(() => false)) await backBtn3.click();
  }
  await clearAnnotation(page);
  await delay(page, 500);

  // 11d. Mind Map
  await annotate(page, '11d. Studio — Mind Map');
  const mindBtn = page.locator('button', { hasText: 'Visualize key concepts' }).first();
  if (await mindBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
    await mindBtn.click();
    await delay(page, 2000);
    const backBtn4 = page.locator('button', { hasText: 'Back' }).first();
    if (await backBtn4.isVisible({ timeout: 500 }).catch(() => false)) await backBtn4.click();
  }
  await clearAnnotation(page);
  await delay(page, 500);

  // 11e. Audio
  await annotate(page, '11e. Studio — Audio Podcast');
  const audioBtn = page.locator('button', { hasText: 'Generate podcast' }).first();
  if (await audioBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
    await audioBtn.click();
    await delay(page, 2000);
    const backBtn5 = page.locator('button', { hasText: 'Back' }).first();
    if (await backBtn5.isVisible({ timeout: 500 }).catch(() => false)) await backBtn5.click();
  }
  await clearAnnotation(page);
  await delay(page, 500);

  // 11f. Infographic
  await annotate(page, '11f. Studio — Infographic');
  const infoBtn = page.locator('button', { hasText: 'Generate visual summary' }).first();
  if (await infoBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
    await infoBtn.click();
    await delay(page, 2000);
    const backBtn6 = page.locator('button', { hasText: 'Back' }).first();
    if (await backBtn6.isVisible({ timeout: 500 }).catch(() => false)) await backBtn6.click();
  }
  await clearAnnotation(page);
  await delay(page, 500);

  // Scroll down to see more
  await page.evaluate(() => window.scrollTo(0, 500));
  await delay(page, 500);

  // 11g. Comic
  await annotate(page, '11g. Studio — Comic');
  const comicBtn = page.locator('button', { hasText: 'Explain with comics' }).first();
  if (await comicBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
    await comicBtn.click();
    await delay(page, 2000);
    const backBtn7 = page.locator('button', { hasText: 'Back' }).first();
    if (await backBtn7.isVisible({ timeout: 500 }).catch(() => false)) await backBtn7.click();
  }
  await clearAnnotation(page);
  await delay(page, 500);

  // 11h. Report
  await annotate(page, '11h. Studio — Report');
  const reportBtn = page.locator('button', { hasText: 'Generate Word/Excel' }).first();
  if (await reportBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
    await reportBtn.click();
    await delay(page, 2000);
    const backBtn8 = page.locator('button', { hasText: 'Back' }).first();
    if (await backBtn8.isVisible({ timeout: 500 }).catch(() => false)) await backBtn8.click();
  }
  await clearAnnotation(page);
  await delay(page, 500);

  // 11i. Research
  await annotate(page, '11i. Studio — Deep Research');
  const resBtn = page.locator('button', { hasText: 'Deep research' }).first();
  if (await resBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
    await resBtn.click();
    await delay(page, 2000);
    const backBtn9 = page.locator('button', { hasText: 'Back' }).first();
    if (await backBtn9.isVisible({ timeout: 500 }).catch(() => false)) await backBtn9.click();
  }
  await clearAnnotation(page);

  // ═══════════════════════════════════════════════════════════
  // 12. SHARING
  // ═══════════════════════════════════════════════════════════
  await annotate(page, '12. Notebook Sharing');
  const shareBtn = page.locator('button').filter({ has: page.locator('svg.lucide-share2, svg.lucide-share-2') }).first();
  if (await shareBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
    await shareBtn.click();
    await delay(page, 2000);
    // Close share dialog
    const closeShare = page.locator('button').filter({ has: page.locator('svg.lucide-x') }).first();
    if (await closeShare.isVisible({ timeout: 500 }).catch(() => false)) await closeShare.click();
  }
  await clearAnnotation(page);

  // ═══════════════════════════════════════════════════════════
  // 13. SCHEDULED PUSH
  // ═══════════════════════════════════════════════════════════
  await annotate(page, '13. Scheduled Push');
  const scheduleBtn = page.locator('button').filter({ has: page.locator('svg.lucide-calendar') }).first();
  if (await scheduleBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
    await scheduleBtn.click();
    await delay(page, 2000);
    const closeSchedule = page.locator('button').filter({ has: page.locator('svg.lucide-x') }).first();
    if (await closeSchedule.isVisible({ timeout: 500 }).catch(() => false)) await closeSchedule.click();
  }
  await clearAnnotation(page);

  // ═══════════════════════════════════════════════════════════
  // 14. BACK TO NOTEBOOK LIST
  // ═══════════════════════════════════════════════════════════
  await annotate(page, '14. Back to Notebook List');
  await page.getByRole('main').locator('button').first().click();
  await delay(page, 1500);
  await clearAnnotation(page);

  // ═══════════════════════════════════════════════════════════
  // 15. LIBRARY
  // ═══════════════════════════════════════════════════════════
  await annotate(page, '15. Library — Bookshelf Browsing');
  await page.goto(`${BASE}/library`, { waitUntil: 'networkidle' });
  await delay(page, 2500);
  await clearAnnotation(page);

  // ═══════════════════════════════════════════════════════════
  // 16. SWITCH BACK TO CHAT
  // ═══════════════════════════════════════════════════════════
  await annotate(page, '16. Switch to Chat Mode');
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await delay(page, 1500);
  await clearAnnotation(page);

  // ═══════════════════════════════════════════════════════════
  // 17. DARK/LIGHT THEME
  // ═══════════════════════════════════════════════════════════
  await annotate(page, '17. Theme Toggle — Light Mode');
  const themeBtn = page.locator('button[title*="Switch to"]');
  if (await themeBtn.isVisible()) {
    await themeBtn.click();
    await delay(page, 2000);
    await annotate(page, '17. Theme Toggle — Dark Mode');
    await themeBtn.click();
    await delay(page, 1500);
  }
  await clearAnnotation(page);

  // ═══════════════════════════════════════════════════════════
  // DONE
  // ═══════════════════════════════════════════════════════════
  await annotate(page, 'MoFa Notebook — Demo Complete');
  await delay(page, 3000);
  await clearAnnotation(page);

  await context.close();
  await browser.close();

  console.log('Full demo recorded to /tmp/demo-full/');
})().catch(e => {
  console.error('Demo failed:', e.message);
  process.exit(1);
});
