import './style.css';
import MarkdownIt from 'markdown-it';
import { getDocument, GlobalWorkerOptions, TextLayer } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { captureContext, captureAvailableContexts, pageText, selectionText } from './context.js';
import { createSettingsStore, defaultSettings, documentKey, effectiveTheme, lastPage, rememberPage } from './settings.js';
import { handleReaderKey, handleRecolorKey, handleFullscreenKey } from './keyboard.js';

GlobalWorkerOptions.workerSrc = workerUrl;
const markdown = new MarkdownIt({ html: false }).disable('image');
const $ = id => document.getElementById(id);
const actions = [...document.querySelectorAll('[data-action]')];
const menuActions = [...document.querySelectorAll('[data-context-action]')];
let menuSources = null;
let reader = { pdf: null, documentId: '', page: 1, text: '', selection: '', scale: 1, rendering: false };
const tabs = [];
let restoringTabs = false;
let positionTimer;
let closeSaveFailed = false;
let settings = { ...defaultSettings };
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
const settingsStore = createSettingsStore((command, args) => {
  if (!window.__TAURI__?.core) throw new Error('Use the desktop app to save settings.');
  return window.__TAURI__.core.invoke(command, args);
});
let pendingQuestion = null;
let renderVersion = 0;
let loadVersion = 0;
let aiVersion = 0;
let busy = false;
let loadingTask = null;
let renderTask = null;
let textLayer = null;
let nativeOpening = false;
let readerFullscreen = false;
let fullscreenChanging = false;
const desktopWindow = window.__TAURI__?.window?.getCurrentWindow();

function errorAt(id, error = '') {
  $(id).textContent = typeof error === 'string' ? error : error.message || String(error);
  $(id).hidden = !error;
}

function updateControls() {
  const ready = !!reader.pdf && !reader.rendering;
  $('previous').disabled = !ready || reader.page <= 1;
  $('next').disabled = !ready || reader.page >= reader.pdf.numPages;
  $('page-number').disabled = !ready;
  $('zoom-in').disabled = !ready || reader.scale >= 2.5;
  $('zoom-out').disabled = !ready || reader.scale <= 0.35;
  $('fit').disabled = !ready;
  $('page-number').value = reader.page;
  $('page-count').textContent = `of ${reader.pdf?.numPages ?? '—'}`;
  $('page-number').max = reader.pdf?.numPages ?? 1;
  $('zoom-label').textContent = `${Math.round(reader.scale * 100)}%`;
  $('current-page-badge').textContent = reader.pdf ? `Page ${reader.page}` : '—';
  $('selection-badge').textContent = reader.selection ? `${reader.selection.length.toLocaleString()} characters` : 'No selection';
  $('selection-status').textContent = reader.selection ? `${reader.selection.length.toLocaleString()} characters selected` : 'Select a passage to explore it';
  for (const button of actions) {
    button.disabled = !ready || busy || (button.dataset.scope === 'selection' ? !reader.selection : !reader.text.trim());
  }
  for (const button of menuActions) button.disabled = !ready || busy || !menuSources?.[button.dataset.contextScope];
  $('send').disabled = busy;
  $('question').disabled = busy;
  $('copy').disabled = busy || !$('answer').textContent;
  $('expand-answer').disabled = $('copy').disabled;
  $('pdf-fullscreen').disabled = !readerFullscreen && !ready;
}

