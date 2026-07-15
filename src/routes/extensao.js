const path = require('path');
const fs = require('fs');
const express = require('express');
const { ZipArchive } = require('archiver');
const db = require('../config/db');
const { requireAuth } = require('../middleware/requireAuth');
const { requireApiToken } = require('../middleware/requireApiToken');
const ApiTokens = require('../models/ApiTokens');
const AiMatters = require('../models/AiMatters');
const Publications = require('../models/Publications');

const router = express.Router();

const EXTENSAO_DIR = path.join(__dirname, '../../extensao-facebook');
const ZIP_NAME = 'viralizeai-extensao-facebook.zip';

/** Download do ZIP da extensão (sessão). Usuário descompacta e carrega no Chrome/Edge. */
function downloadExtensaoZip(req, res, next) {
  try {
    if (!fs.existsSync(EXTENSAO_DIR)) {
      return res.status(404).json({ error: 'Pasta da extensão não encontrada no servidor' });
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${ZIP_NAME}"`);

    const archive = new ZipArchive({ zlib: { level: 9 } });
    archive.on('error', (err) => {
      if (!res.headersSent) return next(err);
      res.end();
    });
    archive.pipe(res);

    // Pasta raiz no ZIP: viralizeai-extensao-facebook/ (fácil de achar após extrair)
    archive.directory(EXTENSAO_DIR, 'viralizeai-extensao-facebook');
    archive.finalize();
  } catch (err) {
    return next(err);
  }
}

router.get('/baixar', requireAuth, downloadExtensaoZip);

/* ------------------------------------------------------------------ */
/* Gestão de tokens — autenticada por SESSÃO (usada pela tela /extensao) */
/* ------------------------------------------------------------------ */

router.post('/tokens', requireAuth, async (req, res, next) => {
  try {
    const nome = String(req.body?.nome_dispositivo || req.body?.nome || 'Extensão').trim();
    const { token, row } = await ApiTokens.issue(req.session.userId, nome || 'Extensão');
    // O token puro só é exibido uma vez, aqui.
    return res.status(201).json({
      ok: true,
      token,
      dispositivo: {
        id: row.id,
        nome_dispositivo: row.nome_dispositivo,
        criado_em: row.criado_em,
      },
    });
  } catch (err) {
    return next(err);
  }
});

router.get('/tokens', requireAuth, async (req, res, next) => {
  try {
    const tokens = await ApiTokens.listByUser(req.session.userId);
    return res.json({ ok: true, tokens });
  } catch (err) {
    return next(err);
  }
});

router.post('/tokens/:id/revogar', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Token inválido' });
    const changed = await ApiTokens.revoke(id, req.session.userId);
    if (!changed) return res.status(404).json({ error: 'Token não encontrado ou já revogado' });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

/* ------------------------------------------------------------- */
/* Rotas da extensão — autenticadas por TOKEN (Bearer)             */
/* ------------------------------------------------------------- */

/** Heartbeats em memória: matterId -> { tokenId, at }. Evita duplicidade entre navegadores. */
const HEARTBEAT_TTL_MS = 3 * 60 * 1000;
const heartbeats = new Map();

function heartbeatAtivo(matterId, tokenId) {
  const hb = heartbeats.get(Number(matterId));
  if (!hb) return false;
  if (Date.now() - hb.at > HEARTBEAT_TTL_MS) {
    heartbeats.delete(Number(matterId));
    return false;
  }
  return hb.tokenId !== tokenId;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, hb] of heartbeats) {
    if (now - hb.at > HEARTBEAT_TTL_MS) heartbeats.delete(key);
  }
}, 60 * 1000).unref();

function absoluteUrl(req, maybeRelative) {
  const value = String(maybeRelative || '');
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  const base = `${req.protocol}://${req.get('host')}`;
  return value.startsWith('/') ? base + value : `${base}/${value}`;
}

