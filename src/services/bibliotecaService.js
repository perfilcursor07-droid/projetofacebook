const BibliotecaFontes = require('../models/BibliotecaFontes');
const BibliotecaPosts = require('../models/BibliotecaPosts');
const BibliotecaAlertas = require('../models/BibliotecaAlertas');
const FacebookPages = require('../models/FacebookPages');
const FacebookAccounts = require('../models/FacebookAccounts');
const Videos = require('../models/Videos');
const importService = require('./importService');
const materiaIaService = require('./materiaIaService');
const { resumirAlertaBiblioteca, assertDeepseek } = require('./deepseekService');
const { env } = require('../config/env');
const axios = require('axios');

function normalizeUrl(raw) {
  const u = String(raw || '').trim();
  if (!/^https?:\/\//i.test(u)) {
    const err = new Error('Informe uma URL válida (http/https)');
    err.status = 400;
    throw err;
  }
  try {
    const parsed = new URL(u);
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    const err = new Error('URL inválida');
    err.status = 400;
    throw err;
  }
}

function detectarPlataforma(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    if (host.includes('youtube.com') || host === 'youtu.be') return 'youtube';
    if (host.includes('facebook.com') || host === 'fb.com' || host === 'fb.watch') return 'facebook';
    if (host.includes('instagram.com')) return 'instagram';
    if (host.includes('tiktok.com')) return 'tiktok';
  } catch {
    /* ignore */
  }
  return 'outro';
}

function extrairHandle(url, plataforma) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    if (plataforma === 'youtube') {
      const at = parts.find((p) => p.startsWith('@'));
      if (at) return at;
      if (parts[0] === 'channel' || parts[0] === 'c' || parts[0] === 'user') return parts[1] || null;
      return parts[0] || null;
    }
    if (plataforma === 'instagram' || plataforma === 'tiktok') {
      return (parts[0] || '').replace(/^@/, '') || null;
    }
    if (plataforma === 'facebook') {
      return parts[0] || null;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function nomePadrao(plataforma, handle, url) {
  if (handle) return handle.startsWith('@') ? handle : `@${handle}`;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return plataforma;
  }
}

async function resolvePage(userId, facebookPageId) {
  if (!facebookPageId) return null;
  const page = await FacebookPages.findById(facebookPageId);
  if (!page) return null;
  const account = await FacebookAccounts.findByUser(userId);
  if (!account || page.facebook_account_id !== account.id) return null;
  return page;
}

function nextRun(intervaloMinutos) {
  const mins = Math.min(Math.max(Number(intervaloMinutos) || 60, 15), 24 * 60);
  return new Date(Date.now() + mins * 60_000);
}

/**
 * Lista itens recentes de um canal/perfil.
 */
async function coletarItensFonte(fonte) {
  const plataforma = fonte.plataforma;
  const url = fonte.url;

  if (plataforma === 'youtube' || plataforma === 'tiktok') {
    return coletarViaYtDlp(url, plataforma);
  }

  if (plataforma === 'instagram' || plataforma === 'facebook') {
    return coletarViaSerper(fonte);
  }

  // fallback genérico
  try {
    const meta = await importService.fetchLinkMetadata(url);
    return [
      {
        externalId: url,
        titulo: meta.titulo || fonte.nome,
        url,
        resumo: null,
        thumbnail: meta.thumbnail || null,
        publicadoEm: null,
      },
    ];
  } catch {
    return [];
  }
}

