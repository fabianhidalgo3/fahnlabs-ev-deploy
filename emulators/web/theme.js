// Tema claro / oscuro. Se carga en <head> (sin defer) para aplicar el tema antes de pintar y evitar destellos.
// Por defecto sigue la preferencia del sistema; el botón ☀️/🌙 de la cabecera lo fija y se recuerda en este navegador.
(() => {
  const KEY = 'emob.theme';
  const read = () => {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  };
  const system = () => (window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  const apply = (t) => {
    document.documentElement.dataset.theme = t;
    const b = document.querySelector('.theme-btn');
    if (b) {
      b.textContent = t === 'light' ? '🌙' : '☀️';
      b.title = t === 'light' ? 'Cambiar a tema oscuro' : 'Cambiar a tema claro';
      b.setAttribute('aria-label', b.title);
    }
    window.dispatchEvent(new CustomEvent('emob:theme', { detail: t }));
  };
  apply(read() || system());

  // Si el usuario no eligió, se sigue el cambio del sistema
  window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', () => {
    if (!read()) apply(system());
  });

  document.addEventListener('DOMContentLoaded', () => {
    const header = document.querySelector('header.top');
    if (!header) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'small theme-btn';
    const pill = header.querySelector('.pill');
    if (pill) pill.after(b);
    else header.append(b);
    b.addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
      try {
        localStorage.setItem(KEY, next);
      } catch {
        /* sin almacenamiento: dura sólo esta visita */
      }
      apply(next);
    });
    apply(document.documentElement.dataset.theme);
  });
})();
