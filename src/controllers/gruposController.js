const FacebookGroups = require('../models/FacebookGroups');
const gruposService = require('../services/gruposService');
const ayrshareService = require('../services/ayrshareService');

function limpar(valor, max) {
  return String(valor ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function serializar(g) {
  return {
    id: g.id,
    nome: g.nome,
    nicho: g.nicho || null,
    url: g.url || null,
    grupo_fb_id: g.grupo_fb_id || null,
    tem_profile_key: Boolean(g.ayrshare_profile_key),
    ativo: Boolean(g.ativo),
    padrao: Boolean(g.padrao),
    observacoes: g.observacoes || null,
    ultimo_post_em: g.ultimo_post_em || null,
    ultimo_erro: g.ultimo_erro || null,
  };
}

/** Extrai o ID numérico de um link de grupo, se houver. */
function extrairGrupoId(url) {
  const m = String(url || '').match(/facebook\.com\/groups\/(?:[^/]*\/)?(\d{5,})/i);
  return m ? m[1] : null;
}

async function listPage(req, res, next) {
  try {
    const grupos = await FacebookGroups.findByUser(req.session.userId);
    return res.render('grupos', {
      title: 'Grupos',
      grupos: grupos.map(serializar),
      ayrshareConfigured: ayrshareService.isConfigured(),
    });
  } catch (err) {
    return next(err);
  }
}

async function listar(req, res, next) {
  try {
    const grupos = await FacebookGroups.findByUser(req.session.userId);
    return res.json({ ok: true, grupos: grupos.map(serializar) });
  } catch (err) {
    return next(err);
  }
}

async function criar(req, res, next) {
  try {
    const body = req.body || {};
    const nome = limpar(body.nome, 200);
    if (nome.length < 2) return res.status(400).json({ error: 'Informe o nome do grupo.' });

    const url = limpar(body.url, 500);
    const [id] = await FacebookGroups.create({
      user_id: req.session.userId,
      nome,
      nicho: limpar(body.nicho, 120) || null,
      url: url || null,
      grupo_fb_id: extrairGrupoId(url),
      ayrshare_profile_key: limpar(body.ayrshareProfileKey || body.ayrshare_profile_key, 200) || null,
      ativo: body.ativo === false ? false : true,
      padrao: Boolean(body.padrao),
      observacoes: limpar(body.observacoes, 1000) || null,
    });

    const grupo = await FacebookGroups.findById(id);
    return res.status(201).json({ ok: true, grupo: serializar(grupo) });
  } catch (err) {
    return next(err);
  }
}

async function atualizar(req, res, next) {
  try {
    const id = Number(req.params.id);
    const grupo = await FacebookGroups.findById(id);
    if (!grupo || Number(grupo.user_id) !== Number(req.session.userId)) {
      return res.status(404).json({ error: 'Grupo não encontrado.' });
    }

    const body = req.body || {};
    const patch = {};
    if (body.nome != null) patch.nome = limpar(body.nome, 200);
    if (body.nicho != null) patch.nicho = limpar(body.nicho, 120) || null;
    if (body.url != null) {
      patch.url = limpar(body.url, 500) || null;
      patch.grupo_fb_id = extrairGrupoId(patch.url);
    }
    if (body.ayrshareProfileKey != null || body.ayrshare_profile_key != null) {
      patch.ayrshare_profile_key = limpar(body.ayrshareProfileKey ?? body.ayrshare_profile_key, 200) || null;
    }
    if (body.ativo != null) patch.ativo = Boolean(body.ativo);
    if (body.padrao != null) patch.padrao = Boolean(body.padrao);
    if (body.observacoes != null) patch.observacoes = limpar(body.observacoes, 1000) || null;

    if (patch.nome != null && patch.nome.length < 2) {
      return res.status(400).json({ error: 'Informe o nome do grupo.' });
    }

    await FacebookGroups.update(id, req.session.userId, patch);
    const atualizado = await FacebookGroups.findById(id);
    return res.json({ ok: true, grupo: serializar(atualizado) });
  } catch (err) {
    return next(err);
  }
}

async function remover(req, res, next) {
  try {
    const n = await FacebookGroups.deleteByUser(Number(req.params.id), req.session.userId);
    if (!n) return res.status(404).json({ error: 'Grupo não encontrado.' });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
}

/** Publica um texto/imagem nos grupos selecionados. */
async function publicar(req, res, next) {
  try {
    const body = req.body || {};
    const texto = String(body.texto || body.mensagem || '').trim();
    const imagemUrl = body.imagemUrl || body.imagem_url || null;
    const grupoIds = Array.isArray(body.grupoIds || body.grupo_ids)
      ? body.grupoIds || body.grupo_ids
      : [];

    const resultado = await gruposService.publicarNosGrupos(req.session.userId, {
      texto,
      imagemUrl,
      grupoIds,
    });
    return res.json({ ok: true, ...resultado });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

module.exports = { listPage, listar, criar, atualizar, remover, publicar };
