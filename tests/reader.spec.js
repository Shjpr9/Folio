import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const fixture = fileURLToPath(new URL('./fixtures/reading.pdf', import.meta.url));

async function openPDF(page) {
  await page.goto('/');
  await page.locator('#file').setInputFiles(fixture);
  await expect(page.locator('#document-status')).toContainText('Page 1 of 3');
  await expect(page.locator('.textLayer')).toContainText('The quiet art');
}

async function configure(page) {
  await page.getByRole('button', { name: 'AI settings', exact: true }).click();
  await page.getByLabel('Endpoint URL').fill('https://example.com/v1');
  await page.getByLabel('API key', { exact: false }).fill('test-secret');
  await page.getByLabel('Model', { exact: true }).fill('test-model');
  await page.getByRole('button', { name: 'Use these settings' }).click();
}

async function selectPassage(page) {
  await page.locator('.textLayer span').first().evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await expect(page.locator('#selection-badge')).toContainText('characters');
}

test.beforeEach(async ({ page }) => {
  // Only replace the desktop IPC boundary; PDF loading, rendering and UI remain real.
  await page.addInitScript(() => {
    window.sentRequests = [];
    window.nativeRestores = 0;
    window.__TAURI__ = { core: { invoke: async (command, args) => {
      if (command === 'choose_pdf') return null;
      if (command === 'restore_pdf') {
        window.nativeRestores++;
        if (window.restoreError) throw 'The PDF is missing or inaccessible.';
        return window.reopenFixture ? 'reading.pdf' : null;
      }
      if (command === 'read_selected_pdf') return new Uint8Array(window.reopenFixture).buffer;
      if (command === 'remember_pdf') return;
      if (command === 'load_settings') {
        if (sessionStorage.getItem('fail-load')) throw 'Could not read saved settings.';
        return JSON.parse(sessionStorage.getItem('desktop-settings') || '{}');
      }
      if (command === 'save_settings') {
        if (window.failSave) throw 'Could not save settings.';
        // Test-only stand-in for the Rust file, retained across page reloads.
        sessionStorage.setItem('desktop-settings', JSON.stringify(args.settings));
        return;
      }
      window.sentRequests.push({ command, ...args });
      if (window.failAI) throw 'Provider returned HTTP 401.';
      if (window.holdAI) await new Promise(resolve => { window.releaseAI = resolve; });
      return 'A useful response about this source.';
    } } };
  });
});

