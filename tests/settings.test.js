import test from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsStore, documentKey, effectiveTheme, lastPage, rememberPage } from '../src/settings.js';

test('theme follows the system only until the user makes an explicit choice', () => {
  assert.equal(effectiveTheme('system', true), 'dark');
  assert.equal(effectiveTheme('system', false), 'light');
  assert.equal(effectiveTheme('light', true), 'light');
  assert.equal(effectiveTheme('dark', false), 'dark');
});

test('restores credentials and preferences from desktop storage', async () => {
  const store = createSettingsStore(async command => {
    assert.equal(command, 'load_settings');
    return { endpoint_url: 'https://example.com/v1', api_key: 'saved-key', model: 'model', theme: 'dark', zoom: 1.3 };
  });
  const settings = await store.load();
  assert.equal(settings.api_key, 'saved-key');
  assert.equal(settings.theme, 'dark');
  assert.equal(settings.zoom, 1.3);
});

test('serializes writes so an older slow save cannot overwrite a newer theme', async () => {
  const saved = [];
  let release;
  const first = new Promise(resolve => { release = resolve; });
  const store = createSettingsStore(async (_, { settings }) => {
    if (!saved.length) { saved.push(settings.theme); await first; }
    else saved.push(settings.theme);
  });
  const input = { theme: 'dark' };
  const a = store.save(input);
  input.theme = 'light';
  const b = store.save(input);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(saved, ['dark']);
  release();
  await Promise.all([a, b]);
  assert.deepEqual(saved, ['dark', 'light']);
});

test('reports a failed save and allows a later retry', async () => {
  let attempts = 0;
  const store = createSettingsStore(async () => { if (++attempts === 1) throw new Error('disk full'); });
  await assert.rejects(store.save({ theme: 'dark' }), /disk full/);
  await store.save({ theme: 'light' });
  assert.equal(attempts, 2);
});

test('a failed restore blocks autosaves until an explicit successful replacement', async () => {
  const writes = [];
  const store = createSettingsStore(async (command, args) => {
    if (command === 'load_settings') throw new Error('unreadable file');
    writes.push(args.settings);
  });
  await assert.rejects(store.load(), /unreadable file/);
  await assert.rejects(store.save({ theme: 'dark' }), /could not be loaded/i);
  assert.deepEqual(writes, []);
  await store.save({ api_key: 'replacement', theme: 'light' }, true);
  await store.save({ api_key: 'replacement', theme: 'dark' });
  assert.equal(writes.length, 2);
  assert.equal(writes[0].api_key, 'replacement');
});

test('restores each PDF independently and clamps stale page numbers', () => {
  const positions = [{ document_id: 'first', page: 12 }, { document_id: 'second', page: 3 }];
  assert.equal(lastPage(positions, 'first', 20), 12);
  assert.equal(lastPage(positions, 'second', 10), 3);
  assert.equal(lastPage(positions, 'new', 10), 1);
  assert.equal(lastPage(positions, 'first', 8), 8);
});

test('updating a position keeps other PDFs and earlier save snapshots intact', () => {
  const positions = [{ document_id: 'first', page: 2 }, { document_id: 'second', page: 7 }];
  const updated = rememberPage(positions, 'first', 5);
  assert.equal(lastPage(updated, 'first', 10), 5);
  assert.equal(lastPage(updated, 'second', 10), 7);
  assert.equal(lastPage(positions, 'first', 10), 2);
  assert.equal(updated.length, 2);
});

test('reading history retains the most recent 100 PDFs', () => {
  let positions = [];
  for (let i = 0; i < 101; i++) positions = rememberPage(positions, `pdf-${i}`, 2);
  assert.equal(positions.length, 100);
  assert.equal(lastPage(positions, 'pdf-0', 5), 1);
  assert.equal(lastPage(positions, 'pdf-100', 5), 2);
});

test('document identity follows file contents rather than its name or embedded PDF ID', async () => {
  const bytes = new TextEncoder().encode('abc');
  assert.equal(await documentKey(bytes), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(await documentKey(bytes), await documentKey(bytes.slice()));
  assert.notEqual(await documentKey(bytes), await documentKey(new TextEncoder().encode('abd')));
});

test('separate paths keep independent positions even for identical PDFs', () => {
  let positions = rememberPage([], 'same-content', 2, { path: '/one.pdf', scroll_top: 120, zoom: 1.5 });
  positions = rememberPage(positions, 'same-content', 3, { path: '/two.pdf', scroll_top: 40, zoom: 1 });
  positions = rememberPage(positions, 'same-content', 4, { path: '/one.pdf', scroll_top: 80, zoom: 2 });
  assert.equal(positions.length, 2);
  assert.equal(positions.find(position => position.path === '/one.pdf').page, 4);
  assert.equal(positions.find(position => position.path === '/two.pdf').page, 3);
  assert.equal(positions.find(position => position.path === '/one.pdf').scroll_top, 80);
});

test('shutdown flush waits for the queued settings write', async () => {
  let release;
  const store = createSettingsStore(() => new Promise(resolve => { release = resolve; }));
  const write = store.save({ theme: 'dark' });
  let finished = false;
  const flush = store.flush().then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  release();
  await Promise.all([write, flush]);
  assert.equal(finished, true);
});
