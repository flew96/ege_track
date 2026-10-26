// Тема оформления: как в системе, пока пользователь не нажал на переключатель.
// Подключается в <head> до отрисовки страницы, чтобы не было вспышки другой темы.

(function () {
  const media = matchMedia('(prefers-color-scheme: dark)');
  const systemTheme = () => (media.matches ? 'dark' : 'light');

  function saved() {
    try { return localStorage.getItem('theme'); } catch { return null; }
  }

  function apply() {
    document.documentElement.dataset.theme = saved() || systemTheme();
  }

  apply();
  media.addEventListener('change', apply);

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#theme-toggle')) return;
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    // Если выбрали ту же тему, что и в системе, — снова просто следуем за системой
    try {
      if (next === systemTheme()) localStorage.removeItem('theme');
      else localStorage.setItem('theme', next);
    } catch { /* приватный режим и т.п. */ }
    document.documentElement.dataset.theme = next;
  });
})();
