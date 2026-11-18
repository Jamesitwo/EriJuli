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