async function renderPage(number, scale = reader.scale, rememberZoom = false, position = null) {
  if (!reader.pdf || !Number.isInteger(number) || number < 1 || number > reader.pdf.numPages) {
    $('page-number').value = reader.page;
    return;
  }
  const version = ++renderVersion;
  hideContextMenu();
  renderTask?.cancel();
  textLayer?.cancel();
  reader.rendering = true;
  reader.selection = '';
  window.getSelection()?.removeAllRanges();
  updateControls();
  errorAt('reader-error');
  try {
    const page = await reader.pdf.getPage(number);
    if (version !== renderVersion) return;
    const viewport = page.getViewport({ scale });
    if (viewport.width > 14000 || viewport.height > 14000) throw new Error('This page is too large at this zoom. Try zooming out.');
    const content = await page.getTextContent();
    if (version !== renderVersion) return;
    const surface = document.createElement('div');
    surface.className = 'pdf-page';
    surface.id = 'page';
    surface.style.width = `${viewport.width}px`;
    surface.style.height = `${viewport.height}px`;
    surface.style.setProperty('--scale-factor', scale);
    surface.style.setProperty('--total-scale-factor', scale);
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-label', `PDF page ${number}`);
    const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(16_000_000 / (viewport.width * viewport.height)));
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    const layer = document.createElement('div');
    layer.className = 'textLayer';
    surface.append(canvas, layer);
    renderTask = page.render({ canvasContext: canvas.getContext('2d'), viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
    await renderTask.promise;
    if (version !== renderVersion) return;
    // TextLayer measures font sizes through computed styles, so attach it before rendering.
    $('page').replaceWith(surface);
    $('empty').hidden = true;
    $('page-shell').hidden = false;
    textLayer = new TextLayer({ textContentSource: content, container: layer, viewport });
    await textLayer.render();
    if (version !== renderVersion) return;
    reader.page = number;
    reader.scale = scale;
    reader.text = pageText(content);
    $('viewport').scrollTop = position?.scroll_top ?? 0;
    $('viewport').scrollLeft = position?.scroll_left ?? 0;
    reader.scroll_top = $('viewport').scrollTop;
    reader.scroll_left = $('viewport').scrollLeft;
    $('document-status').textContent = reader.text.trim() ? `Page ${number} of ${reader.pdf.numPages} · Text ready` : `Page ${number} · No text layer (OCR needed)`;
    if (rememberZoom) settings = { ...settings, zoom: scale };
    saveSession().catch(error => errorAt('reader-error', error));
  } catch (error) {
    if (version !== renderVersion || error.name === 'RenderingCancelledException' || error.name === 'AbortException') return;
    reader.text = '';
    errorAt('reader-error', error);
  } finally {
    if (version === renderVersion) {
      reader.rendering = false;
      updateControls();
    }
  }
}

function updateTabs() {
  $('pdf-tabs').hidden = tabs.length < 2;
  $('pdf-tabs').replaceChildren(...tabs.map(tab => {
    const item = document.createElement('div');
    item.className = 'pdf-tab';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pdf-tab-name';
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(tab === reader));
    button.tabIndex = tab === reader ? 0 : -1;
    button.setAttribute('aria-controls', 'viewport');
    button.textContent = tab.name;
    button.title = tab.path || tab.name;
    button.addEventListener('click', () => activateTab(tab));
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'pdf-tab-close';
    close.setAttribute('aria-label', `Close ${tab.name}`);
    close.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-close"/></svg>';
    close.addEventListener('click', () => closeTab(tab));
    item.append(button, close);
    return item;
  }));
}

function capturePosition() {
  if (!reader.pdf || reader.rendering) return;
  reader.scroll_top = $('viewport').scrollTop;
  reader.scroll_left = $('viewport').scrollLeft;
}

function saveSession() {
  if (!window.__TAURI__?.core || restoringTabs) return Promise.resolve();
  let positions = settings.reading_positions;
  for (const tab of tabs) positions = rememberPage(positions, tab.documentId, tab.page, {
    path: tab.path, scroll_top: tab.scroll_top ?? 0, scroll_left: tab.scroll_left ?? 0, zoom: tab.scale,
  });
  return saveSettings({ reading_positions: positions, open_pdf_paths: tabs.filter(tab => tab.path).map(tab => tab.path), active_pdf_path: reader.path ?? null });
}

