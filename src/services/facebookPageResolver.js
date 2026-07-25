const FacebookPages = require('../models/FacebookPages');
const FacebookAccounts = require('../models/FacebookAccounts');
const Users = require('../models/Users');

/**
 * Resolve páginas do Facebook SEMPRE no escopo do usuário logado.
 * Publicar na página de outra conta é considerado erro, não fallback.
 */

/** Páginas que pertencem à conta Facebook do usuário. */
async function pagesForUser(userId) {
  const account = await FacebookAccounts.findByUser(userId);
  if (!account) return [];
  return FacebookPages.findByAccount(account.id);
}

/** Página por id, apenas se pertencer ao usuário. Caso contrário, null. */
async function resolvePageForUser(userId, facebookPageId) {
  const id = Number(facebookPageId || 0);
  if (!id) return null;
  const page = await FacebookPages.findById(id);
  if (!page) return null;
  const account = await FacebookAccounts.findByUser(userId);
  if (!account || Number(page.facebook_account_id) !== Number(account.id)) return null;
  return page;
}

/**
 * Página padrão do usuário logado, validada contra as páginas dele.
 * Se a padrão apontar para página inexistente//de outra conta, o vínculo é limpo
 * em vez de ser usado — nunca cai para “a primeira página encontrada”.
 */
async function defaultPageIdForUser(userId) {
  const stored = await Users.getDefaultFacebookPageId(userId);
  if (!stored) return null;
  const page = await resolvePageForUser(userId, stored);
  if (!page) {
    await Users.setDefaultFacebookPageId(userId, null);
    return null;
  }
  return Number(page.id);
}

/** Página padrão do usuário (registro completo) ou null. */
async function defaultPageForUser(userId) {
  const id = await defaultPageIdForUser(userId);
  if (!id) return null;
  return resolvePageForUser(userId, id);
}

module.exports = {
  pagesForUser,
  resolvePageForUser,
  defaultPageIdForUser,
  defaultPageForUser,
};
