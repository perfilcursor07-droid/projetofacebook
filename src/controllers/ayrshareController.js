const FacebookPages = require('../models/FacebookPages');
const FacebookAccounts = require('../models/FacebookAccounts');
const ayrshareService = require('../services/ayrshareService');

async function setProfileKey(req, res, next) {
  try {
    ayrshareService.assertConfigured();
    const pageId = Number(req.body?.facebook_page_id || req.body?.facebookPageId || 0);
    const profileKey = req.body?.ayrshare_profile_key ?? req.body?.profile_key ?? '';
    if (!pageId) {
      const err = new Error('Informe facebook_page_id');
      err.status = 400;
      throw err;
    }

    const account = await FacebookAccounts.findByUser(req.session.userId);
    if (!account) {
      const err = new Error(
        'Nenhuma conta/página no app. Conecte o Facebook uma vez ou importe páginas.'
      );
      err.status = 400;
      throw err;
    }

    const page = await FacebookPages.findById(pageId);
    if (!page || Number(page.facebook_account_id) !== Number(account.id)) {
      const err = new Error('Página não encontrada');
      err.status = 404;
      throw err;
    }

    await FacebookPages.setAyrshareProfileKey(pageId, profileKey);
    const updated = await FacebookPages.findById(pageId);
    res.json({
      ok: true,
      page: {
        id: updated.id,
        page_name: updated.page_name,
        ayrshare_profile_key: updated.ayrshare_profile_key || null,
        has_profile_key: Boolean(updated.ayrshare_profile_key),
      },
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { setProfileKey };
