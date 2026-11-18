'use strict';
/**
 * Envío de correos (recuperar contraseña).
 * Configura SMTP en .env: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM.
 * Con Gmail usa una "contraseña de aplicación" (smtp.gmail.com, puerto 465).
 * Sin SMTP, el correo se escribe en la consola del servidor (útil en desarrollo).
 */
let transporter = null;
function getTransport() {
  if (transporter !== null) return transporter;
  if (!process.env.SMTP_HOST) { transporter = false; return transporter; }
  const nodemailer = require('nodemailer');
  const port = Number(process.env.SMTP_PORT || 465);
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  return transporter;
}

function isConfigured() { return Boolean(getTransport()); }

async function sendMail({ to, subject, text, html }) {
  const t = getTransport();
  if (!t) {
    console.log(`\n[correo sin SMTP] Para: ${to}\nAsunto: ${subject}\n${text}\n`);
    return { logged: true };
  }
  await t.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, text, html });
  return { sent: true };
}

module.exports = { sendMail, isConfigured };
