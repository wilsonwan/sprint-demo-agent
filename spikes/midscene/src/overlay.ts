// Injected into every page during a take (never during rehearsal, so the
// vision model never sees it). Draws a fake cursor that follows real mouse
// events, a ripple on click, and an outline on the element under a click.
//
// Kept as a string: tsx/esbuild adds `__name(...)` helpers to functions,
// which throw when Playwright serialises a function into the page.
export const overlayScript = String.raw`
(() => {
  const install = () => {
    if (document.getElementById('__demo-cursor')) return;
    const style = document.createElement('style');
    style.textContent = ${'`'}
      #__demo-cursor { position: fixed; z-index: 2147483647; pointer-events: none;
        width: 28px; height: 28px; margin: -4px 0 0 -4px; left: -100px; top: -100px;
        filter: drop-shadow(0 1px 2px #0006); }
      .__demo-ripple { position: fixed; z-index: 2147483646; pointer-events: none;
        width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%;
        background: rgba(255, 196, 0, .55); animation: __demo-ripple .6s ease-out forwards; }
      @keyframes __demo-ripple { from { transform: scale(.3); opacity: 1 } to { transform: scale(1.6); opacity: 0 } }
      .__demo-highlight { outline: 3px solid #ffc400 !important; outline-offset: 2px; }
    ${'`'};
    document.documentElement.append(style);
    const cursor = document.createElement('div');
    cursor.id = '__demo-cursor';
    cursor.innerHTML =
      '<svg viewBox="0 0 22 22" width="28" height="28"><path d="M3 2l14 9-6.5 1.3L7 19z" fill="#fff" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    document.documentElement.append(cursor);

    addEventListener('mousemove', (e) => {
      cursor.style.left = e.clientX + 'px';
      cursor.style.top = e.clientY + 'px';
    }, true);
    addEventListener('mousedown', (e) => {
      const ripple = document.createElement('div');
      ripple.className = '__demo-ripple';
      ripple.style.left = e.clientX + 'px';
      ripple.style.top = e.clientY + 'px';
      document.documentElement.append(ripple);
      setTimeout(() => ripple.remove(), 700);
      const target = e.target;
      target?.classList?.add('__demo-highlight');
      setTimeout(() => target?.classList?.remove('__demo-highlight'), 900);
    }, true);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
})();
`;
