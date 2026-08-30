const crypto = require('node:crypto');
const { env } = require('../config/env');

const VERSION = 'v1';
const SALT = 'viralizeai:ai-provider-credentials:v1';

function secret() {
  return String(env.aiCredentialsSecret || env.sessionSecret || '').trim();
}

function key() {
  const value = secret();
  if (!value) {
    const err = new Error('Configure AI_CREDENTIALS_SECRET para salvar credenciais de IA.');
    err.status = 500;
    throw err;
  }
  return crypto.scryptSync(value, SALT, 32);
}

function encrypt(value) {
  const plain = String(value || '').trim();
  if (!plain) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join(':');
}

function decrypt(value) {
  const packed = String(value || '').trim();
  if (!packed) return '';
  const [version, ivRaw, tagRaw, encryptedRaw] = packed.split(':');
  if (version !== VERSION || !ivRaw || !tagRaw || !encryptedRaw) {
    throw new Error('Credencial de IA armazenada em formato inválido.');
  }
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key(),
    Buffer.from(ivRaw, 'base64url')
  );
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

module.exports = { encrypt, decrypt };
