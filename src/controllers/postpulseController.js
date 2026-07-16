const crypto = require('crypto');
const postpulseService = require('../services/postpulseService');
const PostpulseConnections = require('../models/PostpulseConnections');
const FacebookAccounts = require('../models/FacebookAccounts');
const FacebookPages = require('../models/FacebookPages');
const { syncPostpulseAccounts, linkPageToPostpulse } = require('../services/postpulseSync');
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
      autoLinked: Boolean(result.autoLinked),
      hint: result.hint || null,
      accounts: result.accounts || [],
      pages: result.pages || [],
    });
  } catch (err) {
    err.message = postpulseService.apiErrorMessage(err);
    next(err);
  }
}

async function linkHandler(req, res, next) {
  try {
    postpulseService.assertConfigured();
    const facebookPageId = Number(req.body.facebook_page_id);
    const postpulseAccountId = Number(req.body.postpulse_account_id);
    if (!facebookPageId || !postpulseAccountId) {
      const err = new Error('Informe facebook_page_id e postpulse_account_id');
      err.status = 400;
      throw err;
    }
    const result = await linkPageToPostpulse(
      req.session.userId,
      facebookPageId,
      postpulseAccountId
    );
    res.json({ ok: true, ...result });
  } catch (err) {
    if (!err.status) err.message = postpulseService.apiErrorMessage(err);
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
  linkHandler,
  statusHandler,
  disconnectHandler,
};
