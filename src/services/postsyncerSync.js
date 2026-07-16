const postsyncerService = require('./postsyncerService');
const FacebookPages = require('../models/FacebookPages');
const FacebookAccounts = require('../models/FacebookAccounts');

function normName(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function serializeAccount(account) {
  return {
    id: account.id,
    workspace_id: account.workspace_id || null,
    platform: account.platform || null,
    name: account.name || null,
    username: account.username || null,
    avatar: account.avatar || null,
  };
}

/**
 * Lista contas Facebook do PostSyncer e tenta vincular às páginas do app pelo nome.
 */
async function syncPostsyncerAccounts(userId) {
  postsyncerService.assertConfigured();
  const workspaceId = await postsyncerService.resolveWorkspaceId();
  const all = await postsyncerService.listAccounts(workspaceId);
  const fbAccounts = all.filter(postsyncerService.isFacebookAccount);

  const fbAcc = await FacebookAccounts.findByUser(userId);
  const pages = fbAcc ? await FacebookPages.findByAccount(fbAcc.id) : [];

  const used = new Set(
    pages.filter((p) => p.postsyncer_account_id).map((p) => Number(p.postsyncer_account_id))
  );

  let linked = 0;
  for (const page of pages) {
    if (page.postsyncer_account_id) continue;
    const pageNorm = normName(page.page_name);
    const hit = fbAccounts.find((a) => {
      if (used.has(Number(a.id))) return false;
      const n = normName(a.name);
      const u = normName(a.username);
      if (pageNorm && n && (n === pageNorm || n.includes(pageNorm) || pageNorm.includes(n))) {
        return true;
      }
      if (page.page_id && String(a.username) === String(page.page_id)) return true;
      if (u && pageNorm && (u === pageNorm || pageNorm.includes(u))) return true;
      return false;
    });
    if (!hit) continue;
    await FacebookPages.setPostsyncerAccount(page.id, hit.id);
    used.add(Number(hit.id));
    linked += 1;
  }

  const pagesAfter = fbAcc ? await FacebookPages.findByAccount(fbAcc.id) : [];
  return {
    workspaceId,
    accounts: fbAccounts.map(serializeAccount),
    linked,
    pages: pagesAfter.map((p) => ({
      id: p.id,
      page_name: p.page_name,
      page_id: p.page_id,
      postsyncer_account_id: p.postsyncer_account_id || null,
    })),
  };
}

async function linkPageToPostsyncer(userId, facebookPageId, postsyncerAccountId) {
  postsyncerService.assertConfigured();
  const fbAcc = await FacebookAccounts.findByUser(userId);
  if (!fbAcc) {
    const err = new Error('Conecte uma conta Facebook no app antes de vincular');
    err.status = 400;
    throw err;
  }

  const page = await FacebookPages.findById(facebookPageId);
  if (!page || Number(page.facebook_account_id) !== Number(fbAcc.id)) {
    const err = new Error('Página não encontrada');
    err.status = 404;
    throw err;
  }

  const workspaceId = await postsyncerService.resolveWorkspaceId();
  const accounts = await postsyncerService.listAccounts(workspaceId);
  const hit = accounts.find((a) => Number(a.id) === Number(postsyncerAccountId));
  if (!hit || !postsyncerService.isFacebookAccount(hit)) {
    const err = new Error('Conta Facebook do PostSyncer não encontrada');
    err.status = 404;
    throw err;
  }

  await FacebookPages.setPostsyncerAccount(page.id, hit.id);
  const finalPage = await FacebookPages.findById(page.id);
  return {
    page: {
      id: finalPage.id,
      page_name: finalPage.page_name,
      page_id: finalPage.page_id,
      postsyncer_account_id: finalPage.postsyncer_account_id,
    },
    postsyncer: serializeAccount(hit),
    workspaceId,
  };
}

module.exports = {
  syncPostsyncerAccounts,
  linkPageToPostsyncer,
  serializeAccount,
};