async function activateTab(tab, cancelLoad = true) {
  capturePosition();
  if (cancelLoad) {
    ++loadVersion;
    const task = loadingTask;
    loadingTask = null;
    task?.destroy();
  }
  hideContextMenu();
  if ($('answer-dialog').open) $('answer-dialog').close();
  ++aiVersion;
  busy = false;
  pendingQuestion = null;
  $('question-form').hidden = true;
  $('question').value = '';
  $('answer-card').hidden = true;
  $('assistant-empty').hidden = false;
  $('answer').textContent = '';
  $('answer').classList.remove('loading');
  errorAt('ai-error');
  reader = tab;
  $('filename').textContent = tab.name;
  updateTabs();
  // Hide the previous document until this tab finishes rendering.
  $('page-shell').hidden = true;
  await renderPage(tab.page, tab.scale, false, { scroll_top: tab.scroll_top, scroll_left: tab.scroll_left });
}

async function closeTab(tab) {
  capturePosition();
  const index = tabs.indexOf(tab);
  if (index < 0) return;
  tabs.splice(index, 1);
  if (tab === reader) {
    if (tabs.length) await activateTab(tabs[Math.min(index, tabs.length - 1)]);
    else {
      ++loadVersion;
      ++renderVersion;
      ++aiVersion;
      busy = false;
      renderTask?.cancel();
      textLayer?.cancel();
      reader = { pdf: null, documentId: '', page: 1, text: '', selection: '', scale: settings.zoom ?? 1, rendering: false };
      $('filename').textContent = 'No document open';
      $('page-shell').hidden = true;
      $('empty').hidden = false;
      $('document-status').textContent = 'Local by default';
      $('answer-card').hidden = true;
      $('question-form').hidden = true;
      updateControls();
    }
  }
  updateTabs();
  await tab.pdf.destroy();
  saveSession().catch(error => errorAt('reader-error', error));
}

async function openFile(file, path = null) {
  if (!file) return;
  await settingsReady;
  if (file.size > 100 * 1024 * 1024) return errorAt('reader-error', 'Please open a PDF smaller than 100 MiB.');
  const version = ++loadVersion;
  const previousTask = loadingTask;
  loadingTask = null;
  await previousTask?.destroy();
  let pdf;
  let task;
  try {
    const data = new Uint8Array(await file.arrayBuffer());
    const documentId = await documentKey(data);
    if (version !== loadVersion) return;
    const existing = tabs.find(tab => path ? tab.path === path : !tab.path && tab.name === file.name && tab.documentId === documentId);
    if (existing) { await activateTab(existing, false); return; }
    task = getDocument({
      data,
      cMapUrl: '/pdf-assets/cmaps/', cMapPacked: true,
      standardFontDataUrl: '/pdf-assets/standard_fonts/', wasmUrl: '/pdf-assets/wasm/',
      isEvalSupported: false,
    });
    loadingTask = task;
    // shortcut: encrypted documents are rejected; add a password dialog when encrypted PDFs are needed.
    task.onPassword = () => { task.destroy(); errorAt('reader-error', 'Password-protected PDFs are not supported yet. Open an unlocked copy.'); };
    pdf = await task.promise;
    if (version !== loadVersion) { await pdf.destroy(); return; }
    const saved = settings.reading_positions.find(position => position.document_id === documentId && (position.path ?? null) === path)
      ?? settings.reading_positions.findLast(position => position.document_id === documentId);
    const page = lastPage(saved ? [saved] : [], saved?.document_id ?? documentId, pdf.numPages);
    const firstPage = await pdf.getPage(page);
    if (version !== loadVersion) { await pdf.destroy(); return; }
    const width = firstPage.getViewport({ scale: 1 }).width;
    const scale = saved?.zoom ?? settings.zoom ?? Math.max(0.35, Math.min(1.25, ($('viewport').clientWidth - 64) / width));
    const tab = { pdf, documentId, name: file.name, path, page, scale, text: '', selection: '', rendering: false,
      scroll_top: saved?.scroll_top ?? 0, scroll_left: saved?.scroll_left ?? 0 };
    tabs.push(tab);
    loadingTask = null;
    await activateTab(tab, false);
  } catch (error) {
    if (version !== loadVersion) return;
    await task?.destroy();
    errorAt('reader-error', error.name === 'PasswordException' ? 'Open an unlocked copy of this PDF.' : `Could not open this PDF. ${error.message || ''}`);
  } finally {
    if (version === loadVersion) loadingTask = null;
  }
}