test('startup reopens the last PDF at its saved page and can be disabled', async ({ page }) => {
  const bytes = [...readFileSync(fixture)];
  const id = createHash('sha256').update(Buffer.from(bytes)).digest('hex');
  await page.goto('/');
  await page.addInitScript(data => { window.reopenFixture = data; }, bytes);
  await page.evaluate(({ id }) => sessionStorage.setItem('desktop-settings', JSON.stringify({
    last_pdf_path: '/test/reading.pdf', reopen_last_pdf: true,
    reading_positions: [{ document_id: id, page: 2 }],
  })), { id });
  await page.reload();
  await expect(page.locator('#document-status')).toContainText('Page 2 of 3');
  await expect(page.locator('.textLayer')).toContainText('A new perspective');
  await page.getByRole('button', { name: 'AI settings', exact: true }).click();
  await page.getByLabel('Reopen last PDF on startup').uncheck();
  await page.getByRole('button', { name: 'Use these settings' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.reload();
  await expect(page.locator('#empty')).toBeVisible();
  expect(await page.evaluate(() => window.nativeRestores)).toBe(0);
});

test('a missing last PDF leaves the app usable', async ({ page }) => {
  await page.goto('/');
  await page.addInitScript(() => { window.restoreError = true; });
  await page.evaluate(() => sessionStorage.setItem('desktop-settings', JSON.stringify({ last_pdf_path: '/test/missing.pdf' })));
  await page.reload();
  await expect(page.locator('#reader-error')).toContainText('Could not reopen');
  await expect(page.getByRole('button', { name: 'Open PDF', exact: false }).first()).toBeEnabled();
  await page.getByRole('button', { name: 'AI settings', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('credentials, dark mode and chosen zoom restore after restart', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await openPDF(page);
  await configure(page);
  await page.getByRole('button', { name: 'Switch to dark mode' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('desktop-settings')).zoom)).not.toBeNull();
  const zoom = await page.locator('#zoom-label').textContent();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('#provider-label')).toHaveText('test-model');
  await page.getByRole('button', { name: 'AI settings', exact: true }).click();
  await expect(page.getByLabel('Endpoint URL')).toHaveValue('https://example.com/v1');
  await expect(page.getByLabel('API key', { exact: false })).toHaveValue('test-secret');
  await expect(page.getByLabel('Appearance')).toHaveValue('dark');
  await expect(page.getByRole('dialog')).toHaveCSS('background-color', 'rgb(35, 40, 50)');
  await page.getByRole('button', { name: 'Close settings' }).click();
  await page.locator('#file').setInputFiles(fixture);
  await expect(page.locator('#document-status')).toContainText('Text ready');
  await expect(page.locator('#zoom-label')).toHaveText(zoom);
  await expect(page.locator('#page')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await page.getByRole('button', { name: 'Switch to light mode' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await page.evaluate(() => window.sentRequests.length)).toBe(0);
});

test('a failed settings write stays visible and can be retried', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { window.failSave = true; });
  await configure(page);
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('#settings-error')).toContainText('Could not save');
  await page.evaluate(() => { window.failSave = false; });
  await page.getByRole('button', { name: 'Use these settings' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
});

test('appearance can follow the system without an AI provider', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await page.getByRole('button', { name: 'AI settings', exact: true }).click();
  await page.getByLabel('Appearance').selectOption('system');
  await page.getByRole('button', { name: 'Use these settings' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('a failed restore cannot let a theme toggle erase stored credentials', async ({ page }) => {
  await page.goto('/'); await configure(page);
  await page.evaluate(() => sessionStorage.setItem('fail-load', 'yes'));
  await page.reload();
  await expect(page.locator('#reader-error')).toContainText('Could not read');
  await page.locator('#theme-toggle').click();
  await expect(page.locator('#reader-error')).toContainText('could not be loaded');
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('desktop-settings')).api_key)).toBe('test-secret');
});

test('reopening a PDF after restart restores its last successfully viewed page', async ({ page }) => {
  await openPDF(page);
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.locator('#document-status')).toContainText('Page 2 of 3');
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('desktop-settings')).reading_positions[0].page)).toBe(2);
  await page.reload();
  await page.locator('#file').setInputFiles(fixture);
  await expect(page.locator('#document-status')).toContainText('Page 2 of 3');
  await expect(page.locator('.textLayer')).toContainText('A new perspective');
  await expect(page.locator('#page-number')).toHaveValue('2');
});

test('renders PDF, navigates, zooms, and disables AI on a page without text', async ({ page }) => {
  await openPDF(page);
  const width = await page.locator('#page').evaluate(element => element.clientWidth);
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect.poll(() => page.locator('#page').evaluate(element => element.clientWidth)).toBeGreaterThan(width);
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.locator('.textLayer')).toContainText('A new perspective');
  await expect(page.locator('#current-page-badge')).toHaveText('Page 2');
  await expect(page.locator('#selection-badge')).toHaveText('No selection');
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.locator('#document-status')).toContainText('OCR needed');
  await expect(page.locator('[data-scope="page"][data-action="summarize"]')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeDisabled();
  await page.screenshot({ path: 'test-results/reader-blank.png' });
});

