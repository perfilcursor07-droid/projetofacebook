const crypto = require('crypto');
const facebookService = require('../services/facebookService');
const FacebookAccounts = require('../models/FacebookAccounts');
const FacebookPages = require('../models/FacebookPages');
const db = require('../config/db');

/** Redireciona para o diálogo de login do Facebook. */
function facebookLogin(req, res, next) {
  try {
    const state = crypto.randomBytes(16).toString('hex');
    req.session.fbState = state;
    // Garante que o state foi gravado ANTES do redirect (proxy HTTPS)
    req.session.save((err) => {
      if (err) return next(err);
      res.redirect(facebookService.loginUrl(state));
    });
  } catch (err) {
    next(err);
  }
}

/** Callback do OAuth: troca code por token, salva conta e páginas. */
async function facebookCallback(req, res, next) {
  try {
    const { code, state, error_description: errorDescription } = req.query;

    if (errorDescription) {
      return res.redirect('/paginas?erro=' + encodeURIComponent(errorDescription));
    }
    if (!code || !state || state !== req.session.fbState) {
      return res.redirect('/paginas?erro=' + encodeURIComponent('Estado OAuth inválido, tente novamente'));
    }
    delete req.session.fbState;

    const short = await facebookService.exchangeCodeForToken(code);
    let accessToken = short.access_token;
    let expiresIn = short.expires_in || 3600;

    try {
      const long = await facebookService.getLongLivedToken(accessToken);
      accessToken = long.access_token;
      expiresIn = long.expires_in || 60 * 24 * 60 * 60;
    } catch {
      // segue com o token curto se a troca falhar
    }

    const me = await facebookService.getMe(accessToken);

    await FacebookAccounts.upsert({
      user_id: req.session.userId,
      fb_user_id: me.id,
      access_token: accessToken,
      expires_at: new Date(Date.now() + expiresIn * 1000),
    });

    const account = await db('facebook_accounts')
      .where({ user_id: req.session.userId, fb_user_id: me.id })
      .first();

    const pages = await facebookService.getPages(accessToken);
    if (pages.length) {
      await FacebookPages.upsertMany(
        pages.map((p) => ({
          facebook_account_id: account.id,
          page_id: p.id,
          page_name: p.name,
          page_access_token: p.access_token,
        }))
      );
    }

    res.redirect('/paginas?conectado=1');
  } catch (err) {
    console.error('Facebook callback:', facebookService.graphErrorMessage(err));
    res.redirect('/paginas?erro=' + encodeURIComponent(facebookService.graphErrorMessage(err)));
  }
}

/** Lista páginas conectadas (do banco); ?refresh=1 rebusca na Graph API. */
async function listPages(req, res, next) {
  try {
    const account = await FacebookAccounts.findByUser(req.session.userId);
    if (!account) {
      return res.json({ conectado: false, pages: [] });
    }

    if (req.query.refresh === '1') {
      const pages = await facebookService.getPages(account.access_token);
      if (pages.length) {
        await FacebookPages.upsertMany(
          pages.map((p) => ({
            facebook_account_id: account.id,
            page_id: p.id,
            page_name: p.name,
            page_access_token: p.access_token,
          }))
        );
      }
    }

    const pages = await FacebookPages.findByAccount(account.id);
    res.json({
      conectado: true,
      fb_user_id: account.fb_user_id,
      expira_em: account.expires_at,
      pages: pages.map((p) => ({ id: p.id, page_id: p.page_id, page_name: p.page_name })),
    });
  } catch (err) {
    err.message = facebookService.graphErrorMessage(err);
    next(err);
  }
}

module.exports = { facebookLogin, facebookCallback, listPages };