async function openNativePdf(restore = false) {
  if (nativeOpening) return;
  nativeOpening = true;
  restoringTabs = restore;
  const failures = [];
  try {
    await settingsReady;
    const activePath = settings.active_pdf_path;
    const files = restore ? await window.__TAURI__.core.invoke('restore_pdf')
      : [await window.__TAURI__.core.invoke('choose_pdf')].filter(Boolean);
    for (const file of files) {
      try {
        const existing = tabs.find(tab => tab.path === file.path);
        if (existing) { await activateTab(existing); continue; }
        const bytes = await window.__TAURI__.core.invoke('read_selected_pdf', { path: file.path });
        const count = tabs.length;
        await openFile(new File([new Uint8Array(bytes)], file.name, { type: 'application/pdf' }), file.path);
        if (tabs.length === count) failures.push(file.name);
      } catch (error) { failures.push(`${file.name}: ${error}`); }
    }
    if (restore) {
      const active = tabs.find(tab => tab.path === activePath);
      if (active) await activateTab(active);
    }
  } catch (error) {
    failures.push(String(error));
  } finally {
    restoringTabs = false;
    nativeOpening = false;
    if (tabs.length) await saveSession().catch(error => failures.push(String(error)));
    if (failures.length) errorAt('reader-error', `${restore ? 'Could not reopen PDFs' : 'Could not open PDF'}: ${failures.join('; ')}`);
  }
}

function requestOpenPdf() {
  if (window.__TAURI__?.core) openNativePdf();
  else $('file').click();
}

function applySettings() {
  const theme = effectiveTheme(settings.theme, systemTheme.matches);
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.recolorPdf = String(settings.recolor_pdf);
  $('recolor-pdf').setAttribute('aria-pressed', String(settings.recolor_pdf));
  $('recolor-pdf').title = `${settings.recolor_pdf ? 'Restore original PDF colors' : 'Recolor PDF for dark reading'} (Ctrl+R)`;
  const label = `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`;
  $('theme-toggle').setAttribute('aria-label', label);
  $('theme-toggle').setAttribute('aria-pressed', String(theme === 'dark'));
  $('theme-toggle').title = label;
  $('theme-icon').setAttribute('href', theme === 'dark' ? '#i-sun' : '#i-moon');
  $('provider-label').textContent = settings.model || 'Connect your AI provider';
  $('provider-dot').classList.toggle('unconfigured', !settings.model);
}

async function restoreSettings() {
  try {
    if (window.__TAURI__?.core) settings = await settingsStore.load();
    reader.scale = settings.zoom ?? 1;
  } catch (error) { errorAt('reader-error', error); }
  applySettings();
  updateControls();
}

function saveSettings(patch, replaceUnreadable = false) {
  settings = { ...settings, ...patch };
  applySettings();
  return settingsStore.save(settings, replaceUnreadable);
}

async function showSettings() {
  await settingsReady;
  for (const name of ['endpoint_url', 'api_key', 'model', 'theme']) $('settings-form').elements[name].value = settings[name];
  $('reopen-last-pdf').checked = settings.reopen_last_pdf;
  errorAt('settings-error');
  $('settings-dialog').showModal();
}

function validateSettings(input) {
  if (!input.endpoint_url && !input.model && !input.api_key) return;
  let url;
  try { url = new URL(input.endpoint_url); } catch { throw new Error('Enter a valid endpoint URL.'); }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('Use HTTPS, or HTTP for localhost.');
  if (url.username || url.password || url.search || url.hash) throw new Error('Use an endpoint without credentials, query, or fragment.');
  if (!input.model) throw new Error('Enter a model name.');
}

