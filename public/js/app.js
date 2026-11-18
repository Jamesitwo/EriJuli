// Interfaz: ajustes menores sin dependencias
document.addEventListener('DOMContentLoaded', () => {
  // Selector de tipo de movimiento: muestra/oculta campos según el tipo
  const kindPicker = document.getElementById('kind-picker');
  const form = document.getElementById('tx-form');
  if (kindPicker && form) {
    const fieldFrom = document.getElementById('field-from');
    const fieldTo = document.getElementById('field-to');
    const cardExpense = document.getElementById('card-expense');
    const cardIncome = document.getElementById('card-income');
    const catExpense = document.getElementById('category_id');
    const catIncome = document.getElementById('category_id_income');

    const sync = () => {
      const kind = form.querySelector('input[name="kind"]:checked').value;
      kindPicker.querySelectorAll('label').forEach((l) => {
        l.classList.toggle('active', l.querySelector('input').checked);
      });
      if (fieldFrom) fieldFrom.style.display = kind === 'ingreso' ? 'none' : '';
      if (fieldTo) fieldTo.style.display = kind === 'gasto' ? 'none' : '';
      if (cardExpense) cardExpense.style.display = kind === 'gasto' ? '' : 'none';
      if (cardIncome) cardIncome.style.display = kind === 'ingreso' ? '' : 'none';
      // Solo el selector de categoría visible envía su valor
      if (catExpense) catExpense.disabled = kind !== 'gasto';
      if (catIncome) catIncome.disabled = kind !== 'ingreso';
    };
    kindPicker.addEventListener('change', sync);
    sync();
  }

  // Importar CSV: cargar archivo al textarea
  const fileInput = document.getElementById('csv_file');
  const csvText = document.getElementById('csv_text');
  if (fileInput && csvText) {
    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => { csvText.value = reader.result; };
      reader.readAsText(file, 'utf-8');
    });
  }

  // Ocultar mensajes flash después de unos segundos
  document.querySelectorAll('.flash').forEach((el) => {
    setTimeout(() => {
      el.style.transition = 'opacity .4s';
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 400);
    }, 6000);
  });

  // Registrar el service worker (PWA instalable en el celular)
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
});