function parseHashtags(raw) {
  try {
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string' && raw.trim()) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return [];
}

router.get('/paginas', requireApiToken, async (req, res, next) => {
  try {
    const rows = await db('facebook_pages')
      .join('facebook_accounts', 'facebook_pages.facebook_account_id', 'facebook_accounts.id')
      .where('facebook_accounts.user_id', req.apiUserId)
      .orderBy('facebook_pages.page_name', 'asc')
      .select('facebook_pages.id', 'facebook_pages.page_id', 'facebook_pages.page_name');
    return res.json({ ok: true, paginas: rows });
  } catch (err) {
    return next(err);
  }
});

router.get('/pendentes', requireApiToken, async (req, res, next) => {
  try {
    const fbPageId = String(req.query.page_id || '').trim();
    // Lista automática: rascunho, pronto, agendado vencido e erro — sem precisar enfileirar no site
    const statuses = String(req.query.status || 'publicaveis');

    let query = db('ai_matters')
      .where('ai_matters.user_id', req.apiUserId)
      .leftJoin('facebook_pages', 'ai_matters.facebook_page_id', 'facebook_pages.id')
      .orderByRaw(
        "FIELD(ai_matters.status, 'pronto', 'agendado', 'erro', 'rascunho'), ai_matters.updated_at DESC"
      )
      .limit(50)
      .select(
        'ai_matters.id',
        'ai_matters.titulo',
        'ai_matters.materia',
        'ai_matters.hashtags',
        'ai_matters.tipo_publicacao',
        'ai_matters.imagem_url',
        'ai_matters.status',
        'ai_matters.scheduled_at',
        'ai_matters.facebook_page_id',
        'facebook_pages.page_id as fb_page_id',
        'facebook_pages.page_name'
      );

    if (statuses === 'fila') {
      query = query.where((builder) => {
        builder
          .where('ai_matters.status', 'pronto')
          .orWhere((sub) => {
            sub.where('ai_matters.status', 'agendado').where('ai_matters.scheduled_at', '<=', db.fn.now());
          });
      });
    } else {
      query = query.where((builder) => {
        builder
          .whereIn('ai_matters.status', ['rascunho', 'pronto', 'erro'])
          .orWhere((sub) => {
            sub.where('ai_matters.status', 'agendado').where('ai_matters.scheduled_at', '<=', db.fn.now());
          });
      });
    }

    if (fbPageId) {
      query = query.andWhere((builder) => {
        builder.where('facebook_pages.page_id', fbPageId).orWhereNull('ai_matters.facebook_page_id');
      });
    }

    const rows = await query;

    const pendentes = rows
      .filter((m) => !heartbeatAtivo(m.id, req.apiToken.id))
      .map((m) => ({
        id: m.id,
        titulo: m.titulo,
        materia: m.materia,
        hashtags: parseHashtags(m.hashtags),
        tipo_publicacao: m.tipo_publicacao === 'foto' ? 'foto' : 'texto',
        imagem_url: absoluteUrl(req, m.imagem_url),
        status: m.status,
        scheduled_at: m.scheduled_at,
        fb_page_id: m.fb_page_id || null,
        page_name: m.page_name || null,
        na_fila: m.status === 'pronto' || m.status === 'agendado',
      }));

    return res.json({ ok: true, pendentes });
  } catch (err) {
    return next(err);
  }
});

router.post('/matters/:id/heartbeat', requireApiToken, async (req, res, next) => {
  try {
    const matterId = Number(req.params.id);
    const matter = await AiMatters.findById(matterId);
    if (!matter || Number(matter.user_id) !== req.apiUserId) {
      return res.status(404).json({ error: 'Matéria não encontrada' });
    }
    if (heartbeatAtivo(matterId, req.apiToken.id)) {
      return res.status(409).json({ error: 'Outra extensão já está publicando esta matéria' });
    }

    const patch = {};
    const graphPageId = String(req.body?.page_id || req.body?.fb_page_id || '').trim();
    if (graphPageId) {
      const page = await db('facebook_pages')
        .join('facebook_accounts', 'facebook_pages.facebook_account_id', 'facebook_accounts.id')
        .where('facebook_accounts.user_id', req.apiUserId)
        .where('facebook_pages.page_id', graphPageId)
        .select('facebook_pages.id')
        .first();
      if (page) patch.facebook_page_id = page.id;
    }
    // Enfileira automaticamente ao publicar pela extensão
    if (['rascunho', 'erro'].includes(matter.status)) {
      patch.status = 'pronto';
      patch.error_message = null;
    }
    if (Object.keys(patch).length) {
      await AiMatters.update(matter.id, patch);
    }

    heartbeats.set(matterId, { tokenId: req.apiToken.id, at: Date.now() });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

router.post('/matters/:id/resultado', requireApiToken, async (req, res, next) => {
  try {
    const matterId = Number(req.params.id);
    const matter = await AiMatters.findById(matterId);
    if (!matter || Number(matter.user_id) !== req.apiUserId) {
      return res.status(404).json({ error: 'Matéria não encontrada' });
    }

    const body = req.body || {};
    const status = String(body.status || '');
    if (!['publicado', 'erro'].includes(status)) {
      return res.status(400).json({ error: "Envie status 'publicado' ou 'erro'" });
    }

    heartbeats.delete(matterId);

    const texto = [matter.titulo, matter.materia].filter(Boolean).join('\n\n');

    if (status === 'erro') {
      const message = String(body.error_message || 'Erro na publicação pela extensão').slice(0, 500);
      if (matter.publication_id) {
        await Publications.update(matter.publication_id, { status: 'erro', erro_mensagem: message });
        await Publications.increment(matter.publication_id);
      }
      await AiMatters.update(matter.id, { status: 'erro', error_message: message });
      return res.json({ ok: true, matterId: matter.id, status: 'erro' });
    }

    const fbPostId = String(body.fb_post_id || '').slice(0, 191) || null;
    const fbPostUrl = String(body.fb_post_url || '').slice(0, 1000) || null;

    let publicationId = matter.publication_id || null;
    if (!publicationId) {
      const [created] = await Publications.create({
        video_clip_id: null,
        imagem_id: null,
        facebook_page_id: matter.facebook_page_id || null,
        tipo: matter.tipo_publicacao === 'foto' ? 'foto' : 'texto',
        status: 'pendente',
        texto,
      });
      publicationId = created;
    }

    await Publications.update(publicationId, {
      status: 'publicado',
      fb_post_id: fbPostId,
      fb_post_url: fbPostUrl,
      published_at: new Date(),
      erro_mensagem: null,
    });

    await AiMatters.update(matter.id, {
      status: 'publicado',
      publication_id: publicationId,
      published_at: new Date(),
      error_message: null,
    });

    return res.json({ ok: true, matterId: matter.id, publicationId, status: 'publicado' });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
module.exports.downloadExtensaoZip = downloadExtensaoZip;
