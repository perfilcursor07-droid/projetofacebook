const postsyncerService = require('../services/postsyncerService');
const { syncPostsyncerAccounts, linkPageToPostsyncer } = require('../services/postsyncerSync');
const { env } = require('../config/env');

async function statusHandler(req, res, next) {
  try {
    const configured = postsyncerService.isConfigured();
    if (!configured) {
      return res.json({
        configured: false,
        workspace_id: null,
        accounts: [],
        redirect_hint: 'Conecte a Página do Facebook no painel app.postsyncer.com e depois sincronize aqui.',
      });
    }

    const workspaceId = await postsyncerService.resolveWorkspaceId();
    const accounts = (await postsyncerService.listAccounts(workspaceId)).filter(
      postsyncerService.isFacebookAccount
    );

    return res.json({
      configured: true,
      workspace_id: workspaceId,
      publish_provider: env.postpulse.publishProvider,
      accounts: accounts.map((a) => ({
        id: a.id,
        name: a.name,
        username: a.username,
        platform: a.platform,
        avatar: a.avatar,
      })),
    });
  } catch (err) {
    if (!err.status) err.message = postsyncerService.apiErrorMessage(err);
    return next(err);
  }
}

async function syncHandler(req, res, next) {
  try {
    const result = await syncPostsyncerAccounts(req.session.userId);
    res.json({ ok: true, ...result });
  } catch (err) {
    if (!err.status) err.message = postsyncerService.apiErrorMessage(err);
    return next(err);
  }
}

async function linkHandler(req, res, next) {
  try {
    const facebookPageId = Number(req.body.facebook_page_id);
    const postsyncerAccountId = Number(req.body.postsyncer_account_id);
    if (!facebookPageId || !postsyncerAccountId) {
      const err = new Error('Informe facebook_page_id e postsyncer_account_id');
      err.status = 400;
      throw err;
    }
    const result = await linkPageToPostsyncer(
      req.session.userId,
      facebookPageId,
      postsyncerAccountId
    );
    res.json({ ok: true, ...result });
  } catch (err) {
    if (!err.status) err.message = postsyncerService.apiErrorMessage(err);
    return next(err);
  }
}

module.exports = {
  statusHandler,
  syncHandler,
  linkHandler,
};
