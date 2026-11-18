'use strict';
/**
 * Dirección pública de la app (enlaces de correo, Gmail y huella / Face ID).
 * Orden: APP_URL → PUBLIC_URL → dominio que asigna Railway → la del navegador.
 */
function publicUrl(req) {
  const fixed = process.env.APP_URL || process.env.PUBLIC_URL
    || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '');
  const url = fixed || (req ? `${req.protocol}://${req.get('host')}` : 'http://localhost:3000');
  return url.replace(/\/$/, '');
}

module.exports = { publicUrl };
