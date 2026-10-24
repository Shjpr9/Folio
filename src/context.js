export function pageText(content) {
  return content.items.filter(item => typeof item.str === 'string')
    .map(item => item.str + (item.hasEOL ? '\n' : ' ')).join('')
    .replace(/ +\n/g, '\n').trim();
}

export function selectionText(selection, layer) {
  if (!selection || !layer?.contains(selection.anchorNode) || !layer.contains(selection.focusNode)) return '';
  return selection.toString().trim();
}

export function captureContext(reader, scope) {
  const text = (scope === 'selection' ? reader.selection : reader.text).trim();
  if (!text) throw new Error(scope === 'selection'
    ? 'Select text on the PDF first.'
    : 'This page has no extractable text. Image-only pages need OCR.');
  return { text, label: `${scope === 'selection' ? 'Selection · ' : ''}Page ${reader.page}` };
}

export function captureAvailableContexts(reader) {
  return {
    selection: reader.selection.trim() ? captureContext(reader, 'selection') : null,
    page: reader.text.trim() ? captureContext(reader, 'page') : null,
  };
}
