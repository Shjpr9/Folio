import test from 'node:test';
import assert from 'node:assert/strict';
import { handleReaderKey, handleRecolorKey, handleFullscreenKey } from '../src/keyboard.js';

function press(key, overrides = {}) {
  return { key, defaultPrevented: false, isComposing: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
    target: { closest: () => null }, preventDefault() { this.defaultPrevented = true; }, ...overrides };
}

test('j and k scroll the PDF viewport down and up, including repeated key presses', () => {
  const viewport = { scrollTop: 200, scrollBy(x, y) { this.scrollTop += y; } };
  const down = press('j');
  handleReaderKey(down, viewport, () => assert.fail('scrolling must not change pages'));
  assert.equal(viewport.scrollTop, 280);
  assert.equal(down.defaultPrevented, true);
  handleReaderKey(press('j', { repeat: true }), viewport, () => assert.fail());
  assert.equal(viewport.scrollTop, 360);
  handleReaderKey(press('k'), viewport, () => assert.fail());
  assert.equal(viewport.scrollTop, 280);
});

test('h/l and existing arrow shortcuts move between pages', () => {
  let page = 5;
  const viewport = { scrollBy() { assert.fail('page navigation must not scroll the old page'); } };
  for (const [key, expected] of [['h', 4], ['l', 5], ['ArrowLeft', 4], ['ArrowRight', 5]]) {
    const event = press(key);
    handleReaderKey(event, viewport, direction => { page += direction; });
    assert.equal(page, expected);
    assert.equal(event.defaultPrevented, true);
  }
});

test('typing, native shortcuts, IME composition and handled events stay untouched', () => {
  const viewport = { scrollBy() { assert.fail('unexpected scroll'); } };
  for (const override of [
    { target: { closest: () => ({}) } },
    { ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { isComposing: true }, { defaultPrevented: true },
  ]) {
    for (const key of ['h', 'j', 'k', 'l']) {
      handleReaderKey(press(key, { preventDefault() { assert.fail('must preserve the event'); }, ...override }), viewport, () => assert.fail('unexpected page turn'));
    }
  }
  const unrelated = press('x');
  handleReaderKey(unrelated, viewport, () => assert.fail());
  assert.equal(unrelated.defaultPrevented, false);
});

test('Ctrl+R and Cmd+R toggle PDF recoloring and prevent webview reload', () => {
  let toggles = 0;
  for (const modifier of ['ctrlKey', 'metaKey']) {
    const event = press('r', { [modifier]: true, target: { closest: () => ({}) } });
    assert.equal(handleRecolorKey(event, () => { toggles++; }), true);
    assert.equal(event.defaultPrevented, true);
  }
  assert.equal(toggles, 2);
  for (const event of [press('r'), press('r', { ctrlKey: true, shiftKey: true }), press('r', { ctrlKey: true, altKey: true }), press('r', { ctrlKey: true, isComposing: true }), press('r', { ctrlKey: true, defaultPrevented: true })]) {
    assert.equal(handleRecolorKey(event, () => assert.fail('unexpected recolor')), false);
  }
});

test('F11 toggles fullscreen and Esc exits without swallowing dialog dismissal', () => {
  const changes = [];
  const enter = press('F11');
  assert.equal(handleFullscreenKey(enter, false, value => changes.push(value), false), true);
  assert.equal(enter.defaultPrevented, true);
  handleFullscreenKey(press('F11'), true, value => changes.push(value), false);
  handleFullscreenKey(press('Escape'), true, value => changes.push(value), false);
  assert.deepEqual(changes, [true, false, false]);
  const escape = press('Escape');
  assert.equal(handleFullscreenKey(escape, true, () => assert.fail(), true), false);
  assert.equal(escape.defaultPrevented, false);
  assert.equal(handleFullscreenKey(press('Escape'), false, () => assert.fail(), false), false);
});

test('fullscreen shortcuts ignore modifiers and composition and do not toggle on key repeat', () => {
  for (const override of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }, { isComposing: true }, { defaultPrevented: true }]) {
    assert.equal(handleFullscreenKey(press('F11', override), false, () => assert.fail(), false), false);
  }
  const repeat = press('F11', { repeat: true });
  assert.equal(handleFullscreenKey(repeat, false, () => assert.fail(), false), true);
  assert.equal(repeat.defaultPrevented, true);
});

test('j/k scroll an expanded answer while h/l cannot navigate the background PDF', () => {
  const popup = { id: 'answer-dialog' };
  const target = { closest: selector => selector.split(',').map(part => part.trim()).includes('dialog') ? popup : null };
  const viewport = { scrollTop: 200, scrollBy(x, y) { this.scrollTop += y; } };
  const noPageTurn = () => assert.fail('must not navigate the background PDF');
  const down = press('j', { target });
  handleReaderKey(down, viewport, noPageTurn);
  assert.equal(viewport.scrollTop, 280);
  assert.equal(down.defaultPrevented, true);
  handleReaderKey(press('k', { target }), viewport, noPageTurn);
  assert.equal(viewport.scrollTop, 200);
  for (const key of ['h', 'l', 'ArrowLeft', 'ArrowRight']) handleReaderKey(press(key, { target }), viewport, noPageTurn);
});

test('popup question entry and other dialogs keep their normal typing behavior', () => {
  const viewport = { scrollBy() { assert.fail('must not scroll while typing or in Settings'); } };
  for (const target of [
    { closest: selector => selector.includes('textarea') ? {} : { id: 'answer-dialog' } },
    { closest: selector => selector.split(',').map(part => part.trim()).includes('dialog') ? { id: 'settings-dialog' } : null },
  ]) {
    for (const key of ['j', 'k']) {
      const event = press(key, { target });
      handleReaderKey(event, viewport, () => assert.fail());
      assert.equal(event.defaultPrevented, false);
    }
  }
});
