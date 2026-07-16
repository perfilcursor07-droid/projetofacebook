const postpulseService = require('./postpulseService');
const PostpulseConnections = require('../models/PostpulseConnections');
const FacebookAccounts = require('../models/FacebookAccounts');
const FacebookPages = require('../models/FacebookPages');

function normName(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function serializeAccount(a) {
  return {
    id: a.id,
    platform: a.platform,
    accountId: a.accountId != null ? String(a.accountId) : null,
    accountDisplayName: a.accountDisplayName || a.accountUsername || null,
    accountUsername: a.accountUsername || null,
  };
}

/**
 * Associa contas FACEBOOK do PostPulse às páginas do app.
 * Ordem: page_id === accountId → nome igual → 1 página + 1 conta FB (auto).
 */
async function syncPostpulseAccounts(userId) {
  const conn = await PostpulseConnections.findByUser(userId);
  if (!conn?.access_token) {
    return { matched: 0, accounts: [], pages: [], autoLinked: false };
  }

  const accounts = await postpulseService.listAccounts(conn.access_token);
  console.log('[postpulse] accounts raw', JSON.stringify(accounts).slice(0, 2000));

  const fbAccounts = accounts.filter((a) => {
    const p = String(a.platform || '').toUpperCase();
    return p.includes('FACEBOOK') || p === 'FB';
  });

  const account = await FacebookAccounts.findByUser(userId);
  if (!account) {
    return {
      matched: 0,
      accounts: fbAccounts.map(serializeAccount),
      pages: [],
      autoLinked: false,
      hint: 'Conecte o Facebook Graph em /paginas para listar páginas e vincular.',
    };
  }

  const pages = await FacebookPages.findByAccount(account.id);
  let matched = 0;
  let autoLinked = false;
  const usedPpIds = new Set();

  // Páginas já vinculadas contam e ocupam o slot PostPulse
  for (const page of pages) {
    if (page.postpulse_account_id) {
      usedPpIds.add(Number(page.postpulse_account_id));
      matched += 1;
    }
  }

  for (const page of pages) {
    if (page.postpulse_account_id) continue;

    const byId = fbAccounts.find(
      (a) => a.accountId != null && String(a.accountId) === String(page.page_id)
    );
    if (byId) {
      await FacebookPages.setPostpulseAccount(page.id, byId.id);
      usedPpIds.add(Number(byId.id));
      matched += 1;
      continue;
    }

    const pageNorm = normName(page.page_name);
    const byName = fbAccounts.find(
      (a) =>
        !usedPpIds.has(Number(a.id)) &&
        pageNorm &&
        (normName(a.accountDisplayName) === pageNorm ||
          normName(a.accountUsername) === pageNorm)
    );
    if (byName) {
      await FacebookPages.setPostpulseAccount(page.id, byName.id);
      usedPpIds.add(Number(byName.id));
      matched += 1;
    }
  }

  const pagesAfter = await FacebookPages.findByAccount(account.id);
  const unlinkedPages = pagesAfter.filter((p) => !p.postpulse_account_id);
  const unusedPp = fbAccounts.filter((a) => !usedPpIds.has(Number(a.id)));

  // Sempre vincula 1:1 quando sobra exatamente uma de cada
  if (unlinkedPages.length === 1 && unusedPp.length === 1) {
    await FacebookPages.setPostpulseAccount(unlinkedPages[0].id, unusedPp[0].id);
    matched += 1;
    autoLinked = true;
    console.log('[postpulse] auto-link 1:1', {
      page: unlinkedPages[0].page_name,
      page_id: unlinkedPages[0].page_id,
      ppId: unusedPp[0].id,
      ppName: unusedPp[0].accountDisplayName,
      ppAccountId: unusedPp[0].accountId,
    });
  } else {
    console.log('[postpulse] sync sem auto-link', {
      pages: pagesAfter.length,
      unlinked: unlinkedPages.length,
      fbAccounts: fbAccounts.length,
      unusedPp: unusedPp.length,
      pageIds: pagesAfter.map((p) => p.page_id),
      ppAccountIds: fbAccounts.map((a) => a.accountId),
    });
  }

  const finalPages = await FacebookPages.findByAccount(account.id);
  const linkedCount = finalPages.filter((p) => p.postpulse_account_id).length;

  return {
    matched: linkedCount,
    autoLinked,
    accounts: fbAccounts.map(serializeAccount),
    pages: finalPages.map((p) => ({
      id: p.id,
      page_id: p.page_id,
      page_name: p.page_name,
      postpulse_account_id: p.postpulse_account_id || null,
    })),
  };
}

/**
 * Vincula manualmente uma página do app a uma conta PostPulse.
 */
async function linkPageToPostpulse(userId, facebookPageId, postpulseAccountId) {
  const account = await FacebookAccounts.findByUser(userId);
  if (!account) {
    const err = new Error('Conta Facebook não conectada');
    err.status = 400;
    throw err;
  }

  const page = await FacebookPages.findById(facebookPageId);
  if (!page || page.facebook_account_id !== account.id) {
    const err = new Error('Página inválida');
    err.status = 400;
    throw err;
  }

  const conn = await PostpulseConnections.findByUser(userId);
  if (!conn?.access_token) {
    const err = new Error('PostPulse não conectado');
    err.status = 400;
    throw err;
  }

  const accounts = await postpulseService.listAccounts(conn.access_token);
  const hit = accounts.find((a) => Number(a.id) === Number(postpulseAccountId));
  if (!hit) {
    const err = new Error('Conta PostPulse não encontrada');
    err.status = 404;
    throw err;
  }

  await FacebookPages.setPostpulseAccount(page.id, hit.id);
  return {
    page: {
      id: page.id,
      page_name: page.page_name,
      postpulse_account_id: hit.id,
    },
    postpulse: serializeAccount(hit),
  };
}

module.exports = { syncPostpulseAccounts, linkPageToPostpulse };
