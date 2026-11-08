import { test } from 'node:test';
import assert from 'node:assert/strict';
import { speechChunks, createSpeechPlayer } from '../src/tts.js';

test('speech text repairs PDF line wraps without losing paragraphs', () => {
  assert.deepEqual(speechChunks('A hyphen-\nated word.\nAnother line.\n\nA new paragraph.'), ['A hyphenated word. Another line.', 'A new paragraph.']);
});

test('long unpunctuated selections are bounded and retain all words', () => {
  const text = Array(200).fill('word').join(' ');
  const chunks = speechChunks(text);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.length <= 600));
  assert.equal(chunks.join(' '), text);
  assert.throws(() => speechChunks('   '), /text/i);
  assert.throws(() => speechChunks('a'.repeat(120001)), /120/);
});

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function harness(synthesize) {
  const audios = [], states = [];
  let stops = 0;
  const player = createSpeechPlayer({
    begin: async () => 7,
    synthesize,
    stopEngine: async () => { stops++; },
    createAudio: () => {
      const audio = { playbackRate: 1, playCount: 0, pause() {}, async play() { this.playCount++; }, dispose() { this.disposed = true; } };
      audios.push(audio); return audio;
    },
    onChange: state => states.push(state),
  });
  return { player, audios, states, stops: () => stops };
}

test('stop suppresses audio from synthesis that finishes late', async () => {
  let finish;
  const h = harness(() => new Promise(resolve => { finish = resolve; }));
  const speaking = h.player.play('Read this.', 'Selection');
  await tick();
  await h.player.stop();
  finish(new Uint8Array([1]));
  await speaking;
  assert.equal(h.audios.length, 0);
  assert.equal(h.states.at(-1).phase, 'idle');
});

test('stop during setup lookup prevents late engine startup', async () => {
  let finish, starts = 0;
  const player = createSpeechPlayer({
    prepare: () => new Promise(resolve => { finish = resolve; }),
    begin: async () => { starts++; return 1; },
    synthesize: async () => new Uint8Array([1]),
    stopEngine: async () => {},
  });
  const speaking = player.play('Old selection.');
  await tick();
  await player.stop();
  finish(true);
  await speaking;
  assert.equal(starts, 0);
  assert.equal(player.state.phase, 'idle');
});

test('pause while preparing prevents automatic playback until resume', async () => {
  let finish;
  const h = harness(() => new Promise(resolve => { finish = resolve; }));
  const speaking = h.player.play('Read this.', 'Selection');
  await tick();
  h.player.pause();
  finish(new Uint8Array([1]));
  await speaking;
  assert.equal(h.audios[0].playCount, 0);
  h.player.setRate(1.5);
  await h.player.resume();
  assert.equal(h.audios[0].playCount, 1);
  assert.equal(h.audios[0].playbackRate, 1.5);
  await h.player.stop();
  assert.equal(h.audios[0].disposed, true);
});

test('playback failures are visible and release the engine', async () => {
  const h = harness(async () => { throw new Error('Engine unavailable'); });
  await h.player.play('Read this.', 'Selection');
  assert.equal(h.states.at(-1).phase, 'error');
  assert.match(h.states.at(-1).error, /Engine unavailable/);
  assert.ok(h.stops() > 0);
});

test('resume between chunks never replays the completed chunk', async () => {
  let finish, requests = 0;
  const h = harness(async () => {
    requests++;
    if (requests === 1) return new Uint8Array([1]);
    return new Promise(resolve => { finish = resolve; });
  });
  await h.player.play('First paragraph.\n\nSecond paragraph.');
  h.audios[0].onended();
  await tick();
  h.player.pause();
  await h.player.resume();
  assert.equal(h.audios[0].playCount, 1);
  finish(new Uint8Array([2]));
  await tick();
  assert.equal(h.audios.length, 2);
  assert.equal(h.audios[1].playCount, 1);
  await h.player.stop();
});