test('all four AI actions send only their chosen context', async ({ page }) => {
  await openPDF(page);
  await configure(page);
  await expect(page.locator('#api-key')).toHaveValue('');
  await expect(page.locator('[data-scope="selection"][data-action="summarize"]')).toBeDisabled();
  await selectPassage(page);
  await page.locator('[data-scope="selection"][data-action="summarize"]').click();
  await expect(page.locator('#answer')).toHaveText('A useful response about this source.');
  let requests = await page.evaluate(() => window.sentRequests);
  expect(requests[0].request.text).toBe('The quiet art of paying attention');
  expect(requests[0].request.action).toBe('summarize');
  await page.locator('[data-scope="selection"][data-action="ask"]').click();
  await page.getByLabel('Your question').fill('What is this about?');
  await page.getByRole('button', { name: 'Send question', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.sentRequests.length)).toBe(2);
  await expect(page.locator('#answer')).toHaveText('A useful response about this source.');
  await page.locator('[data-scope="page"][data-action="summarize"]').click();
  await expect.poll(() => page.evaluate(() => window.sentRequests.length)).toBe(3);
  await expect(page.locator('#answer')).toHaveText('A useful response about this source.');
  await page.locator('[data-scope="page"][data-action="ask"]').click();
  await page.getByLabel('Your question').fill('What helps us notice details?');
  await page.getByRole('button', { name: 'Send question', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.sentRequests.length)).toBe(4);
  requests = await page.evaluate(() => window.sentRequests);
  expect(requests.map(item => item.request.action)).toEqual(['summarize', 'ask', 'summarize', 'ask']);
  expect(requests[1].request.text).toBe('The quiet art of paying attention');
  expect(requests[1].request.question).toBe('What is this about?');
  expect(requests[2].request.text).toContain('Reading slowly helps');
  expect(requests[3].request.question).toBe('What helps us notice details?');
  expect(requests[3].request.model).toBe('test-model');
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  await page.screenshot({ path: 'test-results/reader.png' });
});

test('a pending answer retains its source after navigation', async ({ page }) => {
  await openPDF(page); await configure(page);
  await page.evaluate(() => { window.holdAI = true; });
  await page.locator('[data-scope="page"][data-action="summarize"]').click();
  await expect(page.locator('#answer')).toContainText('Reading between');
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.locator('#current-page-badge')).toHaveText('Page 2');
  await page.evaluate(() => window.releaseAI());
  await expect(page.locator('#answer')).toHaveText('A useful response about this source.');
  await expect(page.locator('#answer-source')).toContainText('Page 1');
});

test('settings and provider failures are visible and recoverable', async ({ page }) => {
  await openPDF(page);
  await page.locator('[data-scope="page"][data-action="summarize"]').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByLabel('Endpoint URL').fill('http://example.com/v1');
  await page.getByLabel('Model', { exact: true }).fill('model');
  await page.getByRole('button', { name: 'Use these settings' }).click();
  await expect(page.locator('#settings-error')).toContainText('HTTPS');
  await page.getByLabel('Endpoint URL').fill('http://localhost:11434/v1');
  await page.getByRole('button', { name: 'Use these settings' }).click();
  await page.evaluate(() => { window.failAI = true; });
  await page.locator('[data-scope="page"][data-action="summarize"]').click();
  await expect(page.locator('#ai-error')).toContainText('401');
  await expect(page.locator('[data-scope="page"][data-action="summarize"]')).toBeEnabled();
});

test('a corrupt PDF shows an error without enabling AI', async ({ page }) => {
  await page.goto('/');
  await page.locator('#file').setInputFiles({ name: 'broken.pdf', mimeType: 'application/pdf', buffer: Buffer.from('not a PDF') });
  await expect(page.locator('#reader-error')).toContainText('Could not open');
  await expect(page.locator('[data-scope="page"][data-action="ask"]')).toBeDisabled();
});