async function coletarViaYtDlp(profileUrl, plataforma) {
  const fs = require('fs');
  const { execSync } = require('child_process');
  const youtubedlPkg = require('youtube-dl-exec');
  const { runYtDlp } = require('./ytDlpAuth');

  let binary = String(process.env.YTDLP_PATH || '').trim();
  if (!binary || !fs.existsSync(binary)) {
    for (const c of ['/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp']) {
      if (fs.existsSync(c)) {
        binary = c;
        break;
      }
    }
  }
  if (!binary) {
    try {
      binary = execSync('which yt-dlp 2>/dev/null || where yt-dlp 2>nul', { encoding: 'utf8' })
        .trim()
        .split(/\r?\n/)[0];
    } catch {
      binary = null;
    }
  }
  const exec = binary ? youtubedlPkg.create(binary) : youtubedlPkg;
  const run = (u, flags) => runYtDlp(exec, u, flags);

  let target = profileUrl;
  if (plataforma === 'youtube' && !/\/(videos|streams|shorts)/i.test(profileUrl)) {
    if (/youtube\.com\/@/i.test(profileUrl)) {
      target = `${profileUrl.replace(/\/$/, '')}/videos`;
    }
  }

  const data = await run(target, {
    dumpSingleJson: true,
    flatPlaylist: true,
    playlistEnd: 8,
    noWarnings: true,
    skipDownload: true,
  });

  const entries = Array.isArray(data.entries) ? data.entries : data.id ? [data] : [];
  return entries
    .map((e) => {
      const id = e.id || e.url || null;
      const link =
        e.url ||
        e.webpage_url ||
        (plataforma === 'youtube' && id ? `https://www.youtube.com/watch?v=${id}` : null);
      if (!link) return null;
      return {
        externalId: String(id || link),
        titulo: e.title || 'Sem título',
        url: link,
        resumo: e.description ? String(e.description).slice(0, 400) : null,
        thumbnail: e.thumbnail || (Array.isArray(e.thumbnails) ? e.thumbnails.at(-1)?.url : null) || null,
        publicadoEm: e.timestamp
          ? new Date(e.timestamp * 1000)
          : e.upload_date
            ? new Date(
                `${e.upload_date.slice(0, 4)}-${e.upload_date.slice(4, 6)}-${e.upload_date.slice(6, 8)}T12:00:00Z`
              )
            : null,
      };
    })
    .filter(Boolean);
}

async function coletarViaSerper(fonte) {
  if (!env.serperApiKey) return [];
  const handle = fonte.handle || extrairHandle(fonte.url, fonte.plataforma);
  const site =
    fonte.plataforma === 'instagram'
      ? 'instagram.com'
      : fonte.plataforma === 'facebook'
        ? 'facebook.com'
        : null;
  if (!site) return [];

  const q = handle
    ? `site:${site}/${String(handle).replace(/^@/, '')}`
    : `site:${site} ${fonte.nome}`;

  try {
    const { data } = await axios.post(
      'https://google.serper.dev/search',
      { q, num: 8, gl: 'br', hl: 'pt-br' },
      {
        headers: { 'X-API-KEY': env.serperApiKey, 'Content-Type': 'application/json' },
        timeout: 15_000,
      }
    );
    return (data?.organic || []).map((r) => ({
      externalId: r.link,
      titulo: r.title || 'Publicação',
      url: r.link,
      resumo: r.snippet || null,
      thumbnail: null,
      publicadoEm: r.date ? new Date(r.date) : null,
    }));
  } catch (err) {
    console.warn('[biblioteca] serper:', err.message);
    return [];
  }
}

async function criarFonte({
  userId,
  url,
  nome,
  notas,
  monitorar = false,
  intervaloMinutos = 60,
  facebookPageId = null,
}) {
  const normalized = normalizeUrl(url);
  const plataforma = detectarPlataforma(normalized);
  const handle = extrairHandle(normalized, plataforma);
  const displayName = String(nome || nomePadrao(plataforma, handle, normalized)).trim().slice(0, 200);

  if (facebookPageId) {
    const page = await resolvePage(userId, facebookPageId);
    if (!page) {
      const err = new Error('Página do Facebook inválida');
      err.status = 400;
      throw err;
    }
  }

  let avatar = null;
  if (plataforma === 'youtube' || plataforma === 'tiktok') {
    try {
      const meta = await importService.fetchLinkMetadata(normalized);
      avatar = meta.thumbnail || null;
      if (!nome && meta.autor) {
        // keep displayName unless user passed nome
      }
    } catch {
      /* ignore preview */
    }
  }

  try {
    const [id] = await BibliotecaFontes.create({
      user_id: userId,
      plataforma,
      nome: displayName,
      url: normalized.slice(0, 500),
      handle,
      avatar_url: avatar,
      notas: notas ? String(notas).slice(0, 2000) : null,
      monitorar: Boolean(monitorar),
      intervalo_minutos: Math.min(Math.max(Number(intervaloMinutos) || 60, 15), 24 * 60),
      facebook_page_id: facebookPageId || null,
      proxima_execucao: monitorar ? new Date() : null,
    });
    return BibliotecaFontes.findById(id);
  } catch (err) {
    if (String(err.message || '').includes('Duplicate') || err.code === 'ER_DUP_ENTRY') {
      const e = new Error('Esta URL já está na sua biblioteca');
      e.status = 409;
      throw e;
    }
    throw err;
  }
}

