// EriJuli · controles con el estilo del sistema de diseño (sin librerías)
// - Calendario propio para todos los <input type="date">
// - Selector de color con la paleta de la marca para <input type="color">
// El valor sigue viajando en el mismo campo (mismo name), así que el servidor no cambia.
(function () {
  'use strict';

  const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic'];
  const DIAS = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];

  const pad = (n) => String(n).padStart(2, '0');
  const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseISO = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  };
  const sameDay = (a, b) => a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const label = (d) => `${d.getDate()} ${MESES_CORTOS[d.getMonth()]} ${d.getFullYear()}`;

  const icon = (id) => `<svg class="ic ic-sm" aria-hidden="true"><use href="#${id}"/></svg>`;

  let openPopover = null;
  function closeOpen() {
    if (openPopover) { openPopover.close(); openPopover = null; }
  }
  document.addEventListener('click', (e) => {
    if (openPopover && !openPopover.root.contains(e.target)) closeOpen();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openPopover) { const t = openPopover.trigger; closeOpen(); t.focus(); }
  });

  // Coloca el panel debajo del botón; si no cabe a la derecha lo alinea al borde derecho,
  // y si no cabe abajo lo abre hacia arriba.
  function place(panel, trigger) {
    panel.classList.remove('up', 'end');
    const r = trigger.getBoundingClientRect();
    const pw = panel.offsetWidth, ph = panel.offsetHeight;
    if (r.left + pw > window.innerWidth - 8) panel.classList.add('end');
    if (r.bottom + ph + 8 > window.innerHeight && r.top - ph - 8 > 0) panel.classList.add('up');
  }

  /* ===================== Calendario ===================== */
  function enhanceDate(input) {
    if (input.dataset.ej) return;
    input.dataset.ej = '1';
    const required = input.required;
    const wrap = document.createElement('div');
    wrap.className = 'ej-pop ej-date';
    input.parentNode.insertBefore(wrap, input);

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'ej-trigger';
    trigger.setAttribute('aria-haspopup', 'dialog');
    trigger.setAttribute('aria-expanded', 'false');
    if (input.id) { trigger.id = input.id; input.removeAttribute('id'); }
    if (input.disabled) trigger.disabled = true;

    // El input original pasa a ser oculto y conserva name y valor
    input.type = 'hidden';
    wrap.append(trigger, input);

    const panel = document.createElement('div');
    panel.className = 'ej-panel ej-cal';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Elegir fecha');
    panel.hidden = true;
    wrap.appendChild(panel);

    let view = parseISO(input.value) || new Date();
    view = new Date(view.getFullYear(), view.getMonth(), 1);
    let focusDay = parseISO(input.value) || new Date();

    function paintTrigger() {
      const d = parseISO(input.value);
      trigger.innerHTML = `${icon('i-cal')}<span class="${d ? '' : 'ej-ph'}">${d ? label(d) : 'Elegir fecha'}</span>`;
      trigger.setAttribute('aria-label', d ? `Fecha: ${d.getDate()} de ${MESES[d.getMonth()]} de ${d.getFullYear()}. Cambiar` : 'Elegir fecha');
    }

    function render() {
      const sel = parseISO(input.value);
      const today = new Date();
      const first = new Date(view.getFullYear(), view.getMonth(), 1);
      const offset = (first.getDay() + 6) % 7; // lunes primero
      const daysIn = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
      let cells = '';
      for (let i = 0; i < offset; i++) cells += '<span></span>';
      for (let d = 1; d <= daysIn; d++) {
        const date = new Date(view.getFullYear(), view.getMonth(), d);
        const cls = [sameDay(date, sel) && 'sel', sameDay(date, today) && 'today'].filter(Boolean).join(' ');
        const tab = sameDay(date, focusDay) ? '0' : '-1';
        cells += `<button type="button" class="${cls}" data-d="${toISO(date)}" tabindex="${tab}" aria-label="${d} de ${MESES[view.getMonth()]}"${sameDay(date, sel) ? ' aria-pressed="true"' : ''}>${d}</button>`;
      }
      panel.innerHTML = `
        <div class="ej-cal-head">
          <button type="button" class="ej-icon-btn" data-nav="-1" aria-label="Mes anterior"><svg class="ic ic-sm" style="transform:scaleX(-1)"><use href="#i-chev"/></svg></button>
          <strong>${MESES[view.getMonth()].replace(/^./, (c) => c.toUpperCase())} ${view.getFullYear()}</strong>
          <button type="button" class="ej-icon-btn" data-nav="1" aria-label="Mes siguiente"><svg class="ic ic-sm"><use href="#i-chev"/></svg></button>
        </div>
        <div class="ej-cal-week">${DIAS.map((x) => `<span>${x}</span>`).join('')}</div>
        <div class="ej-cal-grid">${cells}</div>
        <div class="ej-cal-foot">
          <button type="button" class="btn btn-quiet btn-sm" data-today>Hoy</button>
          ${required ? '' : '<button type="button" class="btn btn-quiet btn-sm" data-clear>Borrar</button>'}
        </div>`;
    }

    function setValue(iso) {
      input.value = iso;
      paintTrigger();
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    const api = {
      root: wrap, trigger,
      close() { panel.hidden = true; trigger.setAttribute('aria-expanded', 'false'); },
    };

    function open() {
      closeOpen();
      const d = parseISO(input.value) || new Date();
      view = new Date(d.getFullYear(), d.getMonth(), 1);
      focusDay = d;
      render();
      panel.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      place(panel, trigger);
      openPopover = api;
      const f = panel.querySelector('.ej-cal-grid button[tabindex="0"]');
      if (f) f.focus();
    }

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      if (panel.hidden) open(); else closeOpen();
    });

    panel.addEventListener('click', (e) => {
      e.stopPropagation();
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.nav) {
        view = new Date(view.getFullYear(), view.getMonth() + Number(b.dataset.nav), 1);
        focusDay = new Date(view);
        render();
        return;
      }
      if (b.hasAttribute('data-today')) { setValue(toISO(new Date())); closeOpen(); trigger.focus(); return; }
      if (b.hasAttribute('data-clear')) { setValue(''); closeOpen(); trigger.focus(); return; }
      if (b.dataset.d) { setValue(b.dataset.d); closeOpen(); trigger.focus(); }
    });

    panel.addEventListener('keydown', (e) => {
      const cur = e.target.closest('.ej-cal-grid button');
      if (!cur) return;
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
      if (!step) return;
      e.preventDefault();
      const d = parseISO(cur.dataset.d);
      focusDay = new Date(d.getFullYear(), d.getMonth(), d.getDate() + step);
      if (focusDay.getMonth() !== view.getMonth() || focusDay.getFullYear() !== view.getFullYear()) {
        view = new Date(focusDay.getFullYear(), focusDay.getMonth(), 1);
      }
      render();
      const f = panel.querySelector(`[data-d="${toISO(focusDay)}"]`);
      if (f) f.focus();
    });

    // Campos obligatorios: los ocultos no se validan solos
    if (required && input.form) {
      input.form.addEventListener('submit', (e) => {
        if (!input.value) { e.preventDefault(); trigger.classList.add('invalid'); open(); }
      });
    }

    paintTrigger();
  }

  /* ===================== Colores ===================== */
  const PALETA = [
    ['#0f5c45', 'Verde monte'], ['#3f8f5a', 'Verde hoja'], ['#0a7a8a', 'Turquesa'], ['#2b56c4', 'Azul'],
    ['#6d4fb3', 'Morado'], ['#c2457a', 'Rosado'], ['#b3361b', 'Terracota'], ['#e07b24', 'Naranja'],
    ['#e9a92c', 'Maíz'], ['#7a5000', 'Café'], ['#5a6560', 'Gris'], ['#14231c', 'Tinta'],
  ];
  const nameOf = (hex) => (PALETA.find((p) => p[0].toLowerCase() === String(hex).toLowerCase()) || [null, 'Personalizado'])[1];

  function enhanceColor(input) {
    if (input.dataset.ej) return;
    input.dataset.ej = '1';
    const compact = input.classList.contains('cat-color');
    const wrap = document.createElement('div');
    wrap.className = 'ej-pop ej-color' + (compact ? ' compact' : '');
    input.parentNode.insertBefore(wrap, input);

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'ej-trigger';
    trigger.setAttribute('aria-haspopup', 'dialog');
    trigger.setAttribute('aria-expanded', 'false');
    if (input.id) { trigger.id = input.id; input.removeAttribute('id'); }

    input.classList.add('ej-native-color');
    input.tabIndex = -1;
    input.setAttribute('aria-hidden', 'true');
    wrap.append(trigger, input);

    const panel = document.createElement('div');
    panel.className = 'ej-panel ej-swatches';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Elegir color');
    panel.hidden = true;
    panel.innerHTML = `<div class="ej-sw-grid" role="radiogroup">${PALETA.map(([hex, name]) =>
      `<button type="button" role="radio" class="ej-sw" style="--c:${hex}" data-c="${hex}" aria-label="${name}" title="${name}"></button>`).join('')}</div>
      <button type="button" class="btn btn-quiet btn-sm ej-custom">Otro color…</button>`;
    wrap.appendChild(panel);

    function paint() {
      const v = input.value;
      trigger.innerHTML = `<span class="ej-dot" style="background:${v}"></span>${compact ? '' : `<span>${nameOf(v)}</span>`}`;
      trigger.setAttribute('aria-label', `Color: ${nameOf(v)}. Cambiar`);
      trigger.title = nameOf(v);
      panel.querySelectorAll('.ej-sw').forEach((b) => {
        const on = b.dataset.c.toLowerCase() === v.toLowerCase();
        b.setAttribute('aria-checked', on ? 'true' : 'false');
        b.tabIndex = on ? 0 : -1;
      });
      if (!panel.querySelector('.ej-sw[aria-checked="true"]')) panel.querySelector('.ej-sw').tabIndex = 0;
    }

    const api = { root: wrap, trigger, close() { panel.hidden = true; trigger.setAttribute('aria-expanded', 'false'); } };

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!panel.hidden) { closeOpen(); return; }
      closeOpen();
      panel.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      place(panel, trigger);
      openPopover = api;
      const f = panel.querySelector('.ej-sw[tabindex="0"]');
      if (f) f.focus();
    });
    panel.addEventListener('click', (e) => {
      e.stopPropagation();
      const sw = e.target.closest('.ej-sw');
      if (sw) { input.value = sw.dataset.c; input.dispatchEvent(new Event('change', { bubbles: true })); paint(); closeOpen(); trigger.focus(); return; }
      if (e.target.closest('.ej-custom')) { closeOpen(); input.click(); }
    });
    panel.addEventListener('keydown', (e) => {
      const list = [...panel.querySelectorAll('.ej-sw')];
      const i = list.indexOf(document.activeElement);
      if (i < 0) return;
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -4, ArrowDown: 4 }[e.key];
      if (!step) return;
      e.preventDefault();
      list[(i + step + list.length) % list.length].focus();
    });
    input.addEventListener('input', paint);
    input.addEventListener('change', paint);
    paint();
  }

  function init(root) {
    root.querySelectorAll('input[type="date"]').forEach(enhanceDate);
    root.querySelectorAll('input[type="color"]').forEach(enhanceColor);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => init(document));
  else init(document);
  window.EriJuliControles = { init };
})();
