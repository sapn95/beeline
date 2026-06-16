// Runs synchronously in <head> before first paint to avoid a flash of the wrong
// theme. chrome.storage is async, so it can't be read before paint; the pages
// mirror the chosen theme into localStorage (same extension origin for popup +
// options) and we read that here. Falls back to the html default (auto).
try {
  const t = localStorage.getItem('beeline-theme');
  if (t === 'light' || t === 'dark' || t === 'auto') {
    document.documentElement.dataset.theme = t;
  }
} catch {
  /* localStorage unavailable — keep the html default */
}
