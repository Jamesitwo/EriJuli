// EriJuli · animaciones: cifras que cuentan, cascadas y onda al tocar
(function () {
  'use strict';
  const pref = document.documentElement.dataset.motion; // on | off | (automático)
  if (pref === 'off' || (pref !== 'on' && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  // 1. Orden de entrada para las cascadas (--i)
  $$('.stack, .pockets, .cards-grid, .menu-list').forEach((list) => {
    [...list.children].slice(0, 14).forEach((el, i) => el.style.setProperty('--i', i));
  });
  $$('.stack > div').forEach((group) => [...group.children].filter((c) => c.classList.contains('tx-row')).slice(0, 14).forEach((el, i) => el.style.setProperty('--i', i)));
  $$('.chart svg').forEach((svg) => {
    $$('.bar-in', svg).forEach((b, i) => b.style.setProperty('--i', i));
    $$('.bar-ex', svg).forEach((b, i) => b.style.setProperty('--i', i));
  });

  // 2. Cifras de dinero que cuentan hasta su valor ($1.320.000)
  const MONEY = /^([^\d]*?)(\d{1,3}(?:\.\d{3})*)(,\d+)?(.*)$/;
  function countUp(el) {
    if (el.dataset.counted) return;
    el.dataset.counted = '1';
    // Solo nodos de texto simples
    if (el.children.length) return;
    const m = MONEY.exec(el.textContent.trim());
    if (!m) return;
    const target = Number(m[2].replace(/\./g, ''));
    if (!target || target < 1000) return;
    const [, pre, , dec = '', post] = m;
    const start = performance.now(), dur = Math.min(1100, 500 + Math.log10(target) * 90);
    el.classList.add('is-counting');
    el.style.minWidth = el.offsetWidth + 'px';
    const step = (t) => {
      const k = Math.min(1, (t - start) / dur);
      const eased = 1 - Math.pow(1 - k, 4);
      el.textContent = pre + Math.round(target * eased).toLocaleString('es-CO') + (k === 1 ? dec : '') + post;
      if (k < 1) requestAnimationFrame(step);
      else { el.classList.remove('is-counting'); el.style.minWidth = ''; }
    };
    requestAnimationFrame(step);
  }
  const targets = $$('.hero-amount, .pocket-amount, .legend dd, .ccard .num strong');
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => entries.forEach((e) => { if (e.isIntersecting) { countUp(e.target); io.unobserve(e.target); } }), { threshold: .4 });
    targets.forEach((t) => io.observe(t));
  } else targets.forEach(countUp);

  // 3. Onda al tocar botones y tarjetas
  document.addEventListener('pointerdown', (e) => {
    const host = e.target.closest('.btn, .ej-pick, .keypad button, .bn-fab, .filter-chip');
    if (!host || host.disabled) return;
    const r = host.getBoundingClientRect();
    const size = Math.max(r.width, r.height) * 2.2;
    const dot = document.createElement('span');
    dot.className = 'ej-ripple';
    dot.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    host.style.overflow = 'hidden';
    host.appendChild(dot);
    setTimeout(() => dot.remove(), 600);
  }, { passive: true });

  // 4. Aviso que se va deslizando
  $$('.ej-toast').forEach((t) => {
    setTimeout(() => t.classList.add('is-leaving'), 5700);
    const x = t.querySelector('.ej-toast-x');
    if (x) x.addEventListener('click', (ev) => { ev.stopImmediatePropagation(); t.classList.add('is-leaving'); setTimeout(() => t.remove(), 300); }, true);
  });

  // 5. PIN equivocado: los puntos tiemblan
  const dots = document.querySelector('.pin-dots');
  if (dots && document.querySelector('.flash-error')) { dots.classList.add('shake'); if (navigator.vibrate) navigator.vibrate(120); }

  // 6. Vibración corta al guardar (celulares Android)
  document.addEventListener('submit', (e) => { if (!e.defaultPrevented && navigator.vibrate && matchMedia('(pointer: coarse)').matches) navigator.vibrate(12); });
})();
