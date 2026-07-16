const postpulseService = require('./postpulseService');
const PostpulseConnections = require('../models/PostpulseConnections');
const FacebookAccounts = require('../models/FacebookAccounts');
const FacebookPages = require('../models/FacebookPages');

/**
 * Associa contas FACEBOOK do PostPulse às páginas já salvas (mesmo page_id).
 */
async function syncPostpulseAccounts(userId) {
  const conn = await PostpulseConnections.findByUser(userId);
  if (!conn?.access_token) return { matched: 0, accounts: [] };

  const accounts = await postpulseService.listAccounts(conn.access_token);
  const fbAccounts = accounts.filter((a) =>
    String(a.platform || '')
      .toUpperCase()
      .includes('FACEBOOK')
  );

  const account = await FacebookAccounts.findByUser(userId);
  if (!account) {
    return { matched: 0, accounts: fbAccounts };
  }

  const pages = await FacebookPages.findByAccount(account.id);
  let matched = 0;

  for (const page of pages) {
    const hit = fbAccounts.find((a) => String(a.accountId) === String(page.page_id));
    if (hit) {
      await FacebookPages.setPostpulseAccount(page.id, hit.id);
      matched += 1;
    }
  }

  return { matched, accounts: fbAccounts };
}

module.exports = { syncPostpulseAccounts };