async function runAI(action, source, question = '', popup = false) {
  if (busy) return;
  if (!settings.endpoint_url || !settings.model) {
    errorAt(readerFullscreen ? 'reader-error' : 'ai-error', 'Connect your AI provider, then choose the action again.');
    showSettings();
    return;
  }
  if (!window.__TAURI__?.core) return errorAt(readerFullscreen ? 'reader-error' : 'ai-error', 'AI requests run through the Rust desktop app. Start it with npm run desktop.');
  const version = ++aiVersion;
  busy = true;
  errorAt('ai-error');
  $('assistant-empty').hidden = true;
  $('answer-card').hidden = false;
  $('answer-kind').textContent = action === 'summarize' ? 'Summary' : 'Answer';
  $('answer-source').textContent = `${source.label} · ${settings.model}`;
  $('asked-question').textContent = question;
  $('asked-question').hidden = !question;
  $('answer').textContent = 'Reading between the lines…';
  $('answer').classList.add('loading');
  if (popup) showAnswerPopup();
  updateControls();
  try {
    const answer = await window.__TAURI__.core.invoke('complete', { request: { ...settings, action, text: source.text, question } });
    if (version === aiVersion) $('answer').innerHTML = markdown.render(answer);
  } catch (error) {
    if (version === aiVersion) {
      $('answer').textContent = '';
      errorAt('ai-error', String(error));
    }
  } finally {
    if (version === aiVersion) {
      busy = false;
      $('answer').classList.remove('loading');
      updateControls();
    }
  }
}

