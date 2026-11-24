// Runs before the first paint (a classic script in <head>, allowed by script-src 'self'): puts the chosen theme on
// <html> so a person who picked Licht or Donker never sees the other one flash. "Systeem" sets nothing: the style
// sheet follows prefers-color-scheme by itself. The same key and colours live in theme.js; test/theme.test.ts keeps them equal.
(function () {
  try {
    const choice = localStorage.getItem('car:theme');
    if (choice !== 'light' && choice !== 'dark') return;
    document.documentElement.setAttribute('data-theme', choice);
    const colour = choice === 'dark' ? '#14130f' : '#f6f3ee';
    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
      meta.setAttribute('data-system', meta.getAttribute('content') || '');
      meta.setAttribute('content', colour);
    }
  } catch {
    // storage is blocked: the system theme it is
  }
})();
