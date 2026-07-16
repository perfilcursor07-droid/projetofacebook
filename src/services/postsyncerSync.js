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

function tokens(value) {
  return normName(value)
    .split(/\s+/)
    .filter((t) => t.length >= 3);
}

function scoreMatch(page, account) {
  const pageNorm = normName(page.page_name);
  const pageId = String(page.page_id || '');
  const name = normName(account.name);
  const username = normName(account.username);
  const external =
    account.external_id ||
    account.platform_id ||
    account.account_id ||
    account.provider_id ||
    account.facebook_page_id ||
    null;
  const externalStr = external != null ? String(external) : '';

  let score = 0;

  // ID da Página Facebook (melhor sinal)
  if (pageId) {
    if (externalStr === pageId) score += 100;
    if (String(account.username || '') === pageId) score += 100;
    if (String(account.name || '') === pageId) score += 80;
    if (username.includes(pageId) || pageId.includes(username.replace(/\s/g, ''))) score += 40;
  }

  if (pageNorm && name) {
    if (pageNorm === name) score += 50;
    else if (pageNorm.includes(name) || name.includes(pageNorm)) score += 35;
    else {
      const pt = new Set(tokens(page.page_name));
      const at = tokens(account.name);
      let common = 0;
      for (const t of at) if (pt.has(t)) common += 1;
      if (common) score += common * 12;
    }
  }

  if (pageNorm && username) {
    const uCompact = username.replace(/\s/g, '');
    const pCompact = pageNorm.replace(/\s/g, '');
    if (uCompact && (uCompact === pCompact || pCompact.includes(uCompact) || uCompact.includes(pCompact))) {
      score += 25;
    }
  }

  return score;
}

function serializeAccount(account) {
  return {
    id: account.id,
    workspace_id: account.workspace_id || null,
    platform: account.platform || null,
    name: account.name || null,
    username: account.username || null,
    avatar: account.avatar || null,
    external_id:
      account.external_id ||
      account.platform_id ||
      account.account_id ||
      account.provider_id ||
      account.facebook_page_id ||
      null,
    label: [account.name, account.username].filter(Boolean).join(' · ') || `Conta #${account.id}`,
  };
}

/**
 * Lista contas Facebook do PostSyncer e tenta vincular às páginas do app.
 */
async function syncPostsyncerAccounts(userId) {
  postsyncerService.assertConfigured();
  const workspaceId = await postsyncerService.resolveWorkspaceId();
  const all = await postsyncerService.listAccounts(workspaceId);
  const fbAccounts = all.filter(postsyncerService.isFacebookAccount);

  console.log(
    '[postsyncer] accounts',
    JSON.stringify(fbAccounts.map((a) => ({ id: a.id, name: a.name, username: a.username, platform: a.platform }))).slice(
      0,
      2000
    )
  );

  const fbAcc = await FacebookAccounts.findByUser(userId);
  const pages = fbAcc ? await FacebookPages.findByAccount(fbAcc.id) : [];

  const used = new Set(
    pages.filter((p) => p.postsyncer_account_id).map((p) => Number(p.postsyncer_account_id))
  );

  let linked = 0;
  const links = [];

  // 1) Match por score (nome / page_id)
  for (const page of pages) {
    if (page.postsyncer_account_id) continue;
    let best = null;
    let bestScore = 0;
    for (const a of fbAccounts) {
      if (used.has(Number(a.id))) continue;
      const s = scoreMatch(page, a);
      if (s > bestScore) {
        bestScore = s;
        best = a;
      }
    }
    // Exige evidência mínima (evita ligar “Erick” em “Apocalipse Gospel”)
    if (!best || bestScore < 24) continue;
    await FacebookPages.setPostsyncerAccount(page.id, best.id);
    used.add(Number(best.id));
    linked += 1;
    links.push({ page: page.page_name, account: best.name || best.username, score: bestScore });
  }

  // 2) Fallback: páginas ainda sem vínculo
  const pagesNow = fbAcc ? await FacebookPages.findByAccount(fbAcc.id) : [];
  const openPages = pagesNow.filter((p) => !p.postsyncer_account_id);
  const freeAccounts = fbAccounts.filter((a) => !used.has(Number(a.id)));

  if (openPages.length === 1 && freeAccounts.length === 1) {
    const page = openPages[0];
    const acc = freeAccounts[0];
    await FacebookPages.setPostsyncerAccount(page.id, acc.id);
    used.add(Number(acc.id));
    linked += 1;
    links.push({ page: page.page_name, account: acc.name || acc.username, score: '1:1' });
  } else if (openPages.length > 0 && freeAccounts.length === openPages.length && openPages.length <= 3) {
    const free = [...freeAccounts];
    for (const page of openPages) {
      let best = null;
      let bestScore = -1;
      let bestIdx = -1;
      free.forEach((a, idx) => {
        const s = scoreMatch(page, a);
        if (s > bestScore) {
          bestScore = s;
          best = a;
          bestIdx = idx;
        }
      });
      if (!best || bestScore < 12) continue;
      await FacebookPages.setPostsyncerAccount(page.id, best.id);
      used.add(Number(best.id));
      free.splice(bestIdx, 1);
      linked += 1;
      links.push({ page: page.page_name, account: best.name || best.username, score: bestScore });
    }
  }

  const pagesAfter = fbAcc ? await FacebookPages.findByAccount(fbAcc.id) : [];
  const needsLink = pagesAfter.filter((p) => !p.postsyncer_account_id);

  return {
    workspaceId,
    accounts: fbAccounts.map(serializeAccount),
    linked,
    links,
    needs_manual: needsLink.length > 0,
    pages: pagesAfter.map((p) => ({
      id: p.id,
      page_name: p.page_name,
      page_id: p.page_id,
      postsyncer_account_id: p.postsyncer_account_id || null,
    })),
    hint:
      needsLink.length > 0
        ? 'Selecione abaixo a Página do app e a conta PostSyncer correspondente (ex.: Apocalipse Gospel) e clique em Vincular.'
        : null,
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
  scoreMatch,
};
