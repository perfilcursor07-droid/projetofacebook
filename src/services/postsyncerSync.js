const postsyncerService = require('./postsyncerService');
const FacebookPages = require('../models/FacebookPages');
const FacebookAccounts = require('../models/FacebookAccounts');
const db = require('../config/db');

function isPostsyncerStubAccount(account) {
  if (!account) return false;
  const token = String(account.access_token || '');
  const fbUid = String(account.fb_user_id || '');
  return token.startsWith('postsyncer:') || fbUid.startsWith('postsyncer:');
}

/**
 * Garante uma linha em facebook_accounts para o usuário.
 * Se não houver OAuth, cria stub — páginas e publicação vêm do PostSyncer.
 */
async function ensureFacebookAccountForUser(userId) {
  let fbAcc = await FacebookAccounts.findByUser(userId);
  if (fbAcc) return fbAcc;

  const fbUserId = `postsyncer:${userId}`;
  await db('facebook_accounts').insert({
    user_id: userId,
    fb_user_id: fbUserId,
    access_token: 'postsyncer:stub',
    expires_at: null,
  });
  fbAcc = await FacebookAccounts.findByUser(userId);
  if (!fbAcc) {
    const err = new Error('Não foi possível criar conta local para o PostSyncer');
    err.status = 500;
    throw err;
  }
  return fbAcc;
}

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

/** ID estável da Página no Facebook (ou fallback PostSyncer). */
function resolveExternalPageId(account) {
  const raw =
    account.external_id ||
    account.platform_id ||
    account.account_id ||
    account.provider_id ||
    account.facebook_page_id ||
    account.username ||
    null;
  if (raw != null && String(raw).trim()) {
    return String(raw).trim().slice(0, 64);
  }
  return `ps:${account.id}`.slice(0, 64);
}

/**
 * Importa contas Facebook do PostSyncer que ainda não existem como páginas no app.
 * Assim o seletor de publicação mostra as 3 páginas, não só as que vieram do Graph.
 */
async function importMissingPagesFromPostsyncer(fbAcc, fbAccounts, pages) {
  if (!fbAcc || !fbAccounts?.length) return { imported: 0, imports: [] };

  const byPsId = new Set(
    pages.filter((p) => p.postsyncer_account_id).map((p) => Number(p.postsyncer_account_id))
  );
  const byPageId = new Set(pages.map((p) => String(p.page_id)));
  const imports = [];

  for (const account of fbAccounts) {
    const psId = Number(account.id);
    if (byPsId.has(psId)) continue;

    const pageId = resolveExternalPageId(account);
    const pageName = String(account.name || account.username || `Página PostSyncer #${psId}`).slice(
      0,
      255
    );

    // Já existe página com esse page_id → só vincula
    const existing = pages.find((p) => String(p.page_id) === String(pageId));
    if (existing) {
      if (!existing.postsyncer_account_id) {
        await FacebookPages.setPostsyncerAccount(existing.id, psId);
        imports.push({ page: existing.page_name, account: pageName, mode: 'linked' });
      }
      byPsId.add(psId);
      continue;
    }

    // Cria página só via PostSyncer (token local é placeholder; publicação vai pelo PS)
    await FacebookPages.upsertMany([
      {
        facebook_account_id: fbAcc.id,
        page_id: pageId,
        page_name: pageName,
        page_access_token: `postsyncer:${psId}`,
      },
    ]);

    const created = await require('../config/db')('facebook_pages')
      .where({ facebook_account_id: fbAcc.id, page_id: pageId })
      .first();
    if (created) {
      await FacebookPages.setPostsyncerAccount(created.id, psId);
      byPsId.add(psId);
      byPageId.add(String(pageId));
      pages.push({ ...created, postsyncer_account_id: psId });
      imports.push({ page: pageName, account: pageName, mode: 'imported' });
    }
  }

  return { imported: imports.length, imports };
}

/**
 * Lista contas Facebook do PostSyncer, importa as que faltam e vincula às páginas do app.
 */
async function syncPostsyncerAccounts(userId) {
  postsyncerService.assertConfigured();
  const workspaceId = await postsyncerService.resolveWorkspaceId();
  const all = await postsyncerService.listAccounts(workspaceId);
  const fbAccounts = all.filter(postsyncerService.isFacebookAccount);

  console.log(
    '[postsyncer] accounts',
    JSON.stringify(
      fbAccounts.map((a) => ({
        id: a.id,
        name: a.name,
        username: a.username,
        platform: a.platform,
        external_id: resolveExternalPageId(a),
      }))
    ).slice(0, 2000)
  );

  const fbAcc = await ensureFacebookAccountForUser(userId);
  let pages = await FacebookPages.findByAccount(fbAcc.id);

  // 0) Importa páginas do PostSyncer que ainda não estão no app
  const { imported, imports } = await importMissingPagesFromPostsyncer(fbAcc, fbAccounts, pages);
  if (imported) {
    pages = await FacebookPages.findByAccount(fbAcc.id);
    console.log('[postsyncer] imported pages', JSON.stringify(imports));
  }

  const used = new Set(
    pages.filter((p) => p.postsyncer_account_id).map((p) => Number(p.postsyncer_account_id))
  );

  let linked = 0;
  const links = [...(imports || [])];

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
  const pagesNow = await FacebookPages.findByAccount(fbAcc.id);
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

  const pagesAfter = await FacebookPages.findByAccount(fbAcc.id);
  const needsLink = pagesAfter.filter((p) => !p.postsyncer_account_id);
  const unboundPs = fbAccounts.filter(
    (a) => !pagesAfter.some((p) => Number(p.postsyncer_account_id) === Number(a.id))
  );

  return {
    workspaceId,
    accounts: fbAccounts.map(serializeAccount),
    linked,
    links,
    imported,
    needs_manual: needsLink.length > 0 || unboundPs.length > 0,
    pages: pagesAfter.map((p) => ({
      id: p.id,
      page_name: p.page_name,
      page_id: p.page_id,
      postsyncer_account_id: p.postsyncer_account_id || null,
    })),
    hint:
      needsLink.length > 0
        ? 'Selecione abaixo a Página do app e a conta PostSyncer correspondente e clique em Vincular.'
        : imported
          ? `Importamos ${imported} página(s) do PostSyncer. Elas já aparecem na lista para publicar.`
          : null,
  };
}

async function linkPageToPostsyncer(userId, facebookPageId, postsyncerAccountId) {
  postsyncerService.assertConfigured();
  const fbAcc = await ensureFacebookAccountForUser(userId);

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
  importMissingPagesFromPostsyncer,
  ensureFacebookAccountForUser,
  isPostsyncerStubAccount,
};