async function atualizarFonte(userId, fonteId, patch = {}) {
  const fonte = await BibliotecaFontes.findById(fonteId);
  if (!fonte || Number(fonte.user_id) !== Number(userId)) {
    const err = new Error('Fonte não encontrada');
    err.status = 404;
    throw err;
  }

  const data = {};
  if (patch.nome != null) data.nome = String(patch.nome).trim().slice(0, 200);
  if (patch.notas != null) data.notas = String(patch.notas).slice(0, 2000);
  if (patch.monitorar != null) {
    data.monitorar = Boolean(patch.monitorar);
    if (data.monitorar && !fonte.monitorar) data.proxima_execucao = new Date();
  }
  if (patch.intervaloMinutos != null || patch.intervalo_minutos != null) {
    data.intervalo_minutos = Math.min(
      Math.max(Number(patch.intervaloMinutos ?? patch.intervalo_minutos) || 60, 15),
      24 * 60
    );
  }
  if (patch.facebookPageId != null || patch.facebook_page_id != null) {
    const pageId = patch.facebookPageId ?? patch.facebook_page_id;
    if (pageId) {
      const page = await resolvePage(userId, pageId);
      if (!page) {
        const err = new Error('Página do Facebook inválida');
        err.status = 400;
        throw err;
      }
      data.facebook_page_id = pageId;
    } else {
      data.facebook_page_id = null;
    }
  }

  await BibliotecaFontes.update(fonteId, data);
  return BibliotecaFontes.findById(fonteId);
}

async function registrarItensNovos(fonte, itens, { gerarResumoIa = true } = {}) {
  const novos = [];
  for (const item of itens) {
    const externalId = String(item.externalId || item.url).slice(0, 300);
    const exists = await BibliotecaPosts.findByExternal(fonte.id, externalId);
    if (exists) continue;

    // também evita URL duplicada sem external_id estável
    const byUrl = await BibliotecaPosts.findByFonte(fonte.id, 50);
    if (byUrl.some((p) => p.url === item.url)) continue;

    const [postId] = await BibliotecaPosts.create({
      fonte_id: fonte.id,
      user_id: fonte.user_id,
      external_id: externalId,
      titulo: String(item.titulo || 'Sem título').slice(0, 500),
      url: item.url,
      resumo: item.resumo ? String(item.resumo).slice(0, 2000) : null,
      thumbnail: item.thumbnail || null,
      publicado_em: item.publicadoEm || null,
      status: 'novo',
    });

    let alertaTitulo = `${fonte.nome}: ${item.titulo || 'novo conteúdo'}`.slice(0, 300);
    let alertaResumo = item.resumo || `Novo conteúdo em ${fonte.plataforma}: ${item.url}`;

    if (gerarResumoIa && env.deepseekApiKey) {
      try {
        const ia = await resumirAlertaBiblioteca({
          plataforma: fonte.plataforma,
          nomeFonte: fonte.nome,
          titulo: item.titulo,
          url: item.url,
          snippet: item.resumo,
        });
        alertaTitulo = ia.titulo.slice(0, 300);
        alertaResumo = ia.resumo || alertaResumo;
        await BibliotecaPosts.update(postId, { resumo: alertaResumo });
      } catch (err) {
        console.warn('[biblioteca] resumo IA:', err.message);
      }
    }

    await BibliotecaAlertas.create({
      user_id: fonte.user_id,
      fonte_id: fonte.id,
      post_id: postId,
      titulo: alertaTitulo,
      resumo: alertaResumo,
      lido: false,
    });

    novos.push(await BibliotecaPosts.findById(postId));
  }
  return novos;
}

