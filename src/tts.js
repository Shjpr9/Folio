// Keep synthesis bounded and independent of the AI provider and PDF renderer.
export function speechChunks(text) {
  if (text.length > 120000) throw new Error('Read aloud supports up to 120,000 characters. Select a smaller passage.');
  text = text.replace(/\r\n?/g, '\n').replace(/(\p{L})-\n(?=\p{Ll})/gu, '$1');
  const chunks = [];
  for (const paragraph of text.split(/\n\s*\n/)) {
    const words = paragraph.replace(/\s+/g, ' ').trim().split(' ');
    let chunk = '';
    for (let word of words) {
      if (!word) continue;
      if (chunk && (chunk.length + word.length + 1 > 600 || (chunk.length >= 180 && /[.!?…]["')\]]?$/.test(chunk)))) {
        chunks.push(chunk); chunk = '';
      }
      while (word.length > 600) {
        if (chunk) { chunks.push(chunk); chunk = ''; }
        chunks.push(word.slice(0, 600)); word = word.slice(600);
      }
      chunk += `${chunk ? ' ' : ''}${word}`;
    }
    if (chunk) chunks.push(chunk);
  }
  if (!chunks.length) throw new Error('There is no text to read aloud.');
  return chunks;
}

export function browserAudio(bytes) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
  const audio = new Audio(url);
  audio.dispose = () => { audio.pause(); audio.removeAttribute('src'); audio.load(); URL.revokeObjectURL(url); };
  return audio;
}

export function createSpeechPlayer({ prepare = async () => true, begin, synthesize, stopEngine, createAudio = browserAudio, onChange = () => {} }) {
  let version = 0, current = null, paused = false, rate = 1, context = null;
  let state = { phase: 'idle', label: '', error: '', index: 0, total: 0 };
  const update = patch => { state = { ...state, ...patch }; onChange(state); };
  const dispose = () => { if (current) { current.onended = null; current.onerror = null; current.dispose(); current = null; } };
  async function fail(error, ticket) {
    if (ticket !== version) return;
    ++version; context = null; dispose();
    update({ phase: 'error', error: String(error?.message || error) });
    await stopEngine().catch(() => {});
  }
  async function playCurrent(ticket) {
    if (ticket !== version || !current || paused) return;
    try { update({ phase: 'playing' }); await current.play(); }
    catch (error) { await fail(error, ticket); }
  }
  async function advance(ticket) {
    if (ticket !== version || !context) return;
    const { chunks, generation } = context;
    const index = context.index;
    if (index >= chunks.length) {
      context = null; dispose(); update({ phase: 'idle' });
      await stopEngine().catch(() => {}); return;
    }
    if (!paused) update({ phase: 'preparing', index: index + 1 });
    try {
      const result = await (context.next || synthesize(chunks[index], generation));
      if (ticket !== version) return;
      if (result.error) throw result.error;
      const bytes = result.bytes ?? result;
      dispose(); current = createAudio(bytes); current.playbackRate = rate;
      current.onended = () => { if (ticket === version && context) { dispose(); context.index++; advance(ticket); } };
      current.onerror = () => fail(new Error('Could not play speech audio. Try reading again.'), ticket);
      // Capture failures immediately so a prefetched rejection is never unhandled.
      context.next = index + 1 < chunks.length
        ? synthesize(chunks[index + 1], generation).then(bytes => ({ bytes }), error => ({ error })) : null;
      await playCurrent(ticket);
    } catch (error) { await fail(error, ticket); }
  }
  return {
    get state() { return state; },
    async play(text, label = 'Read aloud') {
      const ticket = ++version;
      dispose(); context = null; paused = false;
      update({ phase: 'preparing', label, error: '', index: 0, total: 0 });
      try {
        const chunks = speechChunks(text);
        const ready = await prepare(() => ticket === version);
        if (ticket !== version) return;
        if (!ready) { update({ phase: 'idle' }); return; }
        const generation = await begin();
        if (ticket !== version) return;
        context = { chunks, generation, index: 0, next: null };
        update({ total: chunks.length });
        await advance(ticket);
      } catch (error) { await fail(error, ticket); }
    },
    pause() { if (!context && state.phase !== 'preparing') return; paused = true; current?.pause(); update({ phase: 'paused' }); },
    async resume() { if (!paused) return; paused = false; if (current) await playCurrent(version); else update({ phase: 'preparing' }); },
    async stop() { ++version; context = null; paused = false; dispose(); update({ phase: 'idle', error: '' }); await stopEngine().catch(() => {}); },
    setRate(value) { if (!Number.isFinite(value) || value < 0.5 || value > 2) return; rate = value; if (current) current.playbackRate = rate; },
  };
}
