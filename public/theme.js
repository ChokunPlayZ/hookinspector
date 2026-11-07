(() => {
  let theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  try {
    const saved = localStorage.getItem('hookinspector.theme');
    if (saved === 'light' || saved === 'dark') theme = saved;
  } catch { /* System preference still works when storage is unavailable. */ }
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#10151d' : '#f3f5f7');
})();
