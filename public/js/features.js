// EriJuli · funciones del formulario de movimientos y otras ayudas
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const parse = (s) => Number(String(s || '').replace(/\./g, '').replace(',', '.')) || 0;
  const fmt = (n) => '$' + Math.round(n).toLocaleString('es-CO');

  // Botones que llenan un campo con un valor (ej. "Pago del periodo")
  $$('[data-fill]').forEach((b) => b.addEventListener('click', () => {
    const t = $(b.dataset.fill); if (!t) return;
    t.value = String(Math.round(Number(b.dataset.value) || 0)); t.dispatchEvent(new Event('input', { bubbles: true })); t.focus();
  }));

  const form = $('#tx-form');
  if (!form) return;
  const kindOf = () => (($('input[name="kind"]:checked', form) || {}).value) || 'gasto';

  // Tarjetas solo aparecen para gastos
  const from = $('#container_from_id');
  function syncCards() {
    if (!from) return;
    const isGasto = kindOf() === 'gasto';
    let changed = false;
    $$('option[data-kind="tarjeta"]', from).forEach((o) => { if (o.hidden === isGasto) { o.hidden = !isGasto; changed = true; } if (!isGasto && o.selected) { from.value = ''; changed = true; } });
    if (changed) from.dispatchEvent(new Event('ej:rebuild'));
  }
  form.addEventListener('change', (e) => { if (e.target.name === 'kind') syncCards(); });
  syncCards();

  // Aviso del tope de la categoría elegida
  const cat = $('#category_id'), catHint = $('#category-hint');
  function syncCat() {
    if (!cat || !catHint) return;
    const o = cat.selectedOptions[0];
    if (!o || !o.dataset.hint) { catHint.textContent = ''; catHint.className = 'ej-hint'; return; }
    const left = Number(o.dataset.limitLeft) / 100 - parse($('#amount').value);
    catHint.className = 'ej-hint' + (left < 0 ? ' neg' : o.dataset.hintState === 'near' ? ' warn' : '');
    catHint.textContent = o.dataset.hint + (parse($('#amount').value) > 0 ? (left < 0 ? ` · con este gasto te pasas por ${fmt(-left)}` : ` · te quedarían ${fmt(left)}`) : '');
  }
  if (cat) { cat.addEventListener('change', syncCat); $('#amount').addEventListener('input', syncCat); syncCat(); }

  // Dividir en varias categorías
  const box = $('#split-box');
  if (box) {
    const rows = $('#split-rows'), on = $('#split-on'), sum = $('#split-sum');
    const tpl = rows.firstElementChild.cloneNode(true);
    function check() {
      const total = parse($('#amount').value);
      const parts = $$('input[name="split_amount[]"]', rows).reduce((s, i) => s + parse(i.value), 0);
      const diff = total - parts;
      sum.className = 'ej-hint' + (Math.abs(diff) > 0.001 && parts > 0 ? ' neg' : '');
      sum.textContent = parts === 0 ? '' : Math.abs(diff) < 0.001 ? `Suma ${fmt(parts)} ✓` : diff > 0 ? `Faltan ${fmt(diff)}` : `Sobran ${fmt(-diff)}`;
    }
    box.addEventListener('toggle', () => {
      on.value = box.open ? '1' : '';
      if (cat) { cat.closest('.field').classList.toggle('is-off', box.open); }
      if (box.open) { const first = $('input[name="split_amount[]"]', rows); if (first && !first.value) first.focus(); }
    });
    if (box.open && cat) cat.closest('.field').classList.add('is-off');
    $('#split-add').addEventListener('click', () => {
      const r = tpl.cloneNode(true); $$('input', r).forEach((i) => { i.value = ''; delete i.dataset.ejMoney; }); $$('select', r).forEach((s) => { s.value = ''; });
      rows.appendChild(r); bindRow(r); $('input', r).focus();
    });
    function bindRow(r) {
      const inp = $('input', r);
      if (window.EriJuliMoney) window.EriJuliMoney(inp);
      inp.addEventListener('input', check);
      $('.split-del', r).addEventListener('click', () => { if ($$('.split-row', rows).length > 2) r.remove(); else { inp.value = ''; } check(); });
    }
    $$('.split-row', rows).forEach(bindRow);
    $('#amount').addEventListener('input', check);
    // Atajo: si falta poco, completar la última parte
    form.addEventListener('submit', (e) => {
      if (!box.open || kindOf() !== 'gasto') { on.value = ''; return; }
      const total = parse($('#amount').value);
      const inputs = $$('input[name="split_amount[]"]', rows).filter((i) => parse(i.value) > 0);
      const parts = inputs.reduce((s, i) => s + parse(i.value), 0);
      if (inputs.length >= 2 && Math.abs(total - parts) > 0.001) {
        e.preventDefault(); e.stopImmediatePropagation(); check(); sum.scrollIntoView({ block: 'center' });
      }
    }, true);
    check();
  }

  // ---------- Escanear recibo o comprobante ----------
  const scanFile = $('#scan-file'), scanStatus = $('#scan-status'), scanCard = $('#scan-card');
  const csrf = ($('input[name="_csrf"]', form) || {}).value;
  async function loadImage(f) {
    return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(f); });
  }
  function toCanvas(img, max, gray) {
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
    const ctx = c.getContext('2d');
    if (gray) ctx.filter = 'grayscale(1) contrast(1.25)';
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c;
  }
  const setStatus = (html, cls) => { scanStatus.hidden = !html; scanStatus.className = 'scan-status' + (cls ? ' ' + cls : ''); scanStatus.innerHTML = html || ''; };
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function mark(el) { if (!el) return; el.classList.remove('is-suggested'); void el.offsetWidth; el.classList.add('is-suggested'); }
  function setSelect(sel, value) {
    if (!sel || value === null || value === undefined || value === '') return false;
    const opt = [...sel.options].find((o) => o.value === String(value));
    if (!opt || opt.hidden) return false;
    sel.value = String(value); sel.dispatchEvent(new Event('change', { bubbles: true }));
    mark(sel.nextElementSibling && sel.nextElementSibling.classList.contains('ej-picker') ? sel.nextElementSibling : sel);
    return true;
  }
  function applySuggestion(sg) {
    const filled = [];
    const kindInput = $(`input[name="kind"][value="${sg.kind}"]`, form);
    if (kindInput && !kindInput.checked) { kindInput.closest('label').click(); }
    if (sg.amount) {
      const a = $('#amount'); a.value = String(Math.round(sg.amount / 100)); a.dispatchEvent(new Event('input', { bubbles: true })); mark(a); filled.push('valor');
    }
    if (sg.date) {
      const d = form.querySelector('input[name="date"]'); if (d) { d.value = sg.date; d.dispatchEvent(new Event('ej:refresh')); mark(d.previousElementSibling); filled.push('fecha'); }
    }
    if (sg.description) { const de = $('#description'); de.value = sg.description; mark(de); filled.push('descripción'); }
    if (sg.kind === 'gasto') {
      if (setSelect($('#container_from_id'), sg.container_from_id)) filled.push('de dónde salió');
      if (setSelect($('#category_id'), sg.category_id)) filled.push('categoría');
    } else {
      if (setSelect($('#container_to_id'), sg.container_to_id)) filled.push('a dónde entró');
      if (setSelect($('#income_source_id'), sg.income_source_id)) filled.push('fuente');
      if (setSelect($('#category_id_income'), sg.category_id)) filled.push('categoría');
    }
    if (sg.notes) { const n = $('#notes'); if (n && !n.value.includes(sg.notes)) n.value = (n.value ? n.value + ' · ' : '') + sg.notes; }
    return filled;
  }
  if (scanFile) {
    scanFile.addEventListener('change', async () => {
      const f = scanFile.files[0]; if (!f) return;
      scanCard.classList.add('is-busy');
      setStatus('<span class="scan-progress" aria-hidden="true"></span><span>Leyendo el recibo… puede tardar unos segundos.</span>');
      try {
        const img = await loadImage(f);
        const forOcr = toCanvas(img, 2000, true).toDataURL('image/jpeg', 0.85);
        // La foto a color también queda como recibo del movimiento
        const keep = toCanvas(img, 1600, false).toDataURL('image/jpeg', 0.82);
        if (data && prev) { data.value = keep; $('img', prev).src = keep; prev.hidden = false; }
        URL.revokeObjectURL(img.src);
        const r = await fetch('/escanear', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ _csrf: csrf, image: forOcr }) });
        const out = await r.json().catch(() => ({ ok: false, error: 'Respuesta inválida del servidor.' }));
        if (r.status === 423) { location.href = '/bloqueo'; return; }
        if (!out.ok) throw new Error(out.error || 'No pudimos leer la imagen.');
        if (out.empty) {
          setStatus('<strong>No encontramos texto en la imagen.</strong> Prueba con más luz, sin reflejos y con el recibo completo en la foto. La foto quedó adjunta para que lo registres a mano.', 'warn');
          return;
        }
        const filled = applySuggestion(out.suggestion);
        const sg = out.suggestion;
        const money = sg.amount ? '$' + Math.round(sg.amount / 100).toLocaleString('es-CO') : null;
        const missing = [!sg.amount && 'el valor', !sg.date && 'la fecha'].filter(Boolean);
        setStatus(`<div class="scan-result"><svg class="ic ic-sm" aria-hidden="true" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>
            <div><strong>${money ? esc(money) + ' · ' : ''}${esc(sg.description || (sg.kind === 'ingreso' ? 'Ingreso' : 'Gasto'))}</strong>
            <small>Llenamos ${esc(filled.join(', ') || 'lo que pudimos')}. ${missing.length ? 'No encontramos ' + esc(missing.join(' ni ')) + ': complétalo tú. ' : ''}Revisa antes de guardar.</small></div></div>
          <details class="scan-text-read"><summary class="link">Ver el texto que leímos</summary><pre>${esc(out.text.trim())}</pre></details>`, 'ok');
        if (!sg.amount) $('#amount').focus();
      } catch (e) {
        setStatus('<strong>No se pudo escanear.</strong> ' + esc(e.message || '') , 'error');
      } finally {
        scanCard.classList.remove('is-busy');
        scanFile.value = '';
      }
    });
  }

  // Foto del recibo: se reduce en el celular antes de enviarla (máx. 1600 px, JPEG)
  const file = $('#receipt-file'), data = $('#receipt-data'), prev = $('#receipt-preview');
  if (file) {
    file.addEventListener('change', async () => {
      const f = file.files[0]; if (!f) return;
      try {
        const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(f); });
        const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        const url = c.toDataURL('image/jpeg', 0.82);
        data.value = url; $('img', prev).src = url; prev.hidden = false;
        URL.revokeObjectURL(img.src);
      } catch { data.value = ''; prev.hidden = true; }
    });
    $('#receipt-clear').addEventListener('click', () => { data.value = ''; file.value = ''; prev.hidden = true; });
  }
})();
