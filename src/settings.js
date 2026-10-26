export const defaultSettings = { endpoint_url: '', api_key: '', model: '', theme: 'system', zoom: null, recolor_pdf: false, reading_positions: [], reopen_last_pdf: true, last_pdf_path: null, open_pdf_paths: null, active_pdf_path: null };

export async function documentKey(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function lastPage(positions, documentId, pageCount) {
  return Math.min(pageCount, Math.max(1, positions.find(position => position.document_id === documentId)?.page ?? 1));
}

export function rememberPage(positions, documentId, page, details = {}) {
  // shortcut: retain the last 100 PDFs to keep the settings file bounded.
  return [...positions.filter(position => position.document_id !== documentId || (position.path ?? null) !== (details.path ?? null)).slice(-99), { document_id: documentId, page, ...details }];
}

export function effectiveTheme(theme, prefersDark) {
  return theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme;
}

export function createSettingsStore(invoke) {
  let pending = Promise.resolve();
  let loadFailed = false;
  return {
    async load() {
      try {
        const settings = { ...defaultSettings, ...await invoke('load_settings') };
        loadFailed = false;
        return settings;
      } catch (error) { loadFailed = true; throw error; }
    },
    flush() { return pending; },
    save(settings, replaceUnreadable = false) {
      if (loadFailed && !replaceUnreadable) return Promise.reject(new Error('Saved settings could not be loaded. Apply Settings explicitly before saving reading preferences.'));
      const snapshot = { ...settings };
      const write = pending.catch(() => {}).then(() => invoke('save_settings', { settings: snapshot }))
        .then(() => { if (replaceUnreadable) loadFailed = false; });
      pending = write;
      return write;
    },
  };
}