async function escanearFonte(fonte, { silentFirst = false } = {}) {
  const itens = await coletarItensFonte(fonte);
  const jaTemPosts = (await BibliotecaPosts.findByFonte(fonte.id, 1)).length > 0;

  // primeira varredura: registra baseline sem flood de alertas
  if (!jaTemPosts && silentFirst) {
    for (const item of itens.slice(0, 5)) {
      const externalId = String(item.externalId || item.url).slice(0, 300);
      const exists = await BibliotecaPosts.findByExternal(fonte.id, externalId);
      if (exists) continue;
      await BibliotecaPosts.create({
        fonte_id: fonte.id,
        user_id: fonte.user_id,
        external_id: externalId,
        titulo: String(item.titulo || 'Sem título').slice(0, 500),
        url: item.url,
        resumo: item.resumo ? String(item.resumo).slice(0, 2000) : null,
        thumbnail: item.thumbnail || null,
        publicado_em: item.publicadoEm || null,
        status: 'visto',
      });
    }
    await BibliotecaFontes.update(fonte.id, {
      ultimo_scan: new Date(),
      proxima_execucao: nextRun(fonte.intervalo_minutos),
      ultimo_erro: null,
      ultimo_external_id: itens[0] ? String(itens[0].externalId || itens[0].url).slice(0, 300) : fonte.ultimo_external_id,
      total_detectados: Number(fonte.total_detectados || 0) + Math.min(itens.length, 5),
    });
    return { novos: [], itens: itens.length };
  }

  const novos = await registrarItensNovos(fonte, itens, { gerarResumoIa: true });
  await BibliotecaFontes.update(fonte.id, {
    ultimo_scan: new Date(),
    proxima_execucao: nextRun(fonte.intervalo_minutos),
    ultimo_erro: null,
    ultimo_external_id: itens[0] ? String(itens[0].externalId || itens[0].url).slice(0, 300) : fonte.ultimo_external_id,
    total_detectados: Number(fonte.total_detectados || 0) + novos.length,
  });
  return { novos, itens: itens.length };
}

async function escanearAgora(userId, fonteId) {
  const fonte = await BibliotecaFontes.findById(fonteId);
  if (!fonte || Number(fonte.user_id) !== Number(userId)) {
    const err = new Error('Fonte não encontrada');
    err.status = 404;
    throw err;
  }
  try {
    return await escanearFonte(fonte, { silentFirst: true });
  } catch (err) {
    await BibliotecaFontes.update(fonte.id, {
      ultimo_erro: String(err.message || err).slice(0, 1000),
      proxima_execucao: nextRun(fonte.intervalo_minutos),
      ultimo_scan: new Date(),
    });
    throw err;
  }
}

/**
 * Gera matéria texto (ai_matters) a partir de um post da biblioteca.
 */
async function gerarTextoDePost({ userId, postId, facebookPageId, tipoPublicacao = 'texto' }) {
  assertDeepseek();
  const post = await BibliotecaPosts.findById(postId);
  if (!post || Number(post.user_id) !== Number(userId)) {
    const err = new Error('Post não encontrado');
    err.status = 404;
    throw err;
  }
  const fonte = await BibliotecaFontes.findById(post.fonte_id);
  const pageId = facebookPageId || fonte?.facebook_page_id;
  if (pageId) {
    const page = await resolvePage(userId, pageId);
    if (!page) {
      const err = new Error('Página do Facebook inválida');
      err.status = 400;
      throw err;
    }
  }

  const topico = {
    titulo: post.titulo,
    link: post.url,
    resumo: post.resumo,
    nicho: fonte?.nome || fonte?.plataforma || 'rede social',
    fonte: fonte?.nome,
    veiculo: fonte?.plataforma,
    imagemFonte: post.thumbnail,
    redeSocial: true,
    tipoFonte: 'rede_social',
  };

  const gerado = await materiaIaService.gerarCompleto({
    userId,
    facebookPageId: pageId || null,
    topico,
    tipoPublicacao,
    status: 'rascunho',
  });

  await BibliotecaPosts.update(post.id, {
    status: 'gerado_texto',
    matter_id: gerado.matter?.id || null,
  });

  return gerado;
}

