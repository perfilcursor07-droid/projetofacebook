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

function matchChat(page, chats) {
  if (!Array.isArray(chats) || !chats.length) return null;

  const byId = chats.find(
    (c) =>
      c.id != null &&
      (String(c.id) === String(page.page_id) || String(c.id).includes(String(page.page_id)))
  );
  if (byId) return byId;

  const pageNorm = normName(page.page_name);
  if (!pageNorm) return null;

  return (
    chats.find(
      (c) =>
        normName(c.title) === pageNorm ||
        normName(c.name) === pageNorm ||
        normName(c.accountDisplayName) === pageNorm
    ) || null
  );
}

/**
 * Busca chats (Pages) no PostPulse e grava postpulse_chat_id.
 * Fallback: usa o page_id da Graph API (ID numérico da Página).
 */
async function resolveChatsForPages(accessToken, pages) {
  const byAccount = new Map();
  let chatsResolved = 0;

  for (const page of pages) {
    if (!page.postpulse_account_id) continue;

    const accId = Number(page.postpulse_account_id);
    if (!byAccount.has(accId)) {
      try {
        const chats = await postpulseService.listChats(accessToken, accId, 'FACEBOOK');
        console.log('[postpulse] chats for account', accId, JSON.stringify(chats).slice(0, 1500));
        byAccount.set(accId, chats);
      } catch (err) {
        console.warn(
          '[postpulse] listChats falhou',
          accId,
          postpulseService.apiErrorMessage(err)
        );
        byAccount.set(accId, []);
      }
    }

    const chats = byAccount.get(accId) || [];
    let chat = matchChat(page, chats);

    if (!chat && chats.length === 1) {
      const pagesWithThisAcc = pages.filter(
        (p) => Number(p.postpulse_account_id) === accId
      );
      if (pagesWithThisAcc.length === 1) chat = chats[0];
    }

    // Fallback forte: o chatId da Page no PostPulse costuma ser o próprio page_id do Facebook
    const chatId = chat?.id != null ? String(chat.id) : String(page.page_id);

    await FacebookPages.setPostpulseLink(page.id, {
      postpulseAccountId: page.postpulse_account_id,
      postpulseChatId: chatId,
    });
    chatsResolved += 1;
    console.log('[postpulse] chat vinculado', {
      page: page.page_name,
      page_id: page.page_id,
      chatId,
      fromApi: Boolean(chat?.id),
    });
  }

  return chatsResolved;
}

/**
 * Associa contas FACEBOOK do PostPulse às páginas do app + resolve chatId da Page.
 */
async function syncPostpulseAccounts(userId) {
  const conn = await PostpulseConnections.findByUser(userId);
  if (!conn?.access_token) {
    return { matched: 0, chatsResolved: 0, accounts: [], pages: [], autoLinked: false };
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
      chatsResolved: 0,
      accounts: fbAccounts.map(serializeAccount),
      pages: [],
      autoLinked: false,
      hint: 'Conecte o Facebook Graph em /paginas para listar páginas e vincular.',
    };
  }

  const pages = await FacebookPages.findByAccount(account.id);
  let autoLinked = false;
  const usedPpIds = new Set();

  for (const page of pages) {
    if (page.postpulse_account_id) {
      usedPpIds.add(Number(page.postpulse_account_id));
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
    }
  }

  const pagesAfterLink = await FacebookPages.findByAccount(account.id);
  const unlinkedPages = pagesAfterLink.filter((p) => !p.postpulse_account_id);
  const unusedPp = fbAccounts.filter((a) => !usedPpIds.has(Number(a.id)));

  if (unlinkedPages.length === 1 && unusedPp.length === 1) {
    await FacebookPages.setPostpulseAccount(unlinkedPages[0].id, unusedPp[0].id);
    autoLinked = true;
  }

  const pagesForChats = await FacebookPages.findByAccount(account.id);
  const chatsResolved = await resolveChatsForPages(conn.access_token, pagesForChats);

  const finalPages = await FacebookPages.findByAccount(account.id);
  const linkedCount = finalPages.filter((p) => p.postpulse_account_id).length;

  return {
    matched: linkedCount,
    chatsResolved,
    autoLinked,
    accounts: fbAccounts.map(serializeAccount),
    pages: finalPages.map((p) => ({
      id: p.id,
      page_id: p.page_id,
      page_name: p.page_name,
      postpulse_account_id: p.postpulse_account_id || null,
      postpulse_chat_id: p.postpulse_chat_id || null,
    })),
  };
}

/**
 * Vincula manualmente uma página do app a uma conta PostPulse e resolve o chat.
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

  const refreshed = await FacebookPages.findById(page.id);
  await resolveChatsForPages(conn.access_token, [refreshed]);
  const finalPage = await FacebookPages.findById(page.id);

  return {
    page: {
      id: finalPage.id,
      page_name: finalPage.page_name,
      postpulse_account_id: finalPage.postpulse_account_id,
      postpulse_chat_id: finalPage.postpulse_chat_id || null,
    },
    postpulse: serializeAccount(hit),
  };
}

/**
 * Garante chatId antes de publicar (busca chats se faltar).
 */
async function ensureChatId(userId, page) {
  if (page.postpulse_chat_id) return String(page.postpulse_chat_id);
  if (!page.postpulse_account_id) return null;

  const conn = await PostpulseConnections.findByUser(userId);
  if (!conn?.access_token) return null;

  await resolveChatsForPages(conn.access_token, [page]);
  const refreshed = await FacebookPages.findById(page.id);
  if (refreshed?.postpulse_chat_id) return String(refreshed.postpulse_chat_id);

  // Último recurso: page_id da Graph
  if (page.page_id) {
    await FacebookPages.setPostpulseLink(page.id, {
      postpulseAccountId: page.postpulse_account_id,
      postpulseChatId: String(page.page_id),
    });
    return String(page.page_id);
  }
  return null;
}

module.exports = {
  syncPostpulseAccounts,
  linkPageToPostpulse,
  ensureChatId,
  resolveChatsForPages,
};