test('Vim keys scroll and navigate while question typing remains untouched', async ({ page }) => {
  await openPDF(page);
  await page.locator('#viewport').focus();
  await page.keyboard.press('j');
  await expect.poll(() => page.locator('#viewport').evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await page.keyboard.press('k');
  await expect.poll(() => page.locator('#viewport').evaluate(element => element.scrollTop)).toBe(0);
  await page.keyboard.press('l');
  await expect(page.locator('#document-status')).toContainText('Page 2 of 3');
  await page.keyboard.press('h');
  await expect(page.locator('#document-status')).toContainText('Page 1 of 3');
  await page.locator('[data-scope="page"][data-action="ask"]').click();
  await page.getByLabel('Your question').pressSequentially('hjkl');
  await expect(page.getByLabel('Your question')).toHaveValue('hjkl');
  await expect(page.locator('#page-number')).toHaveValue('1');
});

test('Ctrl+R recolors the PDF without reloading, and restores the preference next launch', async ({ page }) => {
  await openPDF(page);
  await page.keyboard.press('Control+r');
  await expect(page.locator('html')).toHaveAttribute('data-recolor-pdf', 'true');
  await expect(page.locator('#page canvas')).toHaveCSS('filter', /invert\(0\.9\)/);
  await expect(page.getByRole('button', { name: 'Recolor PDF', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#document-status')).toContainText('Page 1 of 3');
  await selectPassage(page);
  expect(await page.evaluate(() => window.getSelection().toString())).toBe('The quiet art of paying attention');
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('desktop-settings')).recolor_pdf)).toBe(true);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-recolor-pdf', 'true');
  await page.locator('#file').setInputFiles(fixture);
  await expect(page.locator('#document-status')).toContainText('Text ready');
  await page.getByRole('button', { name: 'Recolor PDF', exact: true }).click();
  await expect(page.locator('#page canvas')).toHaveCSS('filter', 'none');
});

test('AI answer expands into a large popup and returns intact on close', async ({ page }) => {
  await openPDF(page); await configure(page);
  await page.locator('[data-scope="page"][data-action="ask"]').click();
  await page.getByLabel('Your question').fill('What is this page about?');
  await page.getByRole('button', { name: 'Send question', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Expand AI answer' })).toBeEnabled();
  await page.getByRole('button', { name: 'Expand AI answer' }).click();
  const popup = page.getByRole('dialog', { name: 'AI response' });
  await expect(popup).toBeVisible();
  await expect(popup.locator('#answer')).toHaveText('A useful response about this source.');
  await expect(popup.locator('#answer-source')).toContainText('Page 1');
  await expect(popup.locator('#asked-question')).toHaveText('What is this page about?');
  await expect(popup.getByRole('button', { name: 'Copy answer', exact: true })).toBeEnabled();
  const size = await popup.boundingBox();
  expect(size.width).toBeGreaterThan(600);
  expect(size.width).toBeLessThan(1280);
  expect(size.height).toBeLessThan(860);
  await page.keyboard.press('l');
  await expect(page.locator('#page-number')).toHaveValue('1');
  await page.keyboard.press('Escape');
  await expect(popup).not.toBeVisible();
  await expect(page.locator('#answer-area #answer')).toHaveText('A useful response about this source.');
  await expect(page.getByRole('button', { name: 'Expand AI answer' })).toBeFocused();
  await page.getByRole('button', { name: 'Expand AI answer' }).click();
  await page.getByRole('button', { name: 'Close expanded answer' }).click();
  await expect(popup).not.toBeVisible();
});

test('PDF fullscreen hides the sidebar, keeps navigation, and exits cleanly', async ({ page }) => {
  await openPDF(page);
  await page.getByRole('button', { name: 'PDF fullscreen', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-reader-fullscreen', 'true');
  await expect(page.locator('.assistant')).toBeHidden();
  await expect(page.locator('.toolbar')).toBeHidden();
  await expect(page.locator('.reader-toolbar')).toBeVisible();
  await page.locator('#viewport').focus();
  await page.keyboard.press('l');
  await expect(page.locator('#document-status')).toContainText('Page 2 of 3');
  await page.keyboard.press('Escape');
  await expect(page.locator('html')).toHaveAttribute('data-reader-fullscreen', 'false');
  await expect(page.locator('.assistant')).toBeVisible();
  await expect(page.locator('.toolbar')).toBeVisible();
  await expect(page.locator('#page-number')).toHaveValue('2');
  await page.getByRole('button', { name: 'PDF fullscreen', exact: true }).click();
  await page.getByRole('button', { name: 'Exit PDF fullscreen', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-reader-fullscreen', 'false');
});

test('fullscreen context menu runs all four AI actions with the correct sources', async ({ page }) => {
  await openPDF(page); await configure(page);
  await page.getByRole('button', { name: 'PDF fullscreen', exact: true }).click();
  const menu = page.getByRole('menu', { name: 'PDF AI actions' });
  const popup = page.locator('#answer-dialog');
  await page.locator('#viewport').click({ button: 'right', position: { x: 10, y: 10 } });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Summarize selection', exact: true })).toBeDisabled();
  await menu.getByRole('menuitem', { name: 'Summarize current page' }).click();
  await expect(popup).toBeVisible();
  await expect(popup.locator('#answer')).toHaveText('A useful response about this source.');
  await page.getByRole('button', { name: 'Close expanded answer' }).click();

  await selectPassage(page);
  await page.locator('.textLayer span').first().click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Summarize selection', exact: true }).click();
  await expect(popup.locator('#answer-source')).toContainText('Selection · Page 1');
  await expect(popup.locator('#answer')).toHaveText('A useful response about this source.');
  await page.getByRole('button', { name: 'Close expanded answer' }).click();

  await selectPassage(page);
  await page.locator('.textLayer span').first().click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Ask selection', exact: true }).click();
  await expect(popup.getByLabel('Your question')).toBeVisible();
  await popup.getByLabel('Your question').fill('Explain this passage.');
  await popup.getByRole('button', { name: 'Send question', exact: true }).click();
  await expect(popup.locator('#answer')).toHaveText('A useful response about this source.');
  await page.getByRole('button', { name: 'Close expanded answer' }).click();

  await page.locator('#viewport').click({ button: 'right', position: { x: 10, y: 10 } });
  await menu.getByRole('menuitem', { name: 'Ask current page' }).click();
  await popup.getByLabel('Your question').fill('Explain this page.');
  await popup.getByRole('button', { name: 'Send question', exact: true }).click();
  await expect(popup.locator('#answer')).toHaveText('A useful response about this source.');
  const requests = await page.evaluate(() => window.sentRequests.map(item => item.request));
  expect(requests.map(request => request.action)).toEqual(['summarize', 'summarize', 'ask', 'ask']);
  expect(requests[0].text).toContain('Reading slowly helps');
  expect(requests[1].text).toBe('The quiet art of paying attention');
  expect(requests[2].text).toBe('The quiet art of paying attention');
  expect(requests[3].text).toContain('Reading slowly helps');
  await page.keyboard.press('Escape');
  await expect(page.locator('html')).toHaveAttribute('data-reader-fullscreen', 'true');
  await expect(page.locator('#viewport')).toBeFocused();
});

test('fullscreen AI menu stays on screen and Escape dismisses it before fullscreen', async ({ page }) => {
  await openPDF(page);
  await page.getByRole('button', { name: 'PDF fullscreen', exact: true }).click();
  await page.locator('#viewport').dispatchEvent('contextmenu', { clientX: 1278, clientY: 858 });
  const menu = page.getByRole('menu', { name: 'PDF AI actions' });
  await expect(menu).toBeVisible();
  const bounds = await menu.boundingBox();
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(1280);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(860);
  await expect(menu.getByRole('menuitem', { name: 'Summarize current page' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Ask current page' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(page.locator('html')).toHaveAttribute('data-reader-fullscreen', 'true');
});

test('fullscreen AI errors are visible in the popup', async ({ page }) => {
  await openPDF(page); await configure(page);
  await page.evaluate(() => { window.failAI = true; });
  await page.getByRole('button', { name: 'PDF fullscreen', exact: true }).click();
  await page.locator('#viewport').click({ button: 'right', position: { x: 10, y: 10 } });
  await page.getByRole('menuitem', { name: 'Summarize current page' }).click();
  await expect(page.locator('#answer-dialog #ai-error')).toContainText('401');
});

test('j/k scroll a long answer popup without changing the PDF or question text', async ({ page }) => {
  await openPDF(page); await configure(page);
  await page.locator('[data-scope="page"][data-action="summarize"]').click();
  await expect(page.locator('#answer')).toHaveText('A useful response about this source.');
  await page.locator('#answer').evaluate(element => { element.textContent = 'A long answer paragraph.\n\n'.repeat(100); });
  await page.getByRole('button', { name: 'Expand AI answer' }).click();
  await page.keyboard.press('j');
  await expect.poll(() => page.locator('#expanded-content').evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await page.keyboard.press('k');
  await expect.poll(() => page.locator('#expanded-content').evaluate(element => element.scrollTop)).toBe(0);
  await page.keyboard.press('l');
  await expect(page.locator('#page-number')).toHaveValue('1');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'PDF fullscreen', exact: true }).click();
  await page.locator('#viewport').click({ button: 'right', position: { x: 10, y: 10 } });
  await page.getByRole('menuitem', { name: 'Ask current page' }).click();
  await page.locator('#answer-dialog').getByLabel('Your question').pressSequentially('jk');
  await expect(page.getByLabel('Your question')).toHaveValue('jk');
});