/**
 * Enfileira importação de vídeo do post (YouTube/TikTok) na Fila.
 */
async function gerarVideoDePost({ userId, postId }) {
  const post = await BibliotecaPosts.findById(postId);
  if (!post || Number(post.user_id) !== Number(userId)) {
    const err = new Error('Post não encontrado');
    err.status = 404;
    throw err;
  }

  const fonte = await BibliotecaFontes.findById(post.fonte_id);
  if (fonte && !['youtube', 'tiktok'].includes(fonte.plataforma)) {
    const err = new Error('Importação de vídeo automática só para YouTube e TikTok. Use upload manual para Instagram/Facebook.');
    err.status = 422;
    throw err;
  }

  const existing = await Videos.findByUrl(userId, post.url);
  if (existing) {
    await BibliotecaPosts.update(post.id, { status: 'gerado_video', video_id: existing.id });
    return { video: existing, created: false, queued: existing.status === 'pendente' };
  }

  let meta = {};
  try {
    meta = await importService.fetchLinkMetadata(post.url);
  } catch {
    meta = { titulo: post.titulo, thumbnail: post.thumbnail };
  }

  const [id] = await Videos.create({
    user_id: userId,
    origem: 'link',
    termo_busca: `biblioteca:${fonte?.nome || 'fonte'}`.slice(0, 255),
    titulo: meta.titulo || post.titulo || post.url.slice(0, 120),
    url_original: post.url,
    thumbnail: meta.thumbnail || post.thumbnail || null,
    duracao: meta.duracao || null,
    autor: meta.autor || fonte?.nome || null,
    autor_url: meta.autorUrl || fonte?.url || null,
    status: 'pendente',
    metadata: { extractor: meta.extractor, biblioteca_post_id: post.id, fonte_id: fonte?.id },
  });

  const video = await Videos.findById(id);
  importService.queueLinkImport(video);
  await BibliotecaPosts.update(post.id, { status: 'gerado_video', video_id: id });

  return { video, created: true, queued: true };
}

async function tickFontes() {
  const due = await BibliotecaFontes.findDue();
  for (const fonte of due) {
    try {
      await escanearFonte(fonte, { silentFirst: true });
    } catch (err) {
      console.error(`[biblioteca] fonte #${fonte.id}:`, err.message);
      await BibliotecaFontes.update(fonte.id, {
        ultimo_erro: String(err.message || err).slice(0, 1000),
        proxima_execucao: nextRun(fonte.intervalo_minutos),
        ultimo_scan: new Date(),
      });
    }
  }
}

async function dashboardUsuario(userId) {
  const [fontes, posts, alertas, countRow] = await Promise.all([
    BibliotecaFontes.findByUser(userId),
    BibliotecaPosts.findByUser(userId, { limit: 30 }),
    BibliotecaAlertas.findByUser(userId, { limit: 30 }),
    BibliotecaAlertas.countNaoLidos(userId),
  ]);
  return {
    fontes,
    posts,
    alertas,
    alertasNaoLidos: Number(countRow?.total || 0),
  };
}

module.exports = {
  detectarPlataforma,
  criarFonte,
  atualizarFonte,
  escanearAgora,
  gerarTextoDePost,
  gerarVideoDePost,
  tickFontes,
  dashboardUsuario,
  resolvePage,
};
