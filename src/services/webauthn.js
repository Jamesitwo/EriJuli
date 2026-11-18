'use strict';
// Huella / Face ID / Windows Hello con WebAuthn (passkeys del dispositivo)
const {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const { db } = require('../db');

function rp(req) {
  const origin = require('../utils/url').publicUrl(req);
  return { rpID: process.env.RP_ID || new URL(origin).hostname, origin };
}

function credentials(userId) {
  return db.prepare('SELECT * FROM webauthn_credentials WHERE user_id = ? ORDER BY id').all(userId);
}

async function registrationOptions(req) {
  const { rpID } = rp(req);
  const user = req.user;
  const opts = await generateRegistrationOptions({
    rpName: 'EriJuli',
    rpID,
    userName: user.email,
    userDisplayName: user.name || user.email,
    userID: new TextEncoder().encode(String(user.id)),
    attestationType: 'none',
    excludeCredentials: credentials(user.id).map((c) => ({ id: c.cred_id, transports: c.transports ? c.transports.split(',') : undefined })),
    authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'preferred', userVerification: 'required' },
  });
  req.session.webauthnChallenge = opts.challenge;
  return opts;
}

async function verifyRegistration(req, response, label) {
  const { rpID, origin } = rp(req);
  const v = await verifyRegistrationResponse({
    response, expectedChallenge: req.session.webauthnChallenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
  });
  delete req.session.webauthnChallenge;
  if (!v.verified || !v.registrationInfo) return false;
  const { credential } = v.registrationInfo;
  db.prepare('INSERT OR IGNORE INTO webauthn_credentials (user_id, cred_id, public_key, counter, transports, label) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.user.id, credential.id, Buffer.from(credential.publicKey).toString('base64'), credential.counter || 0,
      (response.response && response.response.transports || []).join(','), String(label || 'Este dispositivo').slice(0, 60));
  return true;
}

async function authenticationOptions(req) {
  const { rpID } = rp(req);
  const opts = await generateAuthenticationOptions({
    rpID, userVerification: 'required',
    allowCredentials: credentials(req.user.id).map((c) => ({ id: c.cred_id, transports: c.transports ? c.transports.split(',') : undefined })),
  });
  req.session.webauthnChallenge = opts.challenge;
  return opts;
}

async function verifyAuthentication(req, response) {
  const { rpID, origin } = rp(req);
  const cred = db.prepare('SELECT * FROM webauthn_credentials WHERE user_id = ? AND cred_id = ?').get(req.user.id, response && response.id);
  if (!cred) return false;
  const v = await verifyAuthenticationResponse({
    response, expectedChallenge: req.session.webauthnChallenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
    credential: { id: cred.cred_id, publicKey: new Uint8Array(Buffer.from(cred.public_key, 'base64')), counter: cred.counter, transports: cred.transports ? cred.transports.split(',') : undefined },
  });
  delete req.session.webauthnChallenge;
  if (!v.verified) return false;
  db.prepare('UPDATE webauthn_credentials SET counter = ? WHERE id = ?').run(v.authenticationInfo.newCounter, cred.id);
  return true;
}

module.exports = { credentials, registrationOptions, verifyRegistration, authenticationOptions, verifyAuthentication };
