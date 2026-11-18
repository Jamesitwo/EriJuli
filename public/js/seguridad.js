// EriJuli · seguridad: notificaciones, huella / Face ID y teclado del PIN
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const csrf = () => (document.querySelector('input[name="_csrf"]') || {}).value;

  // ---------- base64url <-> ArrayBuffer ----------
  const b64uToBuf = (s) => {
    const pad = '='.repeat((4 - (s.length % 4)) % 4);
    const bin = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0)).buffer;
  };
  const bufToB64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  async function postJSON(url, data) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ _csrf: csrf(), ...data }), credentials: 'same-origin' });
    return r.json();
  }

  const webauthnOK = !!(window.PublicKeyCredential && navigator.credentials && window.isSecureContext);

  function creationOptions(o) {
    if (PublicKeyCredential.parseCreationOptionsFromJSON) return PublicKeyCredential.parseCreationOptionsFromJSON(o);
    return { ...o, challenge: b64uToBuf(o.challenge), user: { ...o.user, id: b64uToBuf(o.user.id) },
      excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) })) };
  }
  function requestOptions(o) {
    if (PublicKeyCredential.parseRequestOptionsFromJSON) return PublicKeyCredential.parseRequestOptionsFromJSON(o);
    return { ...o, challenge: b64uToBuf(o.challenge), allowCredentials: (o.allowCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) })) };
  }
  function credJSON(c) {
    if (c.toJSON) return c.toJSON();
    const r = c.response, out = { id: c.id, rawId: bufToB64u(c.rawId), type: c.type, clientExtensionResults: c.getClientExtensionResults(), authenticatorAttachment: c.authenticatorAttachment, response: { clientDataJSON: bufToB64u(r.clientDataJSON) } };
    if (r.attestationObject) { out.response.attestationObject = bufToB64u(r.attestationObject); out.response.transports = r.getTransports ? r.getTransports() : []; }
    if (r.authenticatorData) { out.response.authenticatorData = bufToB64u(r.authenticatorData); out.response.signature = bufToB64u(r.signature); if (r.userHandle) out.response.userHandle = bufToB64u(r.userHandle); }
    return out;
  }
  const deviceName = () => {
    const ua = navigator.userAgent;
    if (/iPhone/.test(ua)) return 'iPhone'; if (/iPad/.test(ua)) return 'iPad'; if (/Android/.test(ua)) return 'Android';
    if (/Mac/.test(ua)) return 'Mac'; if (/Windows/.test(ua)) return 'Windows'; return 'Este dispositivo';
  };

  // ---------- Registrar huella ----------
  const addBio = $('#add-biometric');
  if (addBio) {
    if (webauthnOK) addBio.hidden = false; else { const u = $('#biometric-unsupported'); if (u) u.hidden = false; }
    addBio.addEventListener('click', async () => {
      addBio.disabled = true;
      try {
        const opts = await postJSON('/seguridad/huella/opciones', {});
        if (opts.error) throw new Error(opts.error);
        const cred = await navigator.credentials.create({ publicKey: creationOptions(opts) });
        const r = await postJSON('/seguridad/huella/registrar', { credential: credJSON(cred), label: deviceName() });
        if (r.ok) location.reload(); else throw new Error(r.error || 'No se pudo verificar');
      } catch (e) {
        addBio.disabled = false;
        if (e.name !== 'NotAllowedError') { const u = $('#biometric-unsupported'); if (u) { u.hidden = false; u.textContent = 'No se pudo agregar la huella: ' + e.message; } }
      }
    });
  }

  // ---------- Desbloquear ----------
  const pinInput = $('#pin-input');
  if (pinInput) {
    const dots = document.querySelectorAll('.pin-dots i');
    const paint = () => dots.forEach((d, i) => d.classList.toggle('on', i < pinInput.value.length));
    pinInput.addEventListener('input', () => { pinInput.value = pinInput.value.replace(/\D/g, '').slice(0, 6); paint(); });
    document.querySelectorAll('.keypad [data-k]').forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.k;
      pinInput.value = k === 'del' ? pinInput.value.slice(0, -1) : (pinInput.value + k).slice(0, 6);
      paint();
    }));
    const bio = $('#unlock-bio');
    const unlockBio = async () => {
      try {
        const opts = await postJSON('/bloqueo/huella/opciones', {});
        const cred = await navigator.credentials.get({ publicKey: requestOptions(opts) });
        const r = await postJSON('/bloqueo/huella/verificar', { credential: credJSON(cred) });
        if (r.ok) location.href = r.next || '/';
      } catch (e) { /* la persona canceló: queda el PIN */ }
    };
    if (bio) {
      if (!webauthnOK) bio.style.visibility = 'hidden';
      else { bio.addEventListener('click', unlockBio); setTimeout(unlockBio, 300); }
    }
  }

  // ---------- Notificaciones ----------
  const box = $('#push-actions');
  if (box) {
    const on = $('#push-on'), off = $('#push-off'), test = $('#push-test'), help = $('#push-help'), status = $('#push-status');
    const say = (t) => { help.hidden = !t; help.textContent = t || ''; };
    const supported = 'serviceWorker' in navigator && 'PushManager' in window && window.isSecureContext;
    if (!supported) {
      on.hidden = true;
      const iOS = /iPhone|iPad/.test(navigator.userAgent);
      say(iOS ? 'En iPhone primero instala la app: botón Compartir → "Agregar a inicio", ábrela desde el ícono y vuelve aquí.' : 'Este navegador no permite notificaciones aquí (se necesita HTTPS).');
    } else {
      navigator.serviceWorker.ready.then(async (reg) => {
        const sub = await reg.pushManager.getSubscription();
        if (sub) { on.hidden = true; off.hidden = false; test.hidden = false; }
      });
      on.addEventListener('click', async () => {
        on.disabled = true;
        try {
          const perm = await Notification.requestPermission();
          if (perm !== 'granted') { say('Permiso denegado. Actívalo en los ajustes del navegador para este sitio.'); on.disabled = false; return; }
          const reg = await navigator.serviceWorker.ready;
          const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBuf(box.dataset.key) });
          const r = await postJSON('/push/suscribir', { subscription: sub.toJSON() });
          if (!r.ok) throw new Error(r.error);
          on.hidden = true; off.hidden = false; test.hidden = false; status.textContent = 'Activas en este dispositivo'; status.className = 'badge badge-success';
          say('');
        } catch (e) { say('No se pudo activar: ' + e.message); on.disabled = false; }
      });
      off.addEventListener('click', async () => {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) { await postJSON('/push/cancelar', { endpoint: sub.endpoint }); await sub.unsubscribe(); }
        off.hidden = true; test.hidden = true; on.hidden = false; on.disabled = false; status.textContent = 'Desactivadas en este dispositivo'; status.className = 'badge';
      });
      test.addEventListener('click', async () => {
        const r = await postJSON('/push/prueba', {});
        say(r.ok ? 'Enviada. Debería llegarte en unos segundos.' : 'No se pudo enviar.');
      });
    }
  }

  // ---------- Copiar códigos ----------
  document.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copiados'; } catch { /* sin portapapeles */ }
  }));
})();
