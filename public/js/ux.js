// EriJuli · detalles de experiencia de uso (sin librerías)
// 1. Confirmaciones con ventana propia en vez de confirm() del navegador
// 2. Avisos (flash) como notificación con botón de cerrar
// 3. Botones que muestran "Guardando…" y evitan el doble envío
// 4. Montos con puntos de miles mientras se escribe
// 5. Selección de cuenta/bolsillo y categoría con tarjetas (select[data-picker])
// 6. Saldo del bolsillo elegido y aviso si queda en negativo
// 7. Recordar la última cuenta usada al registrar
// 8. Aviso sin conexión
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const motionPref = document.documentElement.dataset.motion;
  const reduceMotion = motionPref === 'off' || (motionPref !== 'on' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  /* ---------- 1. Confirmaciones ---------- */
  let dialog;
  function askConfirm(message, { danger = true, ok = 'Sí, continuar' } = {}) {
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.className = 'ej-dialog';
      dialog.innerHTML = `<form method="dialog">
          <p class="ej-dialog-msg"></p>
          <div class="ej-dialog-actions">
            <button class="btn btn-ghost" value="no">Cancelar</button>
            <button class="btn ej-dialog-ok" value="si"></button>
          </div></form>`;
      document.body.appendChild(dialog);
      dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close('no'); });
    }
    $('.ej-dialog-msg', dialog).textContent = message;
    const okBtn = $('.ej-dialog-ok', dialog);
    okBtn.textContent = ok;
    okBtn.className = 'btn ej-dialog-ok ' + (danger ? 'btn-danger-solid' : 'btn-primary');
    return new Promise((resolve) => {
      dialog.returnValue = '';
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'si'), { once: true });
      dialog.showModal();
      $('.btn-ghost', dialog).focus();
    });
  }
  window.EriJuliConfirm = askConfirm;

  // Convierte onsubmit="return confirm('…')" y onclick="return confirm('…')" en data-confirm
  const CONFIRM_RE = /return\s+confirm\((['"])([\s\S]*?)\1\)/;
  $$('[onsubmit*="confirm("], [onclick*="confirm("]').forEach((el) => {
    const attr = el.hasAttribute('onsubmit') ? 'onsubmit' : 'onclick';
    const m = CONFIRM_RE.exec(el.getAttribute(attr));
    if (!m) return;
    el.removeAttribute(attr);
    el.dataset.confirm = m[2].replace(/\\'/g, "'");
  });
  document.addEventListener('submit', async (e) => {
    const form = e.target;
    const submitter = e.submitter;
    const msg = (submitter && submitter.dataset.confirm) || form.dataset.confirm;
    if (!msg || form.dataset.confirmed) return;
    e.preventDefault();
    const isDanger = /eliminar|borrar|descartar|desconectar|revocar|quitar/i.test(msg + ' ' + (submitter ? submitter.textContent : ''));
    const okText = submitter ? submitter.textContent.trim() : 'Sí, continuar';
    if (await askConfirm(msg, { danger: isDanger, ok: okText.length < 28 ? okText : 'Sí, continuar' })) {
      form.dataset.confirmed = '1';
      if (form.requestSubmit) form.requestSubmit(submitter && submitter.form === form ? submitter : undefined);
      else form.submit();
    }
  }, true);

  /* ---------- 2. Avisos ---------- */
  const TOAST_ICON = { success: 'M5 12.5l4.5 4.5L19 7.5', error: 'M12 4l9 16H3z M12 10v4 M12 17v.5', warning: 'M12 4l9 16H3z M12 10v4 M12 17v.5' };
  $$('.flash').forEach((el) => {
    const type = (el.className.match(/flash-(\w+)/) || [])[1] || 'success';
    const text = el.textContent.trim();
    el.classList.add('ej-toast');
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    el.innerHTML = `<svg class="ic ic-sm" aria-hidden="true" viewBox="0 0 24 24"><path d="${TOAST_ICON[type] || TOAST_ICON.success}"/></svg><span></span>
      <button type="button" class="ej-toast-x" aria-label="Cerrar aviso"><svg class="ic ic-sm" viewBox="0 0 24 24"><path d="M6 6l12 12 M18 6L6 18"/></svg></button>`;
    $('span', el).textContent = text;
    $('.ej-toast-x', el).addEventListener('click', () => el.remove());
  });

  /* ---------- 3. Botones con estado de envío ---------- */
  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (e.defaultPrevented || form.method === 'get' || form.dataset.sending) return;
    form.dataset.sending = '1';
    const btn = e.submitter || $('button[type="submit"], button:not([type])', form);
    if (btn && btn.tagName === 'BUTTON') {
      btn.dataset.label = btn.innerHTML;
      btn.style.minWidth = btn.offsetWidth + 'px';
      btn.classList.add('is-loading');
      btn.innerHTML = '<span class="ej-spin" aria-hidden="true"></span>Guardando…';
      // Desactivar después de que el navegador tome el valor del botón
      setTimeout(() => { btn.disabled = true; }, 0);
    }
  });
  // Al volver con "Atrás" el formulario queda listo de nuevo
  window.addEventListener('pageshow', () => {
    $$('form[data-sending]').forEach((f) => delete f.dataset.sending);
    $$('button.is-loading').forEach((b) => { b.disabled = false; b.classList.remove('is-loading'); b.innerHTML = b.dataset.label; });
  });

  /* ---------- 4. Montos con puntos de miles ---------- */
  function formatTyped(raw) {
    let s = raw.replace(/[^\d,]/g, '');
    const i = s.indexOf(',');
    let int = i >= 0 ? s.slice(0, i) : s;
    let dec = i >= 0 ? s.slice(i + 1).replace(/,/g, '').slice(0, 2) : null;
    int = int.replace(/^0+(?=\d)/, '');
    int = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return dec !== null ? `${int || '0'},${dec}` : int;
  }
  function moneyInput(input) {
    if (input.dataset.ejMoney) return;
    input.dataset.ejMoney = '1';
    input.autocomplete = 'off';
    // Valor inicial "1234567" o "1234567,5" → "1.234.567"
    if (input.value) input.value = formatTyped(input.value.replace(/\./g, ''));
    input.addEventListener('input', () => {
      const pos = input.selectionStart;
      const digitsBefore = input.value.slice(0, pos).replace(/[^\d,]/g, '').length;
      input.value = formatTyped(input.value);
      // Recolocar el cursor después del mismo número de dígitos
      let n = 0, p = 0;
      while (p < input.value.length && n < digitsBefore) { if (/[\d,]/.test(input.value[p])) n++; p++; }
      input.setSelectionRange(p, p);
    });
  }
  $$('input[inputmode="decimal"]').forEach(moneyInput);
  window.EriJuliMoney = moneyInput;

  /* ---------- 5. Selector con tarjetas ---------- */
  function picker(select) {
    if (select.dataset.ejPicker) return;
    select.dataset.ejPicker = '1';
    const group = document.createElement('div');
    group.className = 'ej-picker' + (select.dataset.picker === 'chips' ? ' chips' : '');
    group.setAttribute('role', 'radiogroup');
    const lbl = select.id && document.querySelector(`label[for="${select.id}"]`);
    if (lbl) { lbl.id = lbl.id || select.id + '-lbl'; group.setAttribute('aria-labelledby', lbl.id); lbl.removeAttribute('for'); }
    select.classList.add('ej-picker-src');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');
    select.after(group);

    function build() {
      group.innerHTML = '';
      $$('option', select).forEach((o) => {
        if (!o.value) return;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ej-pick';
        b.setAttribute('role', 'radio');
        b.dataset.value = o.value;
        const name = o.dataset.name || o.textContent.trim();
        const sub = [o.dataset.bank, o.dataset.balance].filter(Boolean).join(' · ');
        if (o.dataset.color) b.style.setProperty('--pc', o.dataset.color);
        b.innerHTML = `${o.dataset.color ? '<i class="ej-pick-dot"></i>' : ''}<span class="n"></span>${sub ? '<span class="v"></span>' : ''}`;
        $('.n', b).textContent = name;
        if (sub) $('.v', b).textContent = sub;
        if (o.dataset.kind === 'cuenta') b.classList.add('cuenta');
        if (o.dataset.kind === 'tarjeta') b.classList.add('tarjeta');
        b.hidden = o.hidden;
        group.appendChild(b);
      });
      sync();
    }
    function sync() {
      const btns = $$('.ej-pick', group);
      btns.forEach((b) => {
        const on = b.dataset.value === select.value;
        b.setAttribute('aria-checked', on ? 'true' : 'false');
        b.tabIndex = on ? 0 : -1;
      });
      if (btns.length && !btns.some((b) => b.tabIndex === 0)) btns[0].tabIndex = 0;
      group.classList.toggle('is-disabled', select.disabled);
    }
    group.addEventListener('click', (e) => {
      const b = e.target.closest('.ej-pick');
      if (!b || select.disabled) return;
      // Tocar la opción elegida de nuevo la quita (si el campo no es obligatorio)
      select.value = (b.dataset.value === select.value && !select.required && $('option[value=""]', select)) ? '' : b.dataset.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    group.addEventListener('keydown', (e) => {
      const btns = $$('.ej-pick', group);
      const i = btns.indexOf(document.activeElement);
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (i < 0 || !step) return;
      e.preventDefault();
      const next = btns[(i + step + btns.length) % btns.length];
      next.focus(); next.click();
    });
    select.addEventListener('change', sync);
    select.addEventListener('ej:rebuild', build);
    // app.js activa/desactiva los selects según el tipo de movimiento
    new MutationObserver(sync).observe(select, { attributes: true, attributeFilter: ['disabled'] });
    build();
  }
  $$('select[data-picker]').forEach(picker);

  /* ---------- 6. Saldo del bolsillo elegido ---------- */
  const amount = $('#amount');
  const from = $('#container_from_id');
  if (amount && from) {
    const hint = document.createElement('p');
    hint.className = 'ej-hint';
    hint.setAttribute('aria-live', 'polite');
    (from.closest('.field') || from.parentNode).appendChild(hint);
    const parse = (s) => Number(String(s || '').replace(/\./g, '').replace(',', '.')) || 0;
    const fmt = (n) => (n < 0 ? '−' : '') + '$' + Math.abs(Math.round(n)).toLocaleString('es-CO');
    const kindOf = () => (($('input[name="kind"]:checked') || {}).value) || 'gasto';
    function update() {
      const o = from.selectedOptions[0];
      if (o && o.dataset.cardAvailable !== undefined && kindOf() === 'gasto') {
        const avail = Number(o.dataset.cardAvailable) / 100, after = avail - parse(amount.value);
        hint.className = 'ej-hint' + (after < 0 ? ' neg' : '');
        hint.textContent = parse(amount.value) > 0
          ? (after < 0 ? `Supera el cupo disponible por ${fmt(-after)}` : `Cupo disponible ${fmt(avail)} · quedarían ${fmt(after)}. Se suma a la deuda de la tarjeta.`)
          : `Cupo disponible ${fmt(avail)}`;
        return;
      }
      if (!o || !o.value || o.dataset.raw === undefined || kindOf() === 'ingreso') { hint.textContent = ''; hint.className = 'ej-hint'; return; }
      const bal = Number(o.dataset.raw) / 100;
      const after = bal - parse(amount.value);
      hint.className = 'ej-hint' + (after < 0 ? ' neg' : '');
      hint.textContent = parse(amount.value) > 0
        ? (after < 0 ? `No alcanza: ${o.dataset.name || ''} quedaría en ${fmt(after)}` : `Saldo ${fmt(bal)} · quedarían ${fmt(after)}`)
        : `Saldo disponible ${fmt(bal)}`;
    }
    amount.addEventListener('input', update);
    from.addEventListener('change', update);
    document.addEventListener('change', (e) => { if (e.target.name === 'kind') update(); });
    update();
  }

  /* ---------- 7. Recordar la última cuenta usada ---------- */
  const txForm = $('#tx-form');
  if (txForm && txForm.dataset.new === '1') {
    const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } } };
    ['container_from_id', 'container_to_id'].forEach((id) => {
      const sel = document.getElementById(id);
      if (!sel || sel.value) return;
      const last = store.get('ej-last-' + id);
      if (last && $(`option[value="${CSS.escape(last)}"]`, sel)) { sel.value = last; sel.dispatchEvent(new Event('change', { bubbles: true })); }
    });
    txForm.addEventListener('submit', () => {
      ['container_from_id', 'container_to_id'].forEach((id) => { const s = document.getElementById(id); if (s && s.value) store.set('ej-last-' + id, s.value); });
    });
  }

  // El botón dice lo que va a pasar: "Guardar gasto", "Guardar ingreso" o "Mover dinero"
  const submitBtn = $('#tx-submit');
  if (txForm && submitBtn && txForm.dataset.new === '1') {
    const LABEL = { gasto: 'Guardar gasto', ingreso: 'Guardar ingreso', transferencia: 'Mover dinero' };
    txForm.addEventListener('change', (e) => { if (e.target.name === 'kind') submitBtn.textContent = LABEL[e.target.value] || 'Guardar'; });
  }

  /* ---------- 8. Sin conexión ---------- */
  const offline = document.createElement('div');
  offline.className = 'ej-offline';
  offline.setAttribute('role', 'status');
  offline.textContent = 'Sin conexión: puedes ver tus datos, pero los cambios no se guardarán hasta que vuelva el internet.';
  const syncOnline = () => { offline.hidden = navigator.onLine; };
  document.body.appendChild(offline);
  window.addEventListener('online', syncOnline);
  window.addEventListener('offline', syncOnline);
  syncOnline();

  /* ---------- Al cerrar sesión se borran las páginas guardadas sin conexión ---------- */
  document.addEventListener('submit', (e) => {
    if (e.target.action && /\/logout$/.test(e.target.action) && window.caches) {
      caches.keys().then((keys) => keys.forEach((k) => caches.delete(k))).catch(() => {});
    }
  });

  /* ---------- Entrada suave de la página ---------- */
  if (!reduceMotion) document.documentElement.classList.add('ej-ready');
})();
