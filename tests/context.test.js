import test from 'node:test';
import assert from 'node:assert/strict';
import { pageText, selectionText, captureContext, captureAvailableContexts } from '../src/context.js';

test('PDF text preserves line breaks and word boundaries', () => {
  assert.equal(pageText({ items: [
    { str: 'Hello', hasEOL: false }, { str: 'world', hasEOL: true },
    { type: 'beginMarkedContent' }, { str: 'Next line', hasEOL: true },
  ] }), 'Hello world\nNext line');
});

test('selection must start and end inside the PDF text layer', () => {
  const inside = {};
  const outside = {};
  const layer = { contains: node => node === inside };
  const selection = { anchorNode: inside, focusNode: inside, toString: () => ' selected words ' };
  assert.equal(selectionText(selection, layer), 'selected words');
  assert.equal(selectionText({ ...selection, focusNode: outside }, layer), '');
  assert.equal(selectionText(null, layer), '');
});

test('AI source snapshots stay attached to the page and selection at send time', () => {
  const reader = { page: 2, text: 'Entire page', selection: 'One sentence' };
  const snapshot = captureContext(reader, 'selection');
  reader.page = 3;
  reader.selection = 'Other sentence';
  assert.deepEqual(snapshot, { text: 'One sentence', label: 'Selection · Page 2' });
  assert.deepEqual(captureContext(reader, 'page'), { text: 'Entire page', label: 'Page 3' });
});

test('empty context cannot produce an AI request', () => {
  assert.throws(() => captureContext({ page: 1, text: '', selection: '' }, 'page'), /no extractable text/i);
  assert.throws(() => captureContext({ page: 1, text: 'text', selection: ' ' }, 'selection'), /select text/i);
});

test('a right-click menu freezes both sources before focus can clear the selection', () => {
  const reader = { page: 7, text: 'Original page', selection: 'Highlighted passage' };
  const sources = captureAvailableContexts(reader);
  reader.page = 8; reader.text = 'Next page'; reader.selection = '';
  assert.deepEqual(sources.selection, { text: 'Highlighted passage', label: 'Selection · Page 7' });
  assert.deepEqual(sources.page, { text: 'Original page', label: 'Page 7' });
});

test('unavailable menu sources are disabled independently', () => {
  assert.deepEqual(captureAvailableContexts({ page: 1, text: 'Page text', selection: '' }), {
    selection: null, page: { text: 'Page text', label: 'Page 1' },
  });
  assert.deepEqual(captureAvailableContexts({ page: 1, text: ' ', selection: '' }), { selection: null, page: null });
});
