const FacebookPages = require('../models/FacebookPages');
const ayrshareService = require('../services/ayrshareService');
const { resolvePageForUser, pagesForUser } = require('../services/facebookPageResolver');

async function setProfileKey(req, res, next) {
  try {
    ayrshareService.assertConfigured();
    const pageId = Number(req.body?.facebook_page_id || req.body?.facebookPageId || 0);
    const profileKey = String(
      req.body?.ayrshare_profile_key ?? req.body?.profile_key ?? ''
    ).trim();
    if (!pageId) {
      const err = new Error('Informe facebook_page_id');
      err.status = 400;
      throw err;
    }

    const page = await resolvePageForUser(req.session.userId, pageId);
    if (!page) {
      const err = new Error('Página não encontrada na sua conta');
      err.status = 404;
      throw err;
    }

    // Remoção explícita da chave: permitida, mas avisa quando há várias páginas.
    if (!profileKey) {
      await FacebookPages.setAyrshareProfileKey(page.id, null);
      const paginas = await pagesForUser(req.session.userId);
      return res.json({
        ok: true,
        page: {
          id: page.id,
          page_name: page.page_name,
          ayrshare_profile_key: null,
          has_profile_key: false,
        },
        aviso:
          paginas.length > 1
            ? 'Profile Key removido. Com mais de uma Página, esta não poderá publicar até receber o Profile Key.'
            : 'Profile Key removido — usará o Primary Profile.',
      });
    }

    // O painel "Manage Profiles" mostra o RefId, que não funciona como Profile Key.
    if (ayrshareService.looksLikeRefId(profileKey)) {
      const err = new Error(
        'Esse valor é o RefId do profile, não o Profile Key. O RefId aparece em Manage Profiles, ' +
          'mas o Profile Key é entregue quando o User Profile é criado (ou pode ser gerado de novo na Ayrshare). ' +
          'Cole o Profile Key para o post ir na Página certa.'
      );
      err.status = 400;
      err.code = 'AYRSHARE_REFID_INSTEAD_OF_KEY';
      throw err;
    }

    // Duas páginas com a mesma chave publicariam sempre no mesmo lugar.
    const paginas = await pagesForUser(req.session.userId);
    const conflito = paginas.find(
      (p) =>
        Number(p.id) !== Number(page.id) &&
        String(p.ayrshare_profile_key || '').trim() === profileKey
    );
    if (conflito) {
      const err = new Error(
        `Este Profile Key já está na Página “${conflito.page_name}”. ` +
          'Cada Página precisa do Profile Key do seu próprio User Profile.'
      );
      err.status = 409;
      err.code = 'AYRSHARE_PROFILE_KEY_DUPLICATED';
      throw err;
    }

    // Valida a chave na Ayrshare antes de salvar e informa qual Página está conectada.
    let detalhes = null;
    try {
      detalhes = await ayrshareService.fetchProfileByKey(profileKey);
    } catch (validationErr) {
      const err = new Error(
        `A Ayrshare recusou este Profile Key: ${ayrshareService.apiErrorMessage(validationErr)}`
      );
      err.status = 400;
      err.code = 'AYRSHARE_PROFILE_KEY_REJECTED';
      throw err;
    }

    await FacebookPages.setAyrshareProfileKey(page.id, profileKey);
    const updated = await FacebookPages.findById(page.id);

    const avisos = [];
    if (!detalhes.facebookConnected) {
      avisos.push(
        'Este profile ainda não tem Página do Facebook conectada. Vincule em Social Accounts na Ayrshare.'
      );
    }
    if (detalhes.facebookPageName) {
      avisos.push(`Profile conectado à Página do Facebook: ${detalhes.facebookPageName}.`);
    }

    res.json({
      ok: true,
      page: {
        id: updated.id,
        page_name: updated.page_name,
        ayrshare_profile_key: updated.ayrshare_profile_key || null,
        has_profile_key: Boolean(updated.ayrshare_profile_key),
      },
      profile: {
        title: detalhes.title,
        ref_id: detalhes.refId,
        facebook_connected: detalhes.facebookConnected,
        facebook_page_name: detalhes.facebookPageName,
        active_social_accounts: detalhes.activeSocialAccounts,
      },
      aviso: avisos.join(' ') || null,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Liga/desliga a publicação no Instagram de uma Página.
 *
 * A conta do Instagram já vem conectada no User Profile da Ayrshare: aqui só
 * confirmamos que ela existe (activeSocialAccounts) e guardamos a escolha, para
 * a tela da matéria poder oferecer o botão "publicar também no Instagram".
 */
async function setInstagram(req, res, next) {
  try {
    ayrshareService.assertConfigured();
    const pageId = Number(req.body?.facebook_page_id || req.body?.facebookPageId || 0);
    if (!pageId) {
      const err = new Error('Informe facebook_page_id');
      err.status = 400;
      throw err;
    }

    const page = await resolvePageForUser(req.session.userId, pageId);
    if (!page) {
      const err = new Error('Página não encontrada na sua conta');
      err.status = 404;
      throw err;
    }

    const bruto = req.body?.ativo ?? req.body?.instagram_ativo ?? true;
    const ativo = bruto === true || bruto === 1 || bruto === '1' || bruto === 'true';

    if (!ativo) {
      await FacebookPages.setInstagram(page.id, { ativo: false });
      return res.json({
        ok: true,
        page: { id: page.id, page_name: page.page_name, instagram_ativo: false },
        aviso: 'Instagram desligado para esta Página.',
      });
    }

    // Sem Profile Key, a Ayrshare usa o Primary Profile — o Instagram ativado
    // aqui poderia ser o de outra Página.
    const profileKey = String(page.ayrshare_profile_key || '').trim();
    let detalhes = null;
    try {
      detalhes = await ayrshareService.fetchProfileByKey(profileKey || null, {
        permitirPrimary: true,
      });
    } catch (validationErr) {
      const err = new Error(
        profileKey
          ? `A Ayrshare recusou o Profile Key desta Página: ${ayrshareService.apiErrorMessage(validationErr)}`
          : 'Cole primeiro o Profile Key desta Página para verificar o Instagram conectado.'
      );
      err.status = 400;
      throw err;
    }

    if (!detalhes.instagramConnected) {
      const err = new Error(
        'Este profile da Ayrshare não tem Instagram conectado. ' +
          'Vincule a conta em app.ayrshare.com → Social Accounts e tente de novo.'
      );
      err.status = 422;
      err.code = 'AYRSHARE_INSTAGRAM_NOT_CONNECTED';
      throw err;
    }

    await FacebookPages.setInstagram(page.id, {
      ativo: true,
      username: detalhes.instagramUsername,
    });

    return res.json({
      ok: true,
      page: {
        id: page.id,
        page_name: page.page_name,
        instagram_ativo: true,
        instagram_username: detalhes.instagramUsername || null,
      },
      profile: {
        instagram_connected: true,
        instagram_username: detalhes.instagramUsername || null,
        active_social_accounts: detalhes.activeSocialAccounts,
      },
      aviso: detalhes.instagramUsername
        ? `Instagram @${detalhes.instagramUsername} ligado a esta Página.`
        : 'Instagram ligado a esta Página.',
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Liga/desliga a publicação no X.com de uma Página.
 * A conexão acontece na Ayrshare; aqui vinculamos a escolha ao User Profile
 * correto, como já é feito com Instagram.
 */
async function setX(req, res, next) {
  try {
    ayrshareService.assertConfigured();
    const pageId = Number(req.body?.facebook_page_id || req.body?.facebookPageId || 0);
    if (!pageId) {
      const err = new Error('Informe facebook_page_id');
      err.status = 400;
      throw err;
    }

    const page = await resolvePageForUser(req.session.userId, pageId);
    if (!page) {
      const err = new Error('Página não encontrada na sua conta');
      err.status = 404;
      throw err;
    }

    const bruto = req.body?.ativo ?? req.body?.x_ativo ?? true;
    const ativo = bruto === true || bruto === 1 || bruto === '1' || bruto === 'true';
    if (!ativo) {
      await FacebookPages.setX(page.id, { ativo: false });
      return res.json({
        ok: true,
        page: { id: page.id, page_name: page.page_name, x_ativo: false },
        aviso: 'X.com desligado para esta Página.',
      });
    }

    if (!ayrshareService.isTwitterByoConfigured()) {
      const err = new Error(
        'Para ativar o X.com, configure AYRSHARE_X_API_KEY e AYRSHARE_X_API_SECRET no .env e reinicie o app.'
      );
      err.status = 422;
      throw err;
    }

    const profileKey = String(page.ayrshare_profile_key || '').trim();
    let detalhes = null;
    try {
      detalhes = await ayrshareService.fetchProfileByKey(profileKey || null, {
        permitirPrimary: true,
      });
    } catch (validationErr) {
      const err = new Error(
        profileKey
          ? `A Ayrshare recusou o Profile Key desta Página: ${ayrshareService.apiErrorMessage(validationErr)}`
          : 'Cole primeiro o Profile Key desta Página para verificar o X.com conectado.'
      );
      err.status = 400;
      throw err;
    }

    if (!detalhes.xConnected) {
      const err = new Error(
        'Este profile da Ayrshare não tem uma conta X.com conectada. ' +
          'Vincule a conta em app.ayrshare.com → Social Accounts e tente de novo.'
      );
      err.status = 422;
      err.code = 'AYRSHARE_X_NOT_CONNECTED';
      throw err;
    }

    await FacebookPages.setX(page.id, { ativo: true, username: detalhes.xUsername });
    return res.json({
      ok: true,
      page: {
        id: page.id,
        page_name: page.page_name,
        x_ativo: true,
        x_username: detalhes.xUsername || null,
      },
      profile: {
        x_connected: true,
        x_username: detalhes.xUsername || null,
        active_social_accounts: detalhes.activeSocialAccounts,
      },
      aviso: detalhes.xUsername
        ? `X.com @${String(detalhes.xUsername).replace(/^@/, '')} ligado a esta Página.`
        : 'X.com ligado a esta Página.',
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { setProfileKey, setInstagram, setX };
