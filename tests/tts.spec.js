import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('./fixtures/reading.pdf', import.meta.url));
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.speechCalls = [];
    window.speechInstalled = false;
    window.testAudios = [];
    window.statusWaiters = [];
    window.Audio = class {
      constructor() { this.playbackRate = 1; window.testAudios.push(this); }
      async play() { this.played = true; }
      pause() { this.played = false; }
      removeAttribute() {}
      load() {}
    };
    let fullscreen = false;
    window.__TAURI__ = { window: { getCurrentWindow: () => ({
      isFullscreen: async () => fullscreen,
      setFullscreen: async value => { fullscreen = value; },
      onResized: async () => () => {},
    }) }, core: { invoke: async (command, args) => {
      window.speechCalls.push({ command, ...args });
      if (command === 'load_settings') return {};
      if (command === 'save_settings') return;
      if (command === 'restore_pdf') return [];
      if (command === 'tts_status') {
        if (window.holdStatus) await new Promise(resolve => { window.statusWaiters.push(resolve); });
        return { supported: true, installed: window.speechInstalled, phase: window.installHeld ? 'installing' : 'idle', downloaded: 25, total: 235000000 };
      }
      if (command === 'tts_install') {
        if (window.installFails) throw 'Download interrupted. Retry.';
        if (window.installHeld) await new Promise(resolve => { window.cancelInstall = resolve; });
        else window.speechInstalled = true;
        return;
      }
      if (command === 'tts_remove') { window.speechInstalled = false; return; }
      if (command === 'tts_stop') return;
      if (command === 'tts_cancel_install') { if (window.cancelInstall) { window.installHeld = false; window.cancelInstall(); } return; }
      if (command === 'tts_begin') return 1;
      if (command === 'tts_synthesize') {
        if (window.speechFails) throw 'The engine could not read this passage.';
        if (window.holdSynthesis) await new Promise(resolve => { window.finishSynthesis = resolve; });
        return new Uint8Array([1, 2, 3]).buffer;
      }
      if (command === 'complete') return '# Summary\n\nA helpful **answer**.';
    } } };
  });
});

async function openPdf(page) {
  await page.goto('/');
  await page.locator('#file').setInputFiles(fixture);
  await expect(page.locator('.textLayer')).toContainText('The quiet art');
}
async function selectText(page) {
  await page.locator('.textLayer span').first().evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
}

test('read aloud is opt-in and can be installed and removed without AI settings', async ({ page }) => {
  await openPdf(page);
  expect(await page.evaluate(() => window.speechCalls.some(call => call.command === 'tts_install'))).toBe(false);
  await selectText(page);
  await page.getByRole('button', { name: 'Read selection aloud', exact: true }).click();
  await expect(page.locator('#settings-dialog')).toBeVisible();
  await expect(page.locator('#speech-install')).toContainText('235.0 MB');
  await page.locator('#speech-install').click();
  await expect(page.locator('#speech-pack-status')).toContainText('Ready to read offline');
  await page.locator('#speech-remove').click();
  await expect(page.locator('#speech-install')).toBeVisible();
  expect(await page.evaluate(() => window.speechCalls.some(call => call.command === 'complete'))).toBe(false);
});

test('selection narration has pause, speed, stop and rejects late audio', async ({ page }) => {
  await openPdf(page);
  await page.evaluate(() => { window.speechInstalled = true; });
  await selectText(page);
  await page.locator('#speak-selection').click();
  await expect(page.locator('#speech-status')).toContainText('Reading');
  await page.locator('#speech-pause').click();
  await expect(page.locator('#speech-status')).toContainText('Paused');
  await page.locator('#speech-rate').selectOption('1.5');
  expect(await page.evaluate(() => window.testAudios.at(-1).playbackRate)).toBe(1.5);
  await page.locator('#speech-pause').click();
  await page.locator('#speech-stop').click();
  await expect(page.locator('#speech-player')).toBeHidden();
  const count = await page.evaluate(() => { window.holdSynthesis = true; return window.testAudios.length; });
  await page.locator('#speak-selection').click();
  await expect(page.locator('#speech-status')).toContainText('Preparing');
  await expect.poll(() => page.evaluate(() => !!window.finishSynthesis)).toBe(true);
  await page.locator('#speech-stop').click();
  await page.evaluate(() => window.finishSynthesis());
  await expect(page.locator('#speech-player')).toBeHidden();
  expect(await page.evaluate(() => window.testAudios.length)).toBe(count);
});