for (const id of ['open', 'open-empty']) $(id).addEventListener('click', requestOpenPdf);
$('file').addEventListener('change', event => { openFile(event.target.files[0]); event.target.value = ''; });
$('previous').addEventListener('click', () => renderPage(reader.page - 1));
$('next').addEventListener('click', () => renderPage(reader.page + 1));
$('page-number').addEventListener('change', event => renderPage(Number(event.target.value)));
$('zoom-in').addEventListener('click', () => renderPage(reader.page, Math.min(2.5, reader.scale + 0.15), true));
$('zoom-out').addEventListener('click', () => renderPage(reader.page, Math.max(0.35, reader.scale - 0.15), true));
$('fit').addEventListener('click', async () => {
  const page = await reader.pdf.getPage(reader.page);
  renderPage(reader.page, Math.max(0.35, Math.min(2.5, ($('viewport').clientWidth - 64) / page.getViewport({ scale: 1 }).width)), true);
});
document.addEventListener('selectionchange', () => {
  const selection = window.getSelection();
  const layer = $('page').querySelector('.textLayer');
  if (selection?.isCollapsed && !layer?.contains(selection.anchorNode)) return;
  reader.selection = selectionText(selection, layer);
  updateControls();
});
function activateAI(action, source, popup = false) {
  errorAt('ai-error');
  if (action === 'ask') {
    pendingQuestion = source;
    $('question-form').hidden = false;
    $('question-source').textContent = source.label;
    if (popup) showAnswerPopup(true);
    $('question').focus();
  } else {
    runAI('summarize', source, '', popup);
  }
}
for (const button of actions) {
  button.addEventListener('mousedown', event => event.preventDefault());
  button.addEventListener('click', () => {
    try {
      const source = captureContext(reader, button.dataset.scope);
      activateAI(button.dataset.action, source);
    } catch (error) { errorAt('ai-error', error); }
  });
}
$('question-form').addEventListener('submit', event => {
  event.preventDefault();
  if (pendingQuestion && $('question').value.trim()) runAI('ask', pendingQuestion, $('question').value.trim(), readerFullscreen || $('answer-dialog').open);
});
$('question').addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); $('question-form').requestSubmit(); }
});
for (const id of ['settings', 'provider']) $(id).addEventListener('click', showSettings);
for (const id of ['close-settings', 'cancel-settings']) $(id).addEventListener('click', () => $('settings-dialog').close());
$('settings-dialog').addEventListener('close', () => { $('api-key').value = ''; });
$('settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  const input = Object.fromEntries(new FormData(event.target));
  for (const key in input) input[key] = input[key].trim();
  input.reopen_last_pdf = $('reopen-last-pdf').checked;
  const submit = event.submitter;
  submit.disabled = true;
  try {
    validateSettings(input);
    await saveSettings(input, true);
    $('settings-dialog').close();
  } catch (error) { errorAt('settings-error', error); }
  finally { submit.disabled = false; }
});
$('theme-toggle').addEventListener('click', async () => {
  await settingsReady;
  try {
    await saveSettings({ theme: effectiveTheme(settings.theme, systemTheme.matches) === 'dark' ? 'light' : 'dark' });
  } catch (error) { errorAt('reader-error', error); }
});
async function togglePdfRecolor() {
  await settingsReady;
  try { await saveSettings({ recolor_pdf: !settings.recolor_pdf }); }
  catch (error) { errorAt('reader-error', error); }
}
$('recolor-pdf').addEventListener('click', togglePdfRecolor);
function applyFullscreen(fullscreen) {
  hideContextMenu();
  readerFullscreen = fullscreen;
  document.documentElement.dataset.readerFullscreen = String(fullscreen);
  const label = fullscreen ? 'Exit PDF fullscreen' : 'PDF fullscreen';
  $('pdf-fullscreen').setAttribute('aria-label', label);
  $('pdf-fullscreen').setAttribute('aria-pressed', String(fullscreen));
  $('pdf-fullscreen').title = fullscreen ? 'Exit PDF fullscreen (Esc / F11)' : 'PDF fullscreen (F11)';
  $('fullscreen-icon').setAttribute('href', fullscreen ? '#i-collapse' : '#i-expand');
  updateControls();
}
async function setReaderFullscreen(fullscreen) {
  if (fullscreenChanging || (fullscreen && (!reader.pdf || reader.rendering))) return;
  fullscreenChanging = true;
  try {
    if (desktopWindow) await desktopWindow.setFullscreen(fullscreen);
    else if (fullscreen) await document.querySelector('.reader').requestFullscreen();
    else if (document.fullscreenElement) await document.exitFullscreen();
    applyFullscreen(fullscreen);
  } catch (error) { errorAt('reader-error', `Could not change fullscreen mode. ${error}`); }
  finally { fullscreenChanging = false; }
}
$('pdf-fullscreen').addEventListener('click', () => setReaderFullscreen(!readerFullscreen));
document.addEventListener('fullscreenchange', () => {
  if (!desktopWindow) applyFullscreen(!!document.fullscreenElement);
});
if (desktopWindow) {
  const syncFullscreen = () => {
    if (!fullscreenChanging) desktopWindow.isFullscreen().then(applyFullscreen).catch(error => errorAt('reader-error', String(error)));
  };
  desktopWindow.onResized(syncFullscreen).then(syncFullscreen).catch(error => errorAt('reader-error', String(error)));
}
systemTheme.addEventListener('change', () => { if (settings.theme === 'system') applySettings(); });
$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('answer').innerText); $('copy').title = 'Copied'; }
  catch { errorAt($('answer-dialog').open ? 'expanded-error' : 'ai-error', 'Clipboard access is unavailable. Select and copy the answer text.'); }
});
function showAnswerPopup(includeQuestion = false) {
  errorAt('expanded-error');
  $('answer-dialog-title').textContent = includeQuestion ? 'Ask about PDF' : 'AI response';
  if (includeQuestion) $('expanded-content').prepend($('question-form'));
  $('expanded-content').append($('ai-error'), $('answer-card'));
  if (!$('answer-dialog').open) $('answer-dialog').showModal();
  $('expanded-content').scrollTop = 0;
}
$('expand-answer').addEventListener('click', () => showAnswerPopup());
$('close-answer').addEventListener('click', () => $('answer-dialog').close());
$('answer-dialog').addEventListener('close', () => {
  $('answer-area').before($('question-form'), $('ai-error'));
  $('answer-area').append($('answer-card'));
  (readerFullscreen ? $('viewport') : $('answer-card').hidden ? $('question') : $('expand-answer')).focus();
});

