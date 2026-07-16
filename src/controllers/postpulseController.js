const crypto = require('crypto');
const postpulseService = require('../services/postpulseService');
const PostpulseConnections = require('../models/PostpulseConnections');
const FacebookAccounts = require('../models/FacebookAccounts');
const FacebookPages = require('../models/FacebookPages');
const { syncPostpulseAccounts } = require('../services/postpulseSync');
const { env } = require('../config/env');

function postpulseLogin(req, res, next) {
  try {
    postpulseService.assertConfigured();
    const state = crypto.randomBytes(16).toString('hex');
    req.session.ppState = state;
    req.session.save((err) => {
      if (err) return next(err);
      res.redirect(postpulseService.loginUrl(state));
    });
  } catch (err) {
    next(err);
  }
}

async function postpulseCallback(req, res, next) {
  try {
    const { code, state, error, error_description: errorDescription } = req.query;

    if (error || errorDescription) {
      return res.redirect(
        '/paginas?erro=' + encodeURIComponent(errorDescription || error || 'OAuth PostPulse negado')
      );
    }
    if (!code || !state || state !== req.session.ppState) {
      return res.redirect(
        '/paginas?erro=' + encodeURIComponent('Estado OAuth PostPulse inválido, tente novamente')
      );
    }
    delete req.session.ppState;

    const token = await postpulseService.exchangeCodeForToken(code);
    const expiresAt = token.expires_in
      ? new Date(Date.now() + Number(token.expires_in) * 1000)
      : null;

    await PostpulseConnections.upsert({
      user_id: req.session.userId,
      access_token: token.access_token,
      refresh_token: token.refresh_token || null,
      expires_at: expiresAt,
    });

    await syncPostpulseAccounts(req.session.userId);

    res.redirect('/paginas?postpulse=1');
  } catch (err) {
    console.error('PostPulse callback:', postpulseService.apiErrorMessage(err));
    res.redirect('/paginas?erro=' + encodeURIComponent(postpulseService.apiErrorMessage(err)));
  }
}

async function syncHandler(req, res, next) {
  try {
    postpulseService.assertConfigured();
    const result = await syncPostpulseAccounts(req.session.userId);
    res.json({
      ok: true,
      matched: result.matched,
      accounts: (result.accounts || []).map((a) => ({
        id: a.id,
        platform: a.platform,
        accountId: a.accountId,
        accountDisplayName: a.accountDisplayName || a.accountUsername,
      })),
    });
  } catch (err) {
    err.message = postpulseService.apiErrorMessage(err);
    next(err);
  }
}

async function statusHandler(req, res, next) {
  try {
    const configured = postpulseService.isConfigured();
    const conn = configured ? await PostpulseConnections.findByUser(req.session.userId) : null;
    res.json({
      configured,
      connected: Boolean(conn?.access_token),
      expires_at: conn?.expires_at || null,
      redirect_uri: configured ? env.postpulse.redirectUri : null,
    });
  } catch (err) {
    next(err);
  }
}

async function disconnectHandler(req, res, next) {
  try {
    await PostpulseConnections.deleteByUser(req.session.userId);
    const account = await FacebookAccounts.findByUser(req.session.userId);
    if (account) {
      const pages = await FacebookPages.findByAccount(account.id);
      for (const page of pages) {
        await FacebookPages.setPostpulseAccount(page.id, null);
      }
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  postpulseLogin,
  postpulseCallback,
  syncHandler,
  statusHandler,
  disconnectHandler,
};