test('summary narration and controls remain available in the expanded answer', async ({ page }) => {
  await openPdf(page);
  await page.evaluate(() => { window.speechInstalled = true; });
  await page.locator('#settings').click();
  await page.getByLabel('Endpoint URL').fill('https://example.com/v1');
  await page.getByLabel('Model', { exact: true }).fill('test-model');
  await page.getByRole('button', { name: 'Use these settings' }).click();
  await page.locator('[data-scope="page"][data-action="summarize"]').click();
  await expect(page.locator('#answer strong')).toHaveText('answer');
  await page.locator('#expand-answer').click();
  await page.locator('#speak-answer').click();
  await expect(page.locator('#answer-dialog #speech-status')).toContainText('Reading');
  await page.evaluate(() => window.testAudios.at(-1).onended());
  await expect.poll(() => page.evaluate(() => window.speechCalls.filter(call => call.command === 'tts_synthesize').length)).toBe(2);
  const request = await page.evaluate(() => window.speechCalls.filter(call => call.command === 'tts_synthesize')[1]);
  expect(request.text).toContain('A helpful answer.');
  expect(request.text).not.toContain('**');
  await page.locator('#speech-stop').click();
  await page.locator('#close-answer').click();
  await expect(page.locator('#speech-home #speech-player')).toHaveCount(1);
});

test('fullscreen selection menu supports read aloud and visible playback errors', async ({ page }) => {
  await openPdf(page);
  await page.evaluate(() => { window.speechInstalled = true; window.speechFails = true; });
  await page.locator('#pdf-fullscreen').click();
  await selectText(page);
  await page.locator('.textLayer span').first().click({ button: 'right' });
  await page.locator('#speak-context-selection').click();
  await expect(page.locator('#speech-status')).toContainText('could not read');
  await expect(page.locator('#speech-stop')).toBeVisible();
});

test('failed downloads allow retry and cancellation keeps the pack uninstalled', async ({ page }) => {
  await page.goto('/');
  await page.locator('#settings').click();
  await page.evaluate(() => { window.installFails = true; });
  await page.locator('#speech-install').click();
  await expect(page.locator('#speech-setup-error')).toContainText('Download interrupted');
  await expect(page.locator('#speech-install')).toBeEnabled();
  await page.evaluate(() => { window.installFails = false; window.installHeld = true; });
  await page.locator('#speech-install').click();
  await expect(page.locator('#speech-progress')).toBeVisible();
  await page.locator('#speech-cancel').click();
  await page.evaluate(() => { window.installHeld = false; });
  await expect(page.locator('#speech-install')).toBeVisible();
  expect(await page.evaluate(() => window.speechInstalled)).toBe(false);
});

test('Stop cancels narration while optional voice status is still pending', async ({ page }) => {
  await openPdf(page);
  await page.evaluate(() => { window.speechInstalled = true; window.holdStatus = true; });
  await selectText(page);
  await page.locator('#speak-selection').click();
  await expect(page.locator('#speech-status')).toContainText('Preparing');
  await page.locator('#speech-stop').click();
  await page.evaluate(() => { window.holdStatus = false; window.statusWaiters.forEach(resolve => resolve()); });
  await expect(page.locator('#speech-player')).toBeHidden();
  expect(await page.evaluate(() => window.speechCalls.some(call => call.command === 'tts_begin'))).toBe(false);
});

test('Cancel before installation starts does not start a late download', async ({ page }) => {
  await page.goto('/');
  await page.locator('#settings').click();
  await expect(page.locator('#speech-install')).toBeEnabled();
  await page.evaluate(() => { window.holdStatus = true; });
  await page.locator('#speech-install').click();
  await page.locator('#speech-cancel').click();
  await page.evaluate(() => { window.holdStatus = false; window.statusWaiters.forEach(resolve => resolve()); });
  await expect(page.locator('#speech-install')).toBeVisible();
  expect(await page.evaluate(() => window.speechCalls.some(call => call.command === 'tts_install'))).toBe(false);
});