function hideContextMenu() {
  $('pdf-context-menu').hidden = true;
  menuSources = null;
}
$('viewport').addEventListener('contextmenu', event => {
  if (!readerFullscreen || !reader.pdf) return;
  event.preventDefault();
  if (reader.rendering) return;
  menuSources = captureAvailableContexts({ ...reader, selection: selectionText(window.getSelection(), $('page').querySelector('.textLayer')) });
  const menu = $('pdf-context-menu');
  menu.hidden = false;
  updateControls();
  const bounds = menu.getBoundingClientRect();
  const viewport = $('viewport').getBoundingClientRect();
  const x = event.clientX || viewport.left + 24;
  const y = event.clientY || viewport.top + 24;
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8))}px`;
  (menu.querySelector('button:not(:disabled)') || menu).focus({ preventScroll: true });
});
for (const button of menuActions) {
  button.addEventListener('mousedown', event => event.preventDefault());
  button.addEventListener('click', () => {
    const source = menuSources?.[button.dataset.contextScope];
    hideContextMenu();
    if (source) activateAI(button.dataset.contextAction, source, true);
  });
}
document.addEventListener('pointerdown', event => {
  if (!$('pdf-context-menu').contains(event.target)) hideContextMenu();
});
$('viewport').addEventListener('scroll', hideContextMenu);
window.addEventListener('resize', hideContextMenu);
window.addEventListener('blur', hideContextMenu);
$('pdf-context-menu').addEventListener('keydown', event => {
  const items = menuActions.filter(button => !button.disabled);
  const index = items.indexOf(document.activeElement);
  let next;
  if (event.key === 'ArrowDown') next = index < 0 ? 0 : (index + 1) % items.length;
  else if (event.key === 'ArrowUp') next = index < 0 ? items.length - 1 : (index - 1 + items.length) % items.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = items.length - 1;
  else if (event.key === 'Tab') { hideContextMenu(); $('viewport').focus(); }
  else return;
  event.preventDefault();
  event.stopPropagation();
  items[next]?.focus();
});
document.addEventListener('keydown', event => {
  if (!$('pdf-context-menu').hidden) {
    if (event.key === 'Escape') {
      event.preventDefault(); hideContextMenu(); $('viewport').focus(); return;
    }
    if (event.key === 'F11' || event.ctrlKey || event.metaKey) hideContextMenu();
    else return;
  }
  if (handleFullscreenKey(event, readerFullscreen, setReaderFullscreen, !!document.querySelector('dialog[open]'))) return;
  if (handleRecolorKey(event, togglePdfRecolor)) return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'o') { event.preventDefault(); requestOpenPdf(); }
  const answerOpen = $('answer-dialog').open;
  if (!answerOpen && (!reader.pdf || reader.rendering)) return;
  handleReaderKey(event, answerOpen ? $('expanded-content') : $('viewport'), direction => {
    if (!answerOpen) renderPage(reader.page + direction);
  });
});
applySettings();
const settingsReady = restoreSettings();
settingsReady.then(() => {
  if (window.__TAURI__?.core && settings.reopen_last_pdf && (settings.open_pdf_paths?.length || (settings.open_pdf_paths === null && settings.last_pdf_path))) openNativePdf(true);
});

$('pdf-tabs').addEventListener('keydown', event => {
  if (event.target.getAttribute('role') !== 'tab') return;
  const index = tabs.indexOf(reader);
  const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
    : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
    : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
  if (next === null) return;
  event.preventDefault();
  activateTab(tabs[next]);
  $('pdf-tabs').querySelector('[aria-selected="true"]').focus();
});
$('viewport').addEventListener('scroll', () => {
  if (!reader.pdf || reader.rendering) return;
  capturePosition();
  clearTimeout(positionTimer);
  positionTimer = setTimeout(() => saveSession().catch(error => errorAt('reader-error', error)), 200);
});
if (desktopWindow?.onCloseRequested) desktopWindow.onCloseRequested(async event => {
  event.preventDefault();
  if (closeSaveFailed) { await desktopWindow.destroy(); return; }
  clearTimeout(positionTimer);
  capturePosition();
  try {
    await settingsReady;
    if (tabs.length) await saveSession();
    await settingsStore.flush();
    await desktopWindow.destroy();
  } catch (error) {
    closeSaveFailed = true;
    errorAt('reader-error', `${error} Close again to exit without saving the latest position.`);
  }
});
