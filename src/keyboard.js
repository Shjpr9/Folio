export function handleFullscreenKey(event, fullscreen, setFullscreen, dialogOpen) {
  if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
  if (event.key === 'F11') {
    event.preventDefault();
    if (!event.repeat) setFullscreen(!fullscreen);
    return true;
  }
  if (event.key === 'Escape' && fullscreen && !dialogOpen) {
    event.preventDefault();
    setFullscreen(false);
    return true;
  }
  return false;
}

export function handleRecolorKey(event, recolor) {
  if (event.defaultPrevented || event.isComposing || event.altKey || event.shiftKey
    || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'r') return false;
  event.preventDefault();
  recolor();
  return true;
}

export function handleReaderKey(event, viewport, changePage) {
  if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey
    || event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
  const dialog = event.target.closest('dialog');
  if (dialog && (dialog.id !== 'answer-dialog' || (event.key !== 'j' && event.key !== 'k'))) return;

  if (event.key === 'j' || event.key === 'k') {
    event.preventDefault();
    viewport.scrollBy(0, event.key === 'j' ? 80 : -80);
  } else if (event.key === 'h' || event.key === 'ArrowLeft') {
    event.preventDefault();
    changePage(-1);
  } else if (event.key === 'l' || event.key === 'ArrowRight') {
    event.preventDefault();
    changePage(1);
  }
}
