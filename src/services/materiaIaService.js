const AiMatters = require('../models/AiMatters');
const AiMonitors = require('../models/AiMonitors');
const AiFilaJobs = require('../models/AiFilaJobs');
const Publications = require('../models/Publications');
const FacebookPages = require('../models/FacebookPages');
const FacebookAccounts = require('../models/FacebookAccounts');
const { pesquisarNichos } = require('./newsResearch');
const { buscarEmAltaAgora } = require('./trendingTopics');
const { apurarTopico } = require('./articleSource');
const { gerarMateriaNoticiaFacebook, assertDeepseek } = require('./deepseekService');
const pexelsService = require('./pexelsService');
const facebookService = require('./facebookService');
const { enqueue } = require('../workers/queue');
const { env } = require('../config/env');
const db = require('../config/db');
const { titulosParecidos, mesmoAssuntoNoticia, formatFacebookCaption, montarFonteCredito, estiloCreditoDaPagina } = require('./editorialGuidelinesFb');
const { applyBrandArtworkToResult } = require('./matterArtworkService');

async function resolvePage(userId, facebookPageId) {
  const { resolvePageForUser, defaultPageForUser } = require('./facebookPageResolver');
  const page = await resolvePageForUser(userId, facebookPageId);
  if (page) return page;
  // Sem página válida no pedido, usa a padrão da conta logada (definida em /paginas).
  return defaultPageForUser(userId);
}

function parseHashtagsField(raw) {
  try {
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string' && raw.trim()) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return [];
}

/** Legenda formatada para o Facebook (espaços, parágrafos, crédito, hashtags). */
function montarMensagem({ titulo, materia, hashtags, fonteCredito, incluirTitulo = true }) {
  return formatFacebookCaption({
    titulo,
    materia,
    hashtags: parseHashtagsField(hashtags),
    fonteCredito,
    incluirTitulo,
  });
}

function creditoPadraoDaMateria({ topico, gerado, tipoPublicacao, pageName }) {
  const estilo = estiloCreditoDaPagina(pageName);
  return montarFonteCredito({
    veiculo: topico?.veiculo || topico?.fonte || gerado?.imagemOrigem?.veiculo,
    fonte: topico?.fonte,
    host: topico?.link || topico?.url,
    tipoPublicacao,
    autorArtigo: topico?.autor || gerado?.autorArtigo || null,
    estilo,
    imagemOrigem:
      gerado?.imagemOrigem ||
      (tipoPublicacao === 'foto' || gerado?.imagemUrl ? { tipo: 'fonte', autor: gerado?.imagemAutor } : null),
  });
}

/**
 * Checa duplicidade com matérias/publicações recentes da mesma página/usuário.
 */
async function checarDuplicidade({ userId, facebookPageId, titulo, materia }) {
  const avisos = [];
  const recentes = await AiMatters.findByUser(userId, 80);
  for (const m of recentes) {
    const status = String(m.status || '');
    if (!['rascunho', 'pronto', 'agendado', 'publicado'].includes(status) && !m.publication_id) {
      continue;
    }
    if (
      mesmoAssuntoNoticia(titulo, m.titulo) ||
      mesmoAssuntoNoticia(titulo, m.fonte_titulo) ||
      titulosParecidos(titulo, m.titulo) ||
      titulosParecidos(materia?.slice(0, 180), m.materia?.slice(0, 180))
    ) {
      avisos.push(`Possível duplicata de matéria #${m.id} (${status}): “${m.titulo || 'sem título'}”`);
      break;
    }
  }

  if (facebookPageId) {
    try {
      const pubs = await Publications.recent(userId, 20);
      for (const p of pubs) {
        const texto = p.texto || p.legenda_sugerida || '';
        if (mesmoAssuntoNoticia(titulo, texto.slice(0, 160)) || titulosParecidos(titulo, texto.slice(0, 120))) {
          avisos.push(`Possível duplicata de publicação recente na Página (${p.page_name || 'FB'})`);
          break;
        }
      }
    } catch (err) {
      console.warn('checarDuplicidade pubs:', err.message);
    }
  }

  return avisos;
}

function pautaTemPessoaNomeada(topico, gerado) {
  const texto = [
    topico?.titulo,
    gerado?.titulo,
    ...(Array.isArray(gerado?.termos_imagem) ? gerado.termos_imagem : []),
  ].filter(Boolean).join(' · ');

  // Duas ou mais palavras iniciadas em maiúscula normalmente identificam uma pessoa
  // (ex.: Flávio Bolsonaro, Silas Malafaia). Nesses casos, foto genérica é pior que rascunho.
  return /\b[\p{Lu}][\p{L}'’-]{2,}(?:\s+(?:da|das|de|do|dos)?\s*[\p{Lu}][\p{L}'’-]{2,})+/u.test(texto);
}

/**
 * Escolhe URL da capa + metadados para crédito do autor da imagem.
 * @returns {Promise<{ url: string|null, autor?: string|null, fonte?: string|null, titulo?: string|null, origem?: string|null }>}
 */
async function escolherImagemCapa(topico, gerado) {
  if (topico?.imagemFonte && /^https?:\/\//i.test(topico.imagemFonte)) {
    return {
      url: topico.imagemFonte,
      autor: null,
      fonte: topico.fonte || topico.veiculo || null,
      titulo: topico.titulo || null,
      origem: 'fonte',
    };
  }

  // A Pexels não é uma fonte editorial de pessoas públicas. Se a fonte original não
  // forneceu foto, não substitui Malafaia/Flávio Bolsonaro por igreja ou política genérica.
  if (pautaTemPessoaNomeada(topico, gerado)) return { url: null };
  if (!env.pexelsApiKey) return { url: null };

  try {
    const termo =
      (Array.isArray(gerado.termos_imagem) && gerado.termos_imagem[0]) ||
      (gerado.hashtags && gerado.hashtags[0]) ||
      topico?.nicho ||
      String(gerado.titulo || topico?.titulo || 'news').split(/\s+/).slice(0, 3).join(' ');
    const photos = await pexelsService.searchPhotos(termo, { perPage: 5 });
    const first = photos?.photos?.[0];
    const url = first?.urlOriginal || first?.thumbnail || null;
    if (!url) return { url: null };
    return {
      url,
      autor: first.autor || null,
      fonte: first.autor ? `Pexels · ${first.autor}` : 'Pexels',
      titulo: first.alt || termo,
      origem: 'pexels',
    };
  } catch (err) {
    console.warn('escolherImagemCapa:', err.message);
    return { url: null };
  }
}

/**
 * Marca tópicos já usados/publicados na página (ou no usuário).
 */
async function marcarJaPublicados(userId, facebookPageId, topicos) {
  const lista = Array.isArray(topicos) ? topicos : [];
  if (!lista.length || !userId) return lista;

  // Histórico maior para não sugerir de novo pautas já usadas na página
  const matters = await AiMatters.findByUser(userId, 250);
  const urls = new Set();
  const titulos = [];
  for (const m of matters) {
    if (facebookPageId && m.facebook_page_id && Number(m.facebook_page_id) !== Number(facebookPageId)) {
      continue;
    }
    // Qualquer matéria já gerada (rascunho → agendado → publicado)
    const usado =
      m.status === 'publicado' ||
      m.status === 'agendado' ||
      m.status === 'pronto' ||
      m.status === 'rascunho' ||
      Boolean(m.publication_id);
    if (!usado) continue;
    if (m.fonte_url) urls.add(String(m.fonte_url).split(/[?#]/)[0].toLowerCase());
    if (m.fonte_titulo) titulos.push(m.fonte_titulo);
    if (m.titulo) titulos.push(m.titulo);
  }

  return lista.map((t) => {
    const link = String(t.link || '')
      .split(/[?#]/)[0]
      .toLowerCase();
    const jaPorUrl = Boolean(link && urls.has(link));
    const jaPorTitulo = titulos.some(
      (x) => mesmoAssuntoNoticia(t.titulo, x) || titulosParecidos(t.titulo, x)
    );
    return { ...t, jaPublicado: jaPorUrl || jaPorTitulo };
  });
}

async function gerarPreviewDeTopico(
  topico,
  {
    userId,
    facebookPageId,
    tipoPublicacao = 'texto',
    investigativa = false,
    furoReportagem = false,
    variacaoViral = false,
    textoEvitar = null,
  } = {}
) {
  assertDeepseek();
  const apurado = await apurarTopico(topico || {});

  let contextoAprendizado = null;
  if (userId) {
    try {
      const learning = require('./editorialLearningService');
      contextoAprendizado = await learning.obterContextoAprendizado(userId);
    } catch (err) {
      console.warn('[editorial-learning] carregar:', err.message);
    }
  }

  const gerado = await gerarMateriaNoticiaFacebook({
    tituloReferencia: apurado.titulo,
    resumoReferencia: apurado.resumo,
    fonte: apurado.veiculo || apurado.fonte,
    nicho: apurado.nicho,
    contextoApuracao: apurado.contextoApuracao,
    fontesApuracao: apurado.fontesApuracao,
    dataReferencia: apurado.dataReferencia || apurado.data,
    emAlta: Boolean(apurado.emAlta || apurado.emAltaAgora),
    redeSocial: Boolean(apurado.redeSocial || apurado.tipoFonte === 'rede_social'),
    investigativa,
    furoReportagem,
    variacaoViral,
    textoEvitar,
    contextoAprendizado,
    traduzirFonte: Boolean(
      topico?.traduzirFonte ||
        topico?.idiomaObrigatorio === 'pt-BR' ||
        /\b(the|and|church|christian|should|about|after|before)\b/i.test(
          `${apurado.titulo || ''} ${apurado.resumo || ''}`
        )
    ),
  });

  const capa = await escolherImagemCapa(apurado, gerado);
  const imagemUrl = capa?.url || null;
  const imagemOrigem = imagemUrl
    ? imagemUrl === apurado.imagemFonte
      ? {
          tipo: 'fonte',
          rotulo: `Foto da notícia original${apurado.veiculo ? ` · ${apurado.veiculo}` : ''}`,
          url: apurado.link || null,
        }
      : {
          tipo: 'pexels',
          rotulo: 'Foto temática da Pexels',
          consulta: gerado.termos_imagem?.[0] || gerado.hashtags?.[0] || apurado.nicho || null,
        }
    : null;

  const { identificarAutorImagem } = require('./deepseekService');
  const {
    anexarCreditosFontes,
    estiloCreditoDaPagina,
    CREDITO_IMAGEM_FALLBACK,
    removerFechamentoOracao,
  } = require('./editorialGuidelinesFb');

  let pageName = null;
  if (facebookPageId) {
    try {
      const page = await FacebookPages.findById(facebookPageId);
      pageName = page?.page_name || null;
    } catch {
      /* ignore */
    }
  }
  const estiloCredito = estiloCreditoDaPagina(pageName);

  let imagemAutor = CREDITO_IMAGEM_FALLBACK;
  if (imagemUrl) {
    const identificado = await identificarAutorImagem({
      autor: capa.autor || null,
      fonte: capa.fonte || null,
      titulo: capa.titulo || apurado.titulo || null,
      origem: capa.origem || imagemOrigem?.tipo || null,
    });
    imagemAutor = identificado || CREDITO_IMAGEM_FALLBACK;
  }

  const avisosDuplicidade = userId
    ? await checarDuplicidade({
        userId,
        facebookPageId,
        titulo: gerado.titulo,
        materia: gerado.materia,
      })
    : [];

  const avisos = [
    gerado._avisoQualidade,
    ...(gerado._muletasIa?.length ? [`Muletas IA restantes: ${gerado._muletasIa.join(', ')}`] : []),
    ...(gerado._citacoesSuspeitas?.length
      ? [`Nomes em citações fora da apuração: ${gerado._citacoesSuspeitas.join(', ')}`]
      : []),
    ...avisosDuplicidade,
  ].filter(Boolean);

  const semImagemFoto = tipoPublicacao === 'foto' && !imagemUrl;

  const materiaComFontes = removerFechamentoOracao(
    anexarCreditosFontes(gerado.materia, {
      fonteNome: apurado.veiculo || apurado.fonte || null,
      fonteUrl: apurado.link || null,
      imagemAutor,
      autorArtigo: apurado.autor || null,
      estilo: estiloCredito,
    })
  );

  return {
    ...gerado,
    materia: materiaComFontes,
    imagemUrl,
    imagemOrigem,
    imagemAutor,
    autorArtigo: apurado.autor || null,
    estiloCredito,
    pageName,
    topico: apurado,
    avisos,
    forcarRascunho: semImagemFoto,
    avisoFoto: semImagemFoto
      ? 'Não foi encontrada uma foto editorial relacionada. A matéria foi mantida como rascunho para evitar publicar uma imagem genérica ou incorreta.'
      : null,
  };
}

async function salvarMateria({ userId, facebookPageId, gerado, topico, tipoPublicacao = 'texto', status = 'pronto' }) {
  let finalStatus = status;
  if (gerado.forcarRascunho || (tipoPublicacao === 'foto' && !(gerado.imagemUrl || topico?.imagemFonte))) {
    finalStatus = 'rascunho';
  }

  const [id] = await AiMatters.create({
    user_id: userId,
    facebook_page_id: facebookPageId || null,
    titulo: gerado.titulo || topico?.titulo || null,
    materia: gerado.materia,
    titulo_ia: gerado.titulo || topico?.titulo || null,
    materia_ia: gerado.materia || null,
    hashtags: JSON.stringify(gerado.hashtags || []),
    fonte_titulo: topico?.titulo || null,
    fonte_url: topico?.link || null,
    fonte_resumo: topico?.resumo || null,
    fonte_credito: null, // crédito fica só no corpo (materia); evita repetir no campo Fonte/crédito
    contexto_apuracao: topico?.contextoApuracao || null,
    status: finalStatus,
    tipo_publicacao: tipoPublicacao === 'foto' ? 'foto' : 'texto',
    imagem_url: gerado.imagemUrl || topico?.imagemFonte || null,
    error_message: gerado.avisoFoto || null,
  });
  return AiMatters.findById(id);
}

async function publicarMateria(userId, matterId, overrides = {}) {
  let matter = await AiMatters.findById(matterId);
  if (!matter || matter.user_id !== userId) {
    const err = new Error('Matéria não encontrada');
    err.status = 404;
    throw err;
  }

  const facebookPageId = overrides.facebook_page_id || matter.facebook_page_id;
  const page = await resolvePage(userId, facebookPageId);
  if (!page) {
    const err = new Error('Conecte/selecione uma página do Facebook');
    err.status = 400;
    throw err;
  }

  // Reel nunca pode “cair” para texto por override do body (pickTipo default = texto)
  const tipo =
    matter.tipo_publicacao === 'reel'
      ? 'reel'
      : overrides.tipo_publicacao && overrides.tipo_publicacao !== 'auto'
        ? overrides.tipo_publicacao
        : matter.tipo_publicacao || 'texto';
  const mensagem = montarMensagem({
    titulo: overrides.titulo || matter.titulo,
    materia: (() => {
      const raw = overrides.materia || matter.materia;
      if (estiloCreditoDaPagina(page.page_name) !== 'jm') return raw;
      if (!/Fontes:\s*\n\s*[•\*]/i.test(String(raw || ''))) return raw;
      const { converterCreditosParaJm } = require('./editorialGuidelinesFb');
      return converterCreditosParaJm(raw, {
        fonteUrl: matter.fonte_url,
        autorArtigo: null,
      });
    })(),
    hashtags: overrides.hashtags || matter.hashtags,
    fonteCredito: '', // crédito só no corpo da matéria
    incluirTitulo: tipo !== 'foto',
  });

  if (!mensagem.trim() || String(mensagem).startsWith('⏳')) {
    const err = new Error(
      String(mensagem).startsWith('⏳')
        ? 'Aguarde o Reel terminar de processar (vídeo + legenda) antes de publicar.'
        : 'Matéria vazia'
    );
    err.status = 400;
    throw err;
  }

  if (tipo === 'reel' && !matter.video_path && !matter.video_clip_id) {
    const err = new Error('Vídeo do Reel ainda não está pronto. Aguarde o processamento.');
    err.status = 422;
    throw err;
  }

  const imagemUrl = overrides.imagem_url || matter.imagem_url;
  if (tipo === 'foto' && !imagemUrl && !matter.imagem_path) {
    await AiMatters.update(matter.id, {
      status: 'rascunho',
      error_message: 'Foto sem imagem — salva como rascunho',
    });
    const err = new Error('Tipo foto exige imagem de capa. Matéria mantida como rascunho.');
    err.status = 422;
    throw err;
  }

  const avisosDup = await checarDuplicidade({
    userId,
    facebookPageId: page.id,
    titulo: overrides.titulo || matter.titulo,
    materia: overrides.materia || matter.materia,
  });
  if (avisosDup.length && !overrides.forcar) {
    console.warn('[duplicidade]', avisosDup.join(' | '));
  }

  const pubTipo = tipo === 'reel' ? 'reel' : tipo === 'foto' ? 'foto' : 'texto';

  const [pubId] = await Publications.create({
    video_clip_id: matter.video_clip_id || null,
    imagem_id: null,
    facebook_page_id: page.id,
    tipo: pubTipo,
    status: 'pendente',
    texto: mensagem,
  });

  await AiMatters.update(matter.id, {
    facebook_page_id: page.id,
    tipo_publicacao: pubTipo === 'reel' ? 'reel' : pubTipo === 'foto' ? 'foto' : 'texto',
    publication_id: pubId,
    status: 'pronto',
    error_message: null,
    titulo: overrides.titulo || matter.titulo,
    materia: overrides.materia || matter.materia,
  });

  const executarPublicacao = async () => {
    const publishDispatch = require('./publishDispatch');
    const { storageAbsolutePath } = require('./downloadService');
    const fs = require('fs');
    const img = overrides.imagem_url || matter.imagem_url;
    const hasFoto = Boolean(img || matter.imagem_path);

    let reelFile = null;
    if (pubTipo === 'reel') {
      // Só regenera capa se ainda não estiver pronta (ffmpeg demora minutos — não refazer a cada publish)
      if (matter.video_clip_id) {
        try {
          const { applyCoverToClipNow } = require('./clipPostProcessService');
          await applyCoverToClipNow({
            clipId: matter.video_clip_id,
            userId,
            titulo: overrides.titulo || matter.titulo,
            force: false,
          });
          matter = await AiMatters.findById(matter.id);
        } catch (capaErr) {
          console.warn(`[publicar-reel] capa matter #${matter.id}:`, capaErr.message);
        }
      }

      // Preferir arquivo atual do clipe (com capa), não um path antigo deletado
      let rel = matter.video_path;
      if (matter.video_clip_id) {
        try {
          const VideoClips = require('../models/VideoClips');
          const clip = await VideoClips.findById(matter.video_clip_id);
          if (clip?.caminho_arquivo) rel = clip.caminho_arquivo;
        } catch {
          /* ignore */
        }
      }

      if (!rel) {
        const err = new Error('Vídeo do Reel não encontrado.');
        err.status = 422;
        throw err;
      }
      reelFile = storageAbsolutePath(rel);
      if (!fs.existsSync(reelFile)) {
        const err = new Error(
          `Arquivo do Reel ausente no servidor (${rel}). Gere novamente a partir do link.`
        );
        err.status = 422;
        throw err;
      }
      if (rel !== matter.video_path) {
        await AiMatters.update(matter.id, { video_path: rel });
        matter.video_path = rel;
      }
      console.log(
        `[publicar-reel] matter #${matter.id} file=${rel} bytes=${fs.statSync(reelFile).size}`
      );
    }

    const result = await publishDispatch.publishContent({
      userId,
      page,
      tipo:
        pubTipo === 'reel'
          ? 'reel'
          : tipo === 'foto' && hasFoto
            ? 'foto'
            : 'texto',
      filePath: reelFile,
      imagemPath: pubTipo === 'reel' ? null : matter.imagem_path || null,
      imageUrl: pubTipo === 'foto' && img ? img : null,
      texto: mensagem,
      // A legenda completa já contém o título. No PostSyncer, settings.title a substituiria.
      titulo: null,
    });

    const postId = result.post_id || result.id;
    const fbPostUrl = result.fb_post_url || publishDispatch.buildFbPostUrl(page, postId);
    const nativeId = result.fb_native_post_id || null;
    const pubPatch = {
      status: 'publicado',
      fb_post_id: postId,
      fb_post_url: fbPostUrl,
      published_at: new Date(),
      erro_mensagem: null,
    };
    if (nativeId) pubPatch.fb_native_post_id = nativeId;
    await Publications.update(pubId, pubPatch);
    await AiMatters.update(matter.id, {
      status: 'publicado',
      published_at: new Date(),
      error_message: null,
    });
    return { postId, fbPostUrl };
  };

  if (overrides.sync) {
    try {
      const published = await executarPublicacao();
      return {
        matterId: matter.id,
        publicationId: pubId,
        queued: false,
        postId: published.postId,
        fbPostUrl: published.fbPostUrl,
      };
    } catch (err) {
      const publishDispatch = require('./publishDispatch');
      const msg = publishDispatch.publishErrorMessage(err);
      await Publications.update(pubId, {
        status: 'erro',
        erro_mensagem: String(msg).slice(0, 500),
      });
      await Publications.increment(pubId);
      await AiMatters.update(matter.id, {
        status: 'erro',
        error_message: String(msg).slice(0, 500),
      });
      const out = new Error(msg || err.message || 'Falha ao publicar');
      out.status = err.status || err.response?.status || 502;
      out.cause = err;
      throw out;
    }
  }

  enqueue(`ai matter publish ${matter.id}`, async () => {
    try {
      await executarPublicacao();
    } catch (err) {
      const publishDispatch = require('./publishDispatch');
      const msg = publishDispatch.publishErrorMessage(err);
      await Publications.update(pubId, {
        status: 'erro',
        erro_mensagem: String(msg).slice(0, 500),
      });
      await Publications.increment(pubId);
      await AiMatters.update(matter.id, {
        status: 'erro',
        error_message: String(msg).slice(0, 500),
      });
      const out = new Error(msg || err.message || 'Falha ao publicar');
      out.status = err.status || err.response?.status || 502;
      throw out;
    }
  });

  return { matterId: matter.id, publicationId: pubId, queued: true };
}

/**
 * Fluxo unificado: apurar → gerar → salvar → (opcional) publicar.
 */
async function gerarCompleto({
  userId,
  topico,
  facebookPageId,
  tipoPublicacao = 'texto',
  status = 'rascunho',
  investigativa = false,
  furoReportagem = false,
  variacaoViral = false,
  textoEvitar = null,
}) {
  const tipo = tipoPublicacao === 'foto' ? 'foto' : 'texto';
  const gerado = await gerarPreviewDeTopico(topico, {
    userId,
    facebookPageId,
    tipoPublicacao: tipo,
    investigativa,
    furoReportagem,
    variacaoViral,
    textoEvitar,
  });
  const topicoApurado = gerado.topico || topico;

  let statusSalvar = status === 'publicado' ? 'pronto' : 'rascunho';
  if (gerado.forcarRascunho) statusSalvar = 'rascunho';

  const matter = await salvarMateria({
    userId,
    facebookPageId: facebookPageId || null,
    gerado,
    topico: topicoApurado,
    tipoPublicacao: tipo,
    status: statusSalvar,
  });

  let payload = {
    matter,
    artigo: {
      titulo: gerado.titulo,
      materia: gerado.materia,
      hashtags: gerado.hashtags,
      imagemUrl: gerado.imagemUrl,
      imagemOrigem: gerado.imagemOrigem || null,
      termos_imagem: gerado.termos_imagem || [],
    },
    avisos: [...(gerado.avisos || []), gerado.avisoFoto].filter(Boolean),
    qualidade: {
      chars: gerado._chars,
      ok: gerado._qualidadeOk,
      estilo: gerado._estilo,
    },
    publication: null,
    fbPostUrl: null,
  };

  // Aplica Minha marca (arte 4:5) antes de qualquer publicação.
  if (tipo === 'foto' || gerado.imagemUrl) {
    payload = await applyBrandArtworkToResult(userId, payload);
    if (payload.matter?.forcarRascunho || (tipo === 'foto' && !payload.matter?.imagem_path && !payload.artigo?.imagemUrl)) {
      /* avisos já vêm em payload.avisos */
    }
  }

  const querPublicar = status === 'publicado' && !gerado.forcarRascunho && facebookPageId;
  if (querPublicar) {
    if (tipo === 'foto' && !payload.matter?.imagem_path) {
      payload.avisos = [
        ...(payload.avisos || []),
        'A publicação não foi enviada porque a arte final não pôde ser criada.',
      ];
      return payload;
    }
    const pub = await publicarMateria(userId, payload.matter.id, {
      facebook_page_id: facebookPageId,
      tipo_publicacao: tipo,
      imagem_url: payload.artigo.imagemUrl || payload.matter.imagem_url,
      sync: true,
    });
    payload.publication = pub;
    payload.fbPostUrl = pub.fbPostUrl || null;
    payload.matter = await AiMatters.findById(payload.matter.id);
  }

  return payload;
}

async function gerarEPublicarLote({ userId, topicos, facebookPageId, tipoPublicacao = 'texto' }) {
  const page = await resolvePage(userId, facebookPageId);
  if (!page) {
    const err = new Error('Selecione uma página do Facebook válida');
    err.status = 400;
    throw err;
  }

  const lista = Array.isArray(topicos) ? topicos.slice(0, 5) : [];
  const criados = [];
  const erros = [];

  for (const topico of lista) {
    try {
      const gerado = await gerarPreviewDeTopico(topico, {
        userId,
        facebookPageId: page.id,
        tipoPublicacao,
      });
      const matter = await salvarMateria({
        userId,
        facebookPageId: page.id,
        gerado,
        topico,
        tipoPublicacao,
        status: 'pronto',
      });

      if (gerado.forcarRascunho || matter.status === 'rascunho') {
        erros.push({
          titulo: topico?.titulo || '—',
          erro: gerado.avisoFoto || 'Salvo como rascunho (foto sem imagem)',
        });
        criados.push({ matterId: matter.id, publicationId: null, titulo: gerado.titulo, rascunho: true });
        continue;
      }

      const pub = await publicarMateria(userId, matter.id, {
        facebook_page_id: page.id,
        tipo_publicacao: tipoPublicacao,
        imagem_url: gerado.imagemUrl,
      });
      criados.push({ matterId: matter.id, publicationId: pub.publicationId, titulo: gerado.titulo });
    } catch (err) {
      erros.push({ titulo: topico?.titulo || '—', erro: err.message });
    }
  }

  return { criados, erros };
}

async function criarMonitor({
  userId,
  facebookPageId,
  palavrasChave,
  intervaloMinutos = 30,
  postsPorCiclo = 1,
  tipoPublicacao = 'texto',
  inicioEm,
  fimEm,
}) {
  const page = await resolvePage(userId, facebookPageId);
  if (!page) {
    const err = new Error('Selecione uma página do Facebook válida');
    err.status = 400;
    throw err;
  }

  const intervalo = Math.max(5, Number(intervaloMinutos) || 30);
  const qtd = Math.min(Math.max(Number(postsPorCiclo) || 1, 1), 3);
  const agora = new Date();
  const inicio = inicioEm ? new Date(inicioEm) : agora;
  const [id] = await AiMonitors.create({
    user_id: userId,
    facebook_page_id: page.id,
    palavras_chave: String(palavrasChave || '').trim(),
    intervalo_minutos: intervalo,
    posts_por_ciclo: qtd,
    tipo_publicacao: tipoPublicacao === 'foto' ? 'foto' : 'texto',
    ativo: true,
    inicio_em: inicio,
    fim_em: fimEm ? new Date(fimEm) : null,
    proxima_execucao: inicio,
  });
  return AiMonitors.findById(id);
}

async function tickMonitores() {
  const due = await AiMonitors.findDue();
  for (const monitor of due) {
    try {
      if (monitor.fim_em && new Date(monitor.fim_em) < new Date()) {
        await AiMonitors.update(monitor.id, { ativo: false, ultimo_erro: 'Período encerrado' });
        continue;
      }
      if (monitor.inicio_em && new Date(monitor.inicio_em) > new Date()) continue;

      const topicosBrutos = await pesquisarNichos(monitor.palavras_chave, monitor.posts_por_ciclo, {
        periodo: '24h',
        filtrarPeriodo: true,
      });
      const topicos = (await marcarJaPublicados(monitor.user_id, monitor.facebook_page_id, topicosBrutos)).filter(
        (t) => !t.jaPublicado
      );
      const escolhidos = topicos.slice(0, monitor.posts_por_ciclo);
      if (escolhidos.length) {
        await gerarEPublicarLote({
          userId: monitor.user_id,
          topicos: escolhidos,
          facebookPageId: monitor.facebook_page_id,
          tipoPublicacao: monitor.tipo_publicacao,
        });
      }

      const proxima = new Date(Date.now() + monitor.intervalo_minutos * 60 * 1000);
      await AiMonitors.update(monitor.id, {
        ultimo_tick: new Date(),
        proxima_execucao: proxima,
        total_publicados: Number(monitor.total_publicados || 0) + escolhidos.length,
        ultimo_erro: null,
      });
    } catch (err) {
      await AiMonitors.update(monitor.id, {
        ultimo_erro: String(err.message).slice(0, 500),
        proxima_execucao: new Date(Date.now() + monitor.intervalo_minutos * 60 * 1000),
      });
    }
  }
}

async function agendarMateria({ userId, matterId, runAt }) {
  const matter = await AiMatters.findById(matterId);
  if (!matter || matter.user_id !== userId) {
    const err = new Error('Matéria não encontrada');
    err.status = 404;
    throw err;
  }
  const when = parseScheduleDate(runAt);
  if (Number.isNaN(when.getTime()) || when <= new Date()) {
    const err = new Error('Informe uma data/hora futura (horário de Araguaína / Tocantins)');
    err.status = 400;
    throw err;
  }
  await AiMatters.update(matter.id, { status: 'agendado', scheduled_at: when });

  const existing = await db('ai_fila_jobs')
    .where({ matter_id: matter.id, status: 'pendente' })
    .orderBy('id', 'desc')
    .first();
  if (existing) {
    await AiFilaJobs.update(existing.id, { run_at: when });
    return { jobId: existing.id, matterId: matter.id, runAt: when };
  }

  const [jobId] = await AiFilaJobs.create({
    user_id: userId,
    matter_id: matter.id,
    run_at: when,
    status: 'pendente',
    payload: JSON.stringify({ action: 'publish', matterId: matter.id }),
  });
  return { jobId, matterId: matter.id, runAt: when };
}

/** Formata Date → YYYY-MM-DDTHH:mm no fuso America/Araguaina. */
function toDatetimeLocalAraguaina(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Araguaina',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type)?.value || '00';
  let hour = get('hour');
  if (hour === '24') hour = '00';
  return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}`;
}

function formatLabelAraguaina(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('pt-BR', {
    timeZone: 'America/Araguaina',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatarHorarioAgendamento(scheduledAt) {
  const at = scheduledAt instanceof Date ? scheduledAt : new Date(scheduledAt);
  if (Number.isNaN(at.getTime())) return null;
  return {
    at: at.toISOString(),
    local: toDatetimeLocalAraguaina(at),
    label: formatLabelAraguaina(at),
  };
}

/**
 * Último horário entre matérias AGENDADAS (Minhas matérias).
 * Não usa Agenda da Biblioteca — evita misturar filas diferentes.
 * Retorna também o próximo slot sugerido (+30 min), nunca no passado.
 */
async function obterUltimoAgendamento(userId, { excludeMatterId = null } = {}) {
  let matterQuery = db('ai_matters')
    .where({ user_id: userId, status: 'agendado' })
    .whereNotNull('scheduled_at');
  if (excludeMatterId) {
    matterQuery = matterQuery.whereNot('id', Number(excludeMatterId));
  }
  const matterRow = await matterQuery
    .orderBy('scheduled_at', 'desc')
    .select('id', 'titulo', 'scheduled_at')
    .first();

  if (!matterRow?.scheduled_at) {
    return { ultimo: null, proximoSlotLocal: null, proximoSlotLabel: null };
  }

  const at = new Date(matterRow.scheduled_at);
  let proximo = new Date(at.getTime() + 30 * 60 * 1000);
  const minFuture = new Date(Date.now() + 10 * 60 * 1000);
  if (proximo.getTime() < minFuture.getTime()) proximo = minFuture;

  return {
    ultimo: {
      at: at.toISOString(),
      local: toDatetimeLocalAraguaina(at),
      label: formatLabelAraguaina(at),
      titulo: matterRow.titulo || null,
      fonte: 'materia',
      id: matterRow.id,
    },
    proximoSlotLocal: toDatetimeLocalAraguaina(proximo),
    proximoSlotLabel: formatLabelAraguaina(proximo),
  };
}

/** Interpreta agendamento no fuso America/Araguaina (UTC−3, sem horário de verão). */
function parseScheduleDate(runAt) {
  const raw = String(runAt || '').trim();
  if (!raw) return new Date(NaN);

  // Já veio em ISO com fuso (ex.: 2026-07-16T12:15:00.000Z)
  if (/Z$|[+-]\d{2}:\d{2}$/.test(raw)) {
    return new Date(raw);
  }

  // datetime-local: 2026-07-16T09:15 → trata como Araguaína (UTC-3)
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const sec = m[6] || '00';
    return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${sec}-03:00`);
  }

  return new Date(raw);
}

async function tickFilaJobs() {
  const jobs = await AiFilaJobs.findDue(5);
  for (const job of jobs) {
    await AiFilaJobs.update(job.id, { status: 'processando', attempts: Number(job.attempts || 0) + 1 });
    try {
      if (job.matter_id) {
        // sync:true — espera o PostPulse/Graph e captura erro no job
        await publicarMateria(job.user_id, job.matter_id, { sync: true });
      }
      await AiFilaJobs.update(job.id, { status: 'feito', erro: null });
    } catch (err) {
      await AiFilaJobs.update(job.id, { status: 'erro', erro: String(err.message).slice(0, 500) });
    }
  }

  // Fallback: matérias agendadas vencidas (sem job pendente ou job perdido)
  const db = require('../config/db');
  const dueMatters = await db('ai_matters')
    .where({ status: 'agendado' })
    .andWhere('scheduled_at', '<=', new Date())
    .orderBy('scheduled_at', 'asc')
    .limit(5);

  for (const matter of dueMatters) {
    try {
      await publicarMateria(matter.user_id, matter.id, { sync: true });
    } catch (err) {
      console.error(`[agendado] matéria #${matter.id}:`, err.message);
    }
  }
}

/**
 * Remove lixo do Facebook ("7.5K reactions · 150 shares | … | Autor").
 */
function limparTextoReelSocial(raw) {
  let t = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';

  const isStats = (p) =>
    /reaction/i.test(p) ||
    /\bshares?\b/i.test(p) ||
    /curtida/i.test(p) ||
    /visualiza/i.test(p) ||
    /coment[aá]rio/i.test(p) ||
    /^\d[\d.,]*\s*[KkMm]?\s*(views?|likes?)$/i.test(p);

  if (t.includes('|')) {
    const parts = t
      .split(/\s*\|\s*/)
      .map((p) => p.trim())
      .filter(Boolean)
      .filter((p) => !isStats(p));
    if (parts.length >= 2 && parts[parts.length - 1].length < 48 && parts[0].length > 50) {
      parts.pop(); // remove autor no final
    }
    if (parts.length) t = parts.join(' ').trim();
  }

  t = t
    .replace(
      /^[\d.,]+\s*[KkMm]?\s*(reactions?|curtidas?|likes?)\s*[·•\-–]\s*[\d.,]+\s*[KkMm]?\s*(shares?|compartilhamentos?)\s*/i,
      ''
    )
    .replace(/^[|·•\-–]\s*/, '')
    .trim();

  return t;
}

/**
 * Manchete curta para Reel (capa / campo título / VARCHAR).
 * Usa a 1ª frase do texto limpo; nunca devolve a legenda inteira.
 */
function tituloCurtoReel(raw, maxLen = 100) {
  const limpo = limparTextoReelSocial(raw);
  if (!limpo) return 'Reel';

  const sentence = limpo.match(/^(.{12,}?[.!?…])(?:\s|$)/);
  let t = (sentence ? sentence[1] : limpo).trim();

  if (t.length > maxLen) {
    t = t.slice(0, maxLen);
    const sp = t.lastIndexOf(' ');
    if (sp > Math.floor(maxLen * 0.45)) t = t.slice(0, sp);
    t = `${t.replace(/[.,;:\-–—\s]+$/g, '')}…`;
  }

  return t || 'Reel';
}

/**
 * Sincroniza AiMatter (tipo reel) após download/transcrição/capa do clipe.
 */
async function syncConteudoReelMatter({ matterId, clip, video, gerado = null }) {
  if (!matterId || !clip?.id) return;
  const AiMatters = require('../models/AiMatters');
  const matter = await AiMatters.findById(matterId);
  if (!matter) return;

  const meta =
    video?.metadata && typeof video.metadata === 'object'
      ? video.metadata
      : (() => {
          try {
            return JSON.parse(video?.metadata || '{}');
          } catch {
            return {};
          }
        })();

  const titulo = tituloCurtoReel(
    gerado?.titulo || clip.capa_titulo || meta.titulo_completo || video?.titulo || matter.titulo || 'Reel',
    100
  );

  let materia =
    gerado?.materia ||
    clip.legenda_sugerida ||
    (String(matter.materia || '').startsWith('⏳') ? '' : matter.materia) ||
    '';

  if (!materia || String(materia).startsWith('⏳')) {
    // Sem legenda da IA ainda — usa texto limpo do post (sem reactions/shares)
    const fallback = limparTextoReelSocial(meta.titulo_completo || video?.titulo || '');
    materia = fallback || '⏳ Processando Reel (legenda e capa)…';
  }

  // Campo matéria não deve ser o título gigante do FB nem métricas
  if (/reaction|shares?/i.test(String(materia))) {
    materia = limparTextoReelSocial(materia) || '⏳ Processando Reel (legenda e capa)…';
  }

  // Prefere arquivo COM capa (caminho_arquivo após addCoverToClip)
  const videoPath = clip.caminho_arquivo || matter.video_path || null;
  const capaOk = clip.capa_status === 'pronta';

  const patch = {
    titulo,
    fonte_titulo: titulo.slice(0, 500),
    materia,
    tipo_publicacao: 'reel',
    video_path: videoPath,
    video_clip_id: clip.id,
    status: 'rascunho',
    error_message: null,
  };

  if (gerado?.hashtags) {
    patch.hashtags = JSON.stringify(gerado.hashtags);
  }
  if (video?.thumbnail && !matter.imagem_url) {
    patch.imagem_url = video.thumbnail;
  }

  if (!videoPath) {
    patch.materia = '⏳ Processando Reel (vídeo)…';
  } else if (!capaOk && !gerado?.materia && !clip.legenda_sugerida) {
    patch.materia = materia.startsWith('⏳')
      ? '⏳ Processando capa e legenda do Reel…'
      : materia;
  }

  if (clip.materia_status === 'erro' && !gerado?.materia) {
    patch.error_message = String(clip.erro_mensagem || 'Falha ao gerar matéria do Reel').slice(0, 500);
  }

  await AiMatters.update(matterId, patch);
  console.log(
    `[conteudo-reel] matter #${matterId} ← clip #${clip.id} video=${patch.video_path} capa=${clip.capa_status || '?'}`
  );
}

/**
 * Reel/vídeo FB/IG → AiMatter em /materias-ia (vídeo + legenda), sem fluxo de cortes na Fila.
 */
async function gerarDeLinkReel({ userId, url, facebookPageId = null }) {
  const Videos = require('../models/Videos');
  const VideoClips = require('../models/VideoClips');
  const importService = require('./importService');
  const { detectarPlataformaSocial } = require('./socialPostExtract');
  const scrapeCreators = require('./scrapeCreatorsSocial');

  const link = String(url || '').trim();
  const plataforma = detectarPlataformaSocial(link) || 'rede';

  let socialMeta = null;
  if (scrapeCreators.isConfigured() && (plataforma === 'instagram' || plataforma === 'facebook')) {
    try {
      socialMeta = await scrapeCreators.extrairPost(link, plataforma);
    } catch (socialErr) {
      console.warn('[conteudo-reel] scrapecreators:', socialErr.message);
    }
  }

  let meta = {
    titulo: null,
    thumbnail: null,
    extractor: null,
    autor: null,
    autorUrl: null,
    duracao: null,
  };
  let metaWarning = null;
  // Quando a ScrapeCreators já entregou a mídia, evita uma chamada yt-dlp que costuma
  // falhar com HTTP 400 no Instagram. A duração será obtida pelo ffprobe após o download.
  if (!socialMeta?.videoUrl) {
    try {
      meta = await importService.fetchLinkMetadata(link);
    } catch (metaErr) {
      metaWarning = importService.humanizeYtDlpError(metaErr);
      console.warn('[conteudo-reel] metadata:', metaWarning);
    }
  }

  if (socialMeta) {
    meta = {
      ...meta,
      description: socialMeta.texto || meta.description || null,
      titulo: socialMeta.titulo || meta.titulo || null,
      thumbnail: socialMeta.imagem || meta.thumbnail || null,
      autor: socialMeta.veiculo || meta.autor || null,
      autorUrl: socialMeta.autorUrl || meta.autorUrl || null,
      extractor: [socialMeta.metodo, meta.extractor].filter(Boolean).join('+') || null,
    };
  }

  const tituloBruto = meta.description || meta.titulo || `Reel — ${plataforma}`;
  // Prefere o texto mais longo entre title e description (FB costuma meter a legenda em um dos dois)
  const candidatosTexto = [meta.description, meta.titulo]
    .filter(Boolean)
    .map((t) => limparTextoReelSocial(t))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const textoLimpo = candidatosTexto[0] || limparTextoReelSocial(tituloBruto);
  const titulo = tituloCurtoReel(textoLimpo || `Reel — ${plataforma}`, 100);

  // Reaproveita vídeo já importado deste link
  let video = await Videos.findByUrl(userId, link);
  let createdVideo = false;

  if (!video) {
    const [vid] = await Videos.create({
      user_id: userId,
      origem: 'link',
      termo_busca: `reel:${plataforma}`.slice(0, 255),
      titulo: titulo || `Reel — ${plataforma}`,
      url_original: link,
      thumbnail: meta.thumbnail || null,
      duracao: meta.duracao,
      autor: meta.autor ? String(meta.autor).slice(0, 255) : null,
      autor_url: meta.autorUrl ? String(meta.autorUrl).slice(0, 500) : null,
      status: 'pendente',
      metadata: {
        extractor: meta.extractor,
        pipeline: 'conteudo_reel',
        facebook_page_id: facebookPageId || null,
        metaWarning,
        plataforma,
        titulo_completo: textoLimpo.slice(0, 2000) || String(tituloBruto).slice(0, 2000),
      },
    });
    video = await Videos.findById(vid);
    createdVideo = true;
  } else {
    const metaBase =
      video.metadata && typeof video.metadata === 'object' ? video.metadata : {};
    const tituloSujo =
      /reaction|shares?/i.test(String(video.titulo || '')) ||
      String(video.titulo || '').length > 120;
    const patchVideo = {
      metadata: {
        ...metaBase,
        extractor: meta.extractor || metaBase.extractor || null,
        titulo_completo:
          textoLimpo.slice(0, 2000) ||
          metaBase.titulo_completo ||
          String(tituloBruto).slice(0, 2000),
      },
    };
    if (socialMeta || tituloSujo) patchVideo.titulo = titulo;
    if (socialMeta?.imagem) patchVideo.thumbnail = socialMeta.imagem;
    if (socialMeta?.veiculo) patchVideo.autor = String(socialMeta.veiculo).slice(0, 255);
    if (socialMeta?.autorUrl) patchVideo.autor_url = String(socialMeta.autorUrl).slice(0, 500);

    await Videos.update(video.id, patchVideo);
    video = await Videos.findById(video.id);
  }

  // Matter existente já vinculada a este link?
  let matter = null;
  const existingMatters = await AiMatters.findByUser(userId, 80);
  matter = existingMatters.find(
    (m) => m.tipo_publicacao === 'reel' && String(m.fonte_url || '') === link
  );
  if (!matter && video?.id) {
    const clips = await VideoClips.findByVideo(video.id);
    const clipIds = new Set(clips.map((c) => Number(c.id)));
    matter = existingMatters.find((m) => m.video_clip_id && clipIds.has(Number(m.video_clip_id)));
  }

  if (!matter) {
    const [matterId] = await AiMatters.create({
      user_id: userId,
      facebook_page_id: facebookPageId || null,
      titulo,
      materia:
        '⏳ Processando Reel: baixando o vídeo, transcrevendo a fala, gerando a legenda e aplicando a capa (Minha marca) no início…',
      hashtags: JSON.stringify([]),
      fonte_titulo: titulo,
      fonte_url: link,
      fonte_resumo: textoLimpo.slice(0, 1500) || null,
      fonte_credito: null,
      status: 'rascunho',
      tipo_publicacao: 'reel',
      imagem_url: meta.thumbnail || video.thumbnail || null,
      video_path: null,
      video_clip_id: null,
      error_message: null,
    });
    matter = await AiMatters.findById(matterId);
  } else {
    // Sempre normaliza os metadados da fonte e limpa lixo de tentativas anteriores.
    const patchLimpeza = {
      titulo,
      fonte_titulo: titulo,
      fonte_resumo: textoLimpo.slice(0, 1500) || matter.fonte_resumo || null,
      imagem_url: meta.thumbnail || matter.imagem_url || null,
    };
    if (
      /reaction|shares?/i.test(String(matter.materia || '')) ||
      String(matter.materia || '').length > 900
    ) {
      patchLimpeza.materia =
        '⏳ Processando Reel: baixando o vídeo, transcrevendo a fala, gerando a legenda e aplicando a capa (Minha marca) no início…';
    }
    if (matter.error_message) {
      patchLimpeza.error_message = null;
    }
    await AiMatters.update(matter.id, patchLimpeza);
    matter = await AiMatters.findById(matter.id);
  }

  // Já tem clipe pronto → sincroniza; se faltar capa/matéria, reenfileira
  if (video.caminho_local && (video.status === 'baixado' || video.status === 'cortado')) {
    const clips = await VideoClips.findByVideo(video.id);
    const pronto = clips.find((c) => c.status === 'pronto' && c.caminho_arquivo);
    if (pronto) {
      const precisaRefazer =
        pronto.capa_status !== 'pronta' ||
        pronto.materia_status !== 'pronta' ||
        !pronto.legenda_sugerida;

      if (precisaRefazer) {
        const metaBase =
          video.metadata && typeof video.metadata === 'object' ? video.metadata : {};
        await Videos.update(video.id, {
          metadata: {
            ...metaBase,
            pipeline: 'conteudo_reel',
            matter_id: matter.id,
            facebook_page_id: facebookPageId || metaBase.facebook_page_id || null,
            titulo_completo:
              metaBase.titulo_completo ||
              textoLimpo.slice(0, 2000) ||
              String(tituloBruto).slice(0, 2000),
          },
        });
        const { queueClipMateriaAndCover } = require('./clipPostProcessService');
        queueClipMateriaAndCover(pronto, await Videos.findById(video.id), {
          userId,
          force: true,
        });
        await AiMatters.update(matter.id, {
          error_message: null,
          materia: String(matter.materia || '').startsWith('⏳')
            ? matter.materia
            : '⏳ Gerando legenda e capa do Reel…',
          video_clip_id: pronto.id,
          video_path: pronto.caminho_arquivo || null,
        });
        return {
          modo: 'reel',
          queued: true,
          created: createdVideo,
          video,
          clip: pronto,
          matter: await AiMatters.findById(matter.id),
          redirect: `/materias-ia/${matter.id}`,
          aviso: 'Reel encontrado — gerando legenda e capa (Minha marca) no início do vídeo.',
        };
      }

      await syncConteudoReelMatter({
        matterId: matter.id,
        clip: pronto,
        video,
        gerado: pronto.legenda_sugerida
          ? { titulo: pronto.capa_titulo, materia: pronto.legenda_sugerida }
          : null,
      });
      matter = await AiMatters.findById(matter.id);
      return {
        modo: 'reel',
        queued: false,
        created: createdVideo,
        video,
        clip: pronto,
        matter,
        redirect: `/materias-ia/${matter.id}`,
        aviso: 'Reel pronto — revise a legenda e publique como Reels.',
      };
    }
  }

  // Guarda matter_id no vídeo para o pós-processo sincronizar
  const metaBase =
    video.metadata && typeof video.metadata === 'object'
      ? video.metadata
      : {};
  await Videos.update(video.id, {
    metadata: {
      ...metaBase,
      pipeline: 'conteudo_reel',
      matter_id: matter.id,
      facebook_page_id: facebookPageId || metaBase.facebook_page_id || null,
      plataforma,
      scrapecreators_video_url:
        socialMeta?.videoUrl || metaBase.scrapecreators_video_url || null,
      titulo_completo: metaBase.titulo_completo || String(tituloBruto).slice(0, 2000),
    },
  });
  video = await Videos.findById(video.id);

  importService.queueLinkImportAsReel(video, {
    facebookPageId,
    matterId: matter.id,
  });

  return {
    modo: 'reel',
    queued: true,
    created: createdVideo,
    video,
    matter,
    redirect: `/materias-ia/${matter.id}`,
    aviso:
      'Reel enfileirado. A página da matéria atualiza sozinha quando o vídeo, a legenda e a capa ficarem prontos.',
  };
}

/**
 * Usuário cola um link → apura a notícia OU post FB/IG → reescreve com furo (sem plagiar).
 * Reels/vídeos FB/IG → AiMatter em /materias-ia (vídeo + legenda + capa).
 */
async function gerarDeLink({
  userId,
  url,
  facebookPageId = null,
  tipoPublicacao = 'foto',
  status = 'rascunho',
  textoManual = '',
  imagemManual = '',
}) {
  const link = String(url || '').trim();
  if (!/^https?:\/\//i.test(link)) {
    const err = new Error('Informe um link válido (http ou https)');
    err.status = 400;
    throw err;
  }

  const {
    isSocialPostUrl,
    isSocialVideoUrl,
    extrairPostSocial,
    socialParaTopico,
  } = require('./socialPostExtract');

  // Reel / vídeo social → Fila (não vira AiMatter foto)
  if (isSocialVideoUrl(link) || tipoPublicacao === 'reel') {
    if (!isSocialVideoUrl(link) && tipoPublicacao === 'reel') {
      const err = new Error(
        'Para publicar como Reel, use um link de vídeo/Reel do Facebook ou Instagram.'
      );
      err.status = 422;
      throw err;
    }
    return gerarDeLinkReel({ userId, url: link, facebookPageId });
  }

  assertDeepseek();

  const tipoFinal = tipoPublicacao === 'auto' || tipoPublicacao === 'reel' ? 'foto' : tipoPublicacao;

  let apurado;
  if (isSocialPostUrl(link)) {
    const social = await extrairPostSocial(link, { textoManual, imagemManual });
    apurado = socialParaTopico(social, link);
    console.log('[materias-ia] post social', {
      plataforma: social.plataforma,
      metodo: social.metodo,
      textoLen: (social.texto || '').length,
      hasImage: Boolean(social.imagem),
    });

    // Nunca gerar matéria social sem legenda suficiente (evita alucinação).
    // O extrator manual já exige 40 caracteres; mantenha o mesmo limite aqui.
    if (String(social.texto || '').trim().length < 40) {
      const err = new Error(
        'A legenda deste post está vazia ou é muito curta para gerar uma matéria sem inventar informações. Cole o texto completo da postagem no campo auxiliar e tente de novo.'
      );
      err.status = 422;
      throw err;
    }
  } else {
    const topicoBase = {
      link,
      titulo: null,
      resumo: null,
      fonte: null,
    };
    apurado = await apurarTopico(topicoBase);
  }

  const temConteudo =
    Boolean(apurado.titulo) ||
    Boolean(apurado.resumo) ||
    Boolean(apurado.imagemFonte) ||
    Boolean(apurado.fontesApuracao?.length) ||
    Boolean(apurado.contextoApuracao && apurado.contextoApuracao.length > 80);

  if (!temConteudo) {
    const err = new Error(
      'Não foi possível ler este link. Use notícia, post público do Facebook ou Instagram (foto) — ou Reel/vídeo para publicar como Reels.'
    );
    err.status = 422;
    throw err;
  }

  if (!apurado.titulo) {
    apurado.titulo = apurado.veiculo
      ? `Notícia — ${apurado.veiculo}`
      : 'Notícia a partir do link';
  }

  return gerarCompleto({
    userId,
    topico: apurado,
    facebookPageId,
    tipoPublicacao: tipoFinal,
    status,
    furoReportagem: true,
  });
}

/**
 * Nova matéria no mesmo tema (anti-plágio + curiosidade), complementando com Brave/Serper.
 * Ex.: original fala do fato → variação pergunta "por que a pastora afirmou isso".
 */
async function gerarVariacaoDeMateria({
  userId,
  matterId,
  facebookPageId = null,
  tipoPublicacao = null,
}) {
  assertDeepseek();
  const matter = await AiMatters.findById(matterId);
  if (!matter || Number(matter.user_id) !== Number(userId)) {
    const err = new Error('Matéria não encontrada');
    err.status = 404;
    throw err;
  }

  const pageId = facebookPageId || matter.facebook_page_id || null;
  const tipo =
    tipoPublicacao === 'foto' || tipoPublicacao === 'texto'
      ? tipoPublicacao
      : matter.tipo_publicacao === 'foto'
        ? 'foto'
        : 'texto';

  const tituloOrig = String(matter.titulo || matter.fonte_titulo || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!tituloOrig) {
    const err = new Error('A matéria precisa de um título para gerar variação');
    err.status = 400;
    throw err;
  }

  const corpoOrig = String(matter.materia || '')
    .replace(/\n*Fontes:[\s\S]*$/i, '')
    .replace(/\n*Por\s+.+\s*[—\-–]\s*Site\s*:.+$/im, '')
    .replace(/#[\wÀ-ÿ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Extrai pessoa + aspas para buscas melhores
  const aspas = [...corpoOrig.matchAll(/[“"]([^”"]{12,160})[”"]/g)].map((m) => m[1].trim());
  const pessoaMatch = tituloOrig.match(
    /(?:pastora|pastor|cantor|atriz|ator|bispo|mission[aá]ri[oa])\s+([A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wÀ-ÿ'’.-]+(?:\s+[A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wÀ-ÿ'’.-]+){0,3})/i
  ) || corpoOrig.match(
    /(?:pastora|pastor|cantor|atriz|ator|bispo)\s+([A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wÀ-ÿ'’.-]+(?:\s+[A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wÀ-ÿ'’.-]+){0,3})/i
  );
  const pessoa = pessoaMatch?.[1]?.trim() || null;
  const falaChave = aspas[0] || null;

  const { coletarFontesComplementares, apurarTopico } = require('./articleSource');
  let fontesExtras = [];
  const queries = [
    pessoa && falaChave ? `${pessoa} ${falaChave.slice(0, 60)}` : null,
    pessoa ? `${pessoa} declaração igreja política` : null,
    `${tituloOrig}`.slice(0, 100),
  ].filter(Boolean);

  for (const q of queries.slice(0, 2)) {
    try {
      const mais = await coletarFontesComplementares({
        titulo: q,
        resumo: corpoOrig.slice(0, 180),
        linkExcluir: matter.fonte_url,
        max: 3,
      });
      fontesExtras = [...fontesExtras, ...mais];
    } catch (err) {
      console.warn('gerarVariacaoDeMateria Brave:', err.message);
    }
  }
  // Dedup por URL
  const vistos = new Set();
  fontesExtras = fontesExtras.filter((f) => {
    const k = String(f.url || f.titulo || '').toLowerCase();
    if (!k || vistos.has(k)) return false;
    vistos.add(k);
    return true;
  }).slice(0, 5);

  const blocoExtras = fontesExtras
    .map(
      (f, i) =>
        `Fonte nova ${i + 1} (${f.veiculo || 'Web'}): ${f.titulo || ''}\n${String(f.trecho || f.resumo || '').slice(0, 1400)}`
    )
    .join('\n\n');

  const angulos = [
    pessoa
      ? `Por que ${pessoa} afirmou isso? Explique o motivo e o contexto da declaração.`
      : 'Por que essa declaração gerou repercussão? Foque no motivo e no contexto.',
    pessoa
      ? `O detalhe da fala de ${pessoa} que mais chamou atenção — e o que isso muda para o fiel.`
      : 'O detalhe da declaração que mais gerou debate nas redes.',
    'Qual o impacto espiritual e político dessa fala em ano eleitoral — sem partidarizar a fé.',
  ];
  const anguloEscolhido = angulos[Math.floor(Math.random() * angulos.length)];

  const topicoBase = {
    // Título-seed só para apuração; a IA deve inventar manchete curiosa
    titulo: pessoa
      ? `${pessoa} declaração polêmica igreja`
      : tituloOrig.slice(0, 80),
    link: matter.fonte_url || null,
    resumo: [
      `Fato central: ${tituloOrig}`,
      falaChave ? `Fala documentada: "${falaChave}"` : null,
      `Ângulo pedido para ESTA variação: ${anguloEscolhido}`,
    ]
      .filter(Boolean)
      .join(' · ')
      .slice(0, 500),
    fonte: matter.fonte_titulo || null,
    veiculo: null,
    imagemFonte:
      matter.imagem_fonte_url ||
      (matter.imagem_url && /^https?:\/\//i.test(matter.imagem_url) ? matter.imagem_url : null),
    nicho: 'variação viral curiosidade',
    contextoApuracao: [
      `MODO: segunda matéria no mesmo tema (post viral). NÃO copie a primeira.`,
      `ÂNGULO OBRIGATÓRIO DESTA VERSÃO: ${anguloEscolhido}`,
      `Título da matéria anterior (NÃO repetir): ${tituloOrig}`,
      falaChave ? `Aspas reais a preservar (curtas): "${falaChave}"` : null,
      `Fatos da matéria anterior (só referência, reescreva tudo):\n${corpoOrig.slice(0, 900)}`,
      blocoExtras
        ? `NOVAS INFORMAÇÕES DA INTERNET (priorizar no lead se forem relevantes):\n${blocoExtras}`
        : 'Sem fontes novas na busca — mude o ÂNGULO (curiosidade/motivo/impacto), sem inventar fatos.',
      'Título final deve causar curiosidade (por que / o que / o detalhe / afirmação que…).',
      'Corpo: outra ordem de ideias; lead de curiosidade; desenvolvimento; fechamento de fé.',
    ]
      .filter(Boolean)
      .join('\n\n'),
    fontesApuracao: fontesExtras,
    furoReportagem: true,
    traduzirFonte: true,
    idiomaObrigatorio: 'pt-BR',
  };

  let apurado = topicoBase;
  try {
    apurado = await apurarTopico(topicoBase);
    apurado.contextoApuracao = [
      topicoBase.contextoApuracao,
      apurado.contextoApuracao && apurado.contextoApuracao !== topicoBase.contextoApuracao
        ? apurado.contextoApuracao
        : null,
    ]
      .filter(Boolean)
      .join('\n\n');
    // Não deixar a apuração substituir o ângulo pelo título antigo
    apurado.titulo = topicoBase.titulo;
    apurado.resumo = topicoBase.resumo;
  } catch (err) {
    console.warn('gerarVariacaoDeMateria apurar:', err.message);
  }

  const result = await gerarCompleto({
    userId,
    topico: apurado,
    facebookPageId: pageId,
    tipoPublicacao: tipo,
    status: 'rascunho',
    furoReportagem: true,
    variacaoViral: true,
    textoEvitar: `${tituloOrig}\n\n${corpoOrig}`.slice(0, 2500),
  });

  return {
    ...result,
    origemMatterId: matter.id,
    fontesNovas: fontesExtras.length,
    angulo: anguloEscolhido,
  };
}

/**
 * Matéria manual: usuário informa fatos (+ imagem opcional) → IA gera título/legenda + capa Minha marca.
 */
async function gerarMateriaManual({
  userId,
  informacoes,
  angulo = null,
  tom = 'natural',
  facebookPageId = null,
  imagemBuffer = null,
  imagemUrl = null,
  creditoImagem = null,
}) {
  assertDeepseek();
  const fatos = String(informacoes || '').trim();
  if (fatos.length < 20) {
    const err = new Error('Descreva as informações da matéria (mín. ~20 caracteres)');
    err.status = 400;
    throw err;
  }

  const pageId = facebookPageId || null;
  if (pageId) {
    const page = await resolvePage(userId, pageId);
    if (!page) {
      const err = new Error('Página do Facebook inválida');
      err.status = 400;
      throw err;
    }
  }

  const { gerarMateriaImagem } = require('./deepseekService');
  const {
    anexarCreditosFontes,
    estiloCreditoDaPagina,
    removerFechamentoOracao,
  } = require('./editorialGuidelinesFb');

  const gerado = await gerarMateriaImagem({
    informacoes: fatos,
    promptUsuario: angulo || 'notícia gospel a partir das informações do usuário',
    descricaoImagem: null,
    autor: creditoImagem || null,
    tom,
  });

  let pageName = null;
  if (pageId) {
    try {
      const page = await FacebookPages.findById(pageId);
      pageName = page?.page_name || null;
    } catch {
      /* ignore */
    }
  }
  const estilo = estiloCreditoDaPagina(pageName);
  const nomeConteudo = String(pageName || '').trim() || 'Informações do editor';
  const materiaComFontes = removerFechamentoOracao(
    anexarCreditosFontes(gerado.materia, {
      fonteNome: nomeConteudo,
      fonteUrl: null,
      imagemAutor: creditoImagem || 'Reprodução/Internet',
      autorArtigo: null,
      estilo,
    })
  );

  const [matterId] = await AiMatters.create({
    user_id: userId,
    facebook_page_id: pageId || null,
    titulo: gerado.titulo || 'Matéria manual',
    materia: materiaComFontes,
    titulo_ia: gerado.titulo || null,
    materia_ia: materiaComFontes,
    hashtags: JSON.stringify(gerado.hashtags || []),
    fonte_titulo: 'Matéria manual',
    fonte_url: null,
    fonte_resumo: fatos.slice(0, 1500),
    fonte_credito: null,
    status: 'rascunho',
    tipo_publicacao: 'foto',
    imagem_url: imagemUrl && /^https?:\/\//i.test(imagemUrl) ? imagemUrl : null,
    error_message: null,
  });

  let matter = await AiMatters.findById(matterId);
  const { storeMatterSourceImage, composeMatterArtwork } = require('./matterArtworkService');

  if (imagemBuffer && Buffer.isBuffer(imagemBuffer) && imagemBuffer.length) {
    const stored = await storeMatterSourceImage({
      userId,
      matterId,
      buffer: imagemBuffer,
    });
    const artwork = await composeMatterArtwork({
      userId,
      matterId,
      sourceUrl: stored.publicUrl,
      title: matter.titulo,
      force: true,
    });
    matter = artwork.matter;
  } else if (imagemUrl && /^https?:\/\//i.test(imagemUrl)) {
    try {
      const artwork = await composeMatterArtwork({
        userId,
        matterId,
        sourceUrl: imagemUrl,
        title: matter.titulo,
        force: true,
      });
      matter = artwork.matter;
    } catch (err) {
      console.warn('gerarMateriaManual arte URL:', err.message);
      await AiMatters.update(matterId, {
        imagem_url: imagemUrl,
        imagem_fonte_url: imagemUrl,
        error_message: `Arte: ${String(err.message).slice(0, 200)}`,
      });
      matter = await AiMatters.findById(matterId);
    }
  }

  return {
    matter,
    artigo: {
      titulo: matter.titulo,
      materia: matter.materia,
      hashtags: gerado.hashtags || [],
      imagemUrl: matter.imagem_url,
    },
    avisos: !matter.imagem_path && !matter.imagem_url
      ? ['Matéria gerada sem capa. Envie uma imagem na edição para criar a arte.']
      : [],
  };
}

/**
 * Atualiza engajamento do post Facebook ligado à matéria (views + curtidas + comentários).
 * 1) Graph OAuth (Insights + reactions/comments) quando a Página tem token.
 * 2) Fallback ScrapeCreators no permalink público (sem OAuth).
 */
async function atualizarViewsDaMateria(userId, matterId, { force = false } = {}) {
  const matter = await AiMatters.findById(matterId);
  if (!matter || Number(matter.user_id) !== Number(userId)) {
    const err = new Error('Matéria não encontrada');
    err.status = 404;
    throw err;
  }
  if (!matter.publication_id) {
    return { views: null, likes: null, comments: null, message: 'Matéria ainda sem publicação no Facebook' };
  }

  const pub = await Publications.findById(matter.publication_id);
  if (!pub) {
    return { views: null, likes: null, comments: null, message: 'Publicação não encontrada' };
  }

  const STALE_MS = 30 * 60 * 1000;
  const STALE_ZERO_MS = 5 * 60 * 1000;
  // Só considera "tem engajamento" se pelo menos um valor foi gravado (inclui 0 real).
  // Antes Number(null) na UI fingia 0 e o cache de zeros impedia nova leitura.
  const hasEng =
    pub.fb_likes != null || pub.fb_comments != null || pub.fb_views != null;
  const allZero =
    (pub.fb_likes == null || Number(pub.fb_likes) === 0) &&
    (pub.fb_comments == null || Number(pub.fb_comments) === 0) &&
    (pub.fb_views == null || Number(pub.fb_views) === 0);
  const staleLimit = allZero ? STALE_ZERO_MS : STALE_MS;
  if (
    !force &&
    hasEng &&
    pub.fb_views_at &&
    Date.now() - new Date(pub.fb_views_at).getTime() < staleLimit
  ) {
    return {
      views: pub.fb_views != null ? Number(pub.fb_views) : null,
      likes: pub.fb_likes != null ? Number(pub.fb_likes) : null,
      comments: pub.fb_comments != null ? Number(pub.fb_comments) : null,
      shares: pub.fb_shares != null ? Number(pub.fb_shares) : null,
      cached: true,
      viewsAt: pub.fb_views_at,
      postId: pub.fb_native_post_id || pub.fb_post_id,
      viral: classificarViral(pub),
    };
  }

  const page = await resolvePage(userId, pub.facebook_page_id || matter.facebook_page_id);
  const token = String(page?.page_access_token || '');
  const hasGraphToken =
    Boolean(token) &&
    !token.startsWith('postsyncer:') &&
    !token.startsWith('postpulse:') &&
    !token.startsWith('ayrshare:');

  const ayrshareService = require('./ayrshareService');
  const profileKey = String(page?.ayrshare_profile_key || '').trim() || null;

  let nativeId =
    pub.fb_native_post_id ||
    facebookService.parseFacebookPostId(pub.fb_post_url) ||
    facebookService.parseFacebookPostId(pub.fb_post_id);

  const fbPostId = String(pub.fb_post_id || '');
  if (!nativeId && /^postsyncer:/i.test(fbPostId)) {
    try {
      const postsyncerService = require('./postsyncerService');
      const psPost = await postsyncerService.getPost(fbPostId);
      const summary = postsyncerService.platformStatusSummary(psPost);
      nativeId =
        facebookService.parseFacebookPostId(summary.postedOn) ||
        facebookService.parseFacebookPostId(psPost?.permalink) ||
        facebookService.parseFacebookPostId(psPost?.url) ||
        null;
      if (nativeId) {
        await Publications.update(pub.id, { fb_native_post_id: nativeId });
      }
    } catch (err) {
      console.warn('atualizarEngajamento PostSyncer:', err.message);
    }
  }

  // UUID Ayrshare não é ID do Graph — limpa nativeId falso
  if (nativeId && ayrshareService.looksLikeAyrshareId(nativeId)) {
    nativeId = null;
  }

  let views = pub.fb_views != null ? Number(pub.fb_views) : null;
  let likes = pub.fb_likes != null ? Number(pub.fb_likes) : null;
  let comments = pub.fb_comments != null ? Number(pub.fb_comments) : null;
  let shares = pub.fb_shares != null ? Number(pub.fb_shares) : null;
  let fonte = null;
  const avisos = [];

  // 1) Graph API
  if (
    hasGraphToken &&
    nativeId &&
    !/^postsyncer:/i.test(String(nativeId)) &&
    !/^postpulse:/i.test(String(nativeId)) &&
    !/^ayrshare:/i.test(String(nativeId))
  ) {
    let insightId = nativeId;
    if (/^\d+$/.test(nativeId) && page.page_id) {
      insightId = `${page.page_id}_${nativeId}`;
    }

    try {
      let eng = await facebookService.fetchPostEngagement(page.page_access_token, insightId);
      if (eng.likes == null && eng.comments == null && insightId !== nativeId) {
        eng = await facebookService.fetchPostEngagement(page.page_access_token, nativeId);
      }
      if (eng.likes != null) likes = eng.likes;
      if (eng.comments != null) comments = eng.comments;
      if (eng.shares != null) shares = eng.shares;
      if (eng.postId) nativeId = eng.postId;
      fonte = 'graph';
    } catch (err) {
      avisos.push(`Graph engajamento: ${err.message}`);
    }

    try {
      let result = await facebookService.fetchPostViews(page.page_access_token, insightId);
      if (result.views == null && insightId !== nativeId) {
        result = await facebookService.fetchPostViews(page.page_access_token, nativeId);
      }
      if (result.views != null) views = result.views;
      if (result.postId) nativeId = result.postId;
      fonte = fonte || 'graph';
    } catch (err) {
      avisos.push(`Graph views: ${err.message}`);
    }
  } else if (!hasGraphToken) {
    avisos.push(
      'Sem token OAuth da Página — tentando Ayrshare/ScrapeCreators.'
    );
  }

  // 2) Ayrshare analytics (posts publicados via Ayrshare ou quando Graph falhou)
  const allZerado =
    (likes == null || Number(likes) === 0) &&
    (comments == null || Number(comments) === 0) &&
    (views == null || Number(views) === 0);
  const precisaEngAyr =
    force ||
    likes == null ||
    comments == null ||
    views == null ||
    (fonte === 'graph' && allZerado) ||
    (fonte !== 'graph' && allZerado);
  if (precisaEngAyr && ayrshareService.isConfigured()) {
    const candidates = [];
    const pushCand = (id, searchPlatformId) => {
      const s = String(id || '').trim();
      if (!s) return;
      if (candidates.some((c) => c.id === s && c.searchPlatformId === searchPlatformId)) return;
      candidates.push({ id: s, searchPlatformId: Boolean(searchPlatformId) });
    };

    // Preferir ID Ayrshare (UUID) — analytics mais estável
    if (ayrshareService.looksLikeAyrshareId(fbPostId)) {
      pushCand(fbPostId, false);
    }
    if (ayrshareService.looksLikeAyrshareId(pub.fb_native_post_id)) {
      pushCand(pub.fb_native_post_id, false);
    }
    // ID nativo Facebook (pageId_postId)
    const nativeForAy = nativeId || pub.fb_native_post_id || null;
    if (nativeForAy && /^\d+_\d+$/.test(String(nativeForAy))) {
      pushCand(nativeForAy, true);
    } else if (nativeForAy && /^\d+$/.test(String(nativeForAy)) && page?.page_id) {
      pushCand(`${page.page_id}_${nativeForAy}`, true);
    }
    if (/^\d+_\d+$/.test(fbPostId)) {
      pushCand(fbPostId, true);
    }
    const parsedUrl = facebookService.parseFacebookPostId(pub.fb_post_url);
    if (parsedUrl && /^\d+_\d+$/.test(parsedUrl)) {
      pushCand(parsedUrl, true);
    } else if (parsedUrl && page?.page_id && /^\d+$/.test(parsedUrl)) {
      pushCand(`${page.page_id}_${parsedUrl}`, true);
    }

    if (!candidates.length) {
      avisos.push(
        'Sem ID Ayrshare/Facebook para analytics. Republish ou confira o Profile Key em /paginas.'
      );
    }

    const applyAy = (ay) => {
      // Sobrescreve nulls e zeros (Graph sem permissão costuma devolver 0)
      if (ay.likes != null && (likes == null || force || Number(likes) === 0)) likes = ay.likes;
      if (ay.comments != null && (comments == null || force || Number(comments) === 0)) {
        comments = ay.comments;
      }
      if (ay.shares != null && (shares == null || force || Number(shares) === 0)) shares = ay.shares;
      if (ay.views != null && (views == null || force || Number(views) === 0)) views = ay.views;
    };

    for (const cand of candidates) {
      try {
        const ay = await ayrshareService.fetchFacebookPostAnalytics({
          postId: cand.id,
          profileKey,
          searchPlatformId: cand.searchPlatformId,
        });
        applyAy(ay);
        if (ay.postId && !ayrshareService.looksLikeAyrshareId(ay.postId)) {
          nativeId = ay.postId;
        }
        if (ay.postUrl && !pub.fb_post_url) {
          await Publications.update(pub.id, { fb_post_url: ay.postUrl });
          pub.fb_post_url = ay.postUrl;
        }
        if (ay.likes != null || ay.comments != null || ay.views != null) {
          fonte = fonte && fonte !== 'graph' ? `${fonte}+ayrshare` : 'ayrshare';
          break;
        }
      } catch (err) {
        avisos.push(`Ayrshare analytics: ${err.message}`);
      }
    }

    // Sem Profile Key em User Profile → analytics não acha o post
    if (
      !profileKey &&
      (likes == null || comments == null) &&
      candidates.length
    ) {
      avisos.push(
        'Página sem Profile Key Ayrshare — cole em /paginas o Profile Key desta Página para ler curtidas.'
      );
    }
  }

  // 3) ScrapeCreators fallback (curtidas/comentários no permalink)
  const precisaEng = likes == null || comments == null || force;
  const permalink =
    pub.fb_post_url ||
    (nativeId && String(nativeId).includes('_')
      ? `https://www.facebook.com/${String(nativeId).replace('_', '/posts/')}`
      : nativeId && page?.page_id
        ? `https://www.facebook.com/${page.page_id}/posts/${nativeId}`
        : null);

  if (precisaEng && permalink) {
    try {
      const scrapeCreators = require('./scrapeCreatorsSocial');
      if (scrapeCreators.isConfigured()) {
        const sc = await scrapeCreators.extrairPost(permalink, 'facebook');
        if (sc?.likes != null && (likes == null || force)) likes = Number(sc.likes) || 0;
        if (sc?.comments != null && (comments == null || force)) comments = Number(sc.comments) || 0;
        if (sc?.shares != null && (shares == null || force)) shares = Number(sc.shares) || 0;
        fonte = fonte ? `${fonte}+scrapecreators` : 'scrapecreators';
      } else {
        avisos.push('SCRAPECREATORS_API_KEY não configurada para fallback de engajamento.');
      }
    } catch (err) {
      avisos.push(`ScrapeCreators: ${err.message}`);
    }
  }

  const patch = {
    fb_views_at: db.fn.now(),
  };
  if (views != null) patch.fb_views = views;
  if (likes != null) patch.fb_likes = likes;
  if (comments != null) patch.fb_comments = comments;
  if (shares != null) patch.fb_shares = shares;
  if (
    nativeId &&
    !/^postsyncer:/i.test(String(nativeId)) &&
    !/^ayrshare:/i.test(String(nativeId)) &&
    !ayrshareService.looksLikeAyrshareId(nativeId)
  ) {
    patch.fb_native_post_id = nativeId;
  }

  if (Object.keys(patch).length > 1) {
    await Publications.update(pub.id, patch);
  }

  const updated = await Publications.findById(pub.id);
  const payload = {
    views: updated.fb_views != null ? Number(updated.fb_views) : null,
    likes: updated.fb_likes != null ? Number(updated.fb_likes) : null,
    comments: updated.fb_comments != null ? Number(updated.fb_comments) : null,
    shares: updated.fb_shares != null ? Number(updated.fb_shares) : null,
    viewsAt: updated.fb_views_at,
    postId: updated.fb_native_post_id || nativeId,
    fonte,
    viral: classificarViral(updated),
    avisos,
  };

  if (payload.likes == null && payload.comments == null && payload.views == null) {
    payload.message =
      avisos[0] ||
      'Não foi possível ler o engajamento. Confira o Profile Key Ayrshare em /paginas ou o link do post.';
    payload.needsOauth = !hasGraphToken;
  }

  return payload;
}

function classificarViral(pub) {
  const likes = Number(pub?.fb_likes) || 0;
  const comments = Number(pub?.fb_comments) || 0;
  const shares = Number(pub?.fb_shares) || 0;
  const views = Number(pub?.fb_views) || 0;
  const score = likes + comments * 3 + shares * 5 + Math.min(views, 5000) / 50;
  // Ajustado p/ páginas gospel/mid-size (antes: 400 / 200 / 50 — quase ninguém entrava)
  if (score >= 180 || likes >= 80 || comments >= 25) {
    return { nivel: 'alto', label: 'Viralizou', score: Math.round(score) };
  }
  if (score >= 80 || likes >= 40 || comments >= 10) {
    return { nivel: 'medio', label: 'Bom engajamento', score: Math.round(score) };
  }
  if (likes > 0 || comments > 0 || views > 0) {
    return { nivel: 'baixo', label: 'Baixo', score: Math.round(score) };
  }
  return { nivel: 'desconhecido', label: 'Sem dado', score: 0 };
}

/** True se entra na aba Viralizou (Bom + Viralizou). */
function isDestaqueEngajamento(pubOrViral) {
  if (pubOrViral?.nivel) {
    return pubOrViral.nivel === 'alto' || pubOrViral.nivel === 'medio';
  }
  const v = classificarViral(pubOrViral);
  return v.nivel === 'alto' || v.nivel === 'medio';
}

/**
 * Sincroniza curtidas/comentários/views das publicações recentes (cache 30 min).
 * Necessário para a aba Viralizou enxergar posts que ainda não tinham dado no banco.
 */
async function sincronizarEngajamentoRecentes(userId, { limit = 30, concurrency = 3 } = {}) {
  const matters = await AiMatters.findRecentPublishedForSync(userId, limit);
  if (!matters.length) {
    return { checked: 0, updated: 0, destaques: 0, items: [] };
  }

  const items = [];
  let cursor = 0;

  async function worker() {
    while (cursor < matters.length) {
      const idx = cursor++;
      const m = matters[idx];
      try {
        const r = await atualizarViewsDaMateria(userId, m.id, { force: false });
        const destaque = isDestaqueEngajamento(r.viral || r);
        items[idx] = {
          matterId: m.id,
          likes: r.likes,
          comments: r.comments,
          views: r.views,
          viral: r.viral || null,
          cached: Boolean(r.cached),
          destaque,
        };
      } catch (err) {
        items[idx] = { matterId: m.id, error: err.message, destaque: false };
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, matters.length) }, () => worker());
  await Promise.all(workers);

  const ok = items.filter((i) => i && !i.error);
  return {
    checked: matters.length,
    updated: ok.filter((i) => !i.cached).length,
    destaques: ok.filter((i) => i.destaque).length,
    items: ok,
  };
}

/**
 * Enriquece matéria buscando reportagens com o MESMO pipeline de /conteudo
 * (Google News + Brave News via pesquisarNichos) e incorpora só fatos sem plágio.
 */
async function enriquecerMateriaComWeb({
  userId,
  matterId,
  tituloAtual = null,
  materiaAtual = null,
  palavrasChave = null,
  periodo = '180d',
} = {}) {
  const deepseekService = require('./deepseekService');
  deepseekService.assertDeepseek();

  const matter = await AiMatters.findById(matterId);
  if (!matter || Number(matter.user_id) !== Number(userId)) {
    const err = new Error('Matéria não encontrada');
    err.status = 404;
    throw err;
  }
  if (matter.status === 'publicado') {
    const err = new Error('Matéria já publicada. Gere uma nova se precisar enriquecer o texto.');
    err.status = 400;
    throw err;
  }

  const titulo = String(tituloAtual || matter.titulo || '').trim();
  const materia = String(materiaAtual || matter.materia || '').trim();
  if (!materia) {
    const err = new Error('Não há texto na matéria para enriquecer.');
    err.status = 400;
    throw err;
  }

  const { coletarFontesComplementares, extrairMetadadosArtigo } = require('./articleSource');
  const { pesquisarNichos, titulosSimilares, buscarBraveNews, buscarGoogleNewsRss, whenParaGoogle } = require('./newsResearch');

  const stop = new Set([
    'para', 'com', 'sobre', 'apos', 'após', 'durante', 'sendo', 'filmada', 'filmado',
    'confusao', 'confusão', 'entre', 'pela', 'pelo', 'pelos', 'pelas', 'uma', 'uns',
    'umas', 'este', 'esta', 'esse', 'essa', 'aquele', 'aquela', 'como', 'mais', 'menos',
    'muito', 'muita', 'quando', 'onde', 'quais', 'qual', 'quem', 'porque', 'porquê',
    'ainda', 'tambem', 'também', 'depois', 'antes', 'agora', 'hoje', 'ontem',
  ]);

  function keywordsDoTitulo(t) {
    return String(t || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .map((w) => w.trim())
      .filter((w) => w.length > 3 && !stop.has(w.toLowerCase()))
      .slice(0, 7)
      .join(' ');
  }

  const queryManual = String(palavrasChave || '').trim();
  const queryTitulo = keywordsDoTitulo(titulo) || titulo.slice(0, 100);
  const queries = [queryManual, queryTitulo, titulo.slice(0, 120)]
    .map((q) => String(q || '').replace(/\s+/g, ' ').trim())
    .filter((q, i, arr) => q.length >= 8 && arr.indexOf(q) === i);

  function normalizarUrl(url) {
    try {
      const u = new URL(String(url || '').trim());
      u.hash = '';
      return u.href.replace(/\/$/, '').toLowerCase();
    } catch {
      return String(url || '')
        .split(/[?#]/)[0]
        .replace(/\/$/, '')
        .toLowerCase();
    }
  }

  const excluirUrl = normalizarUrl(matter.fonte_url);
  const fontes = [];
  const vistosUrl = new Set(excluirUrl ? [excluirUrl] : []);
  const vistosTitulo = [];

  function adicionarFonte(f) {
    if (!f) return;
    const urlKey = normalizarUrl(f.url || f.link);
    if (urlKey && vistosUrl.has(urlKey)) return;
    const tit = String(f.titulo || '').trim();
    if (tit && vistosTitulo.some((x) => titulosSimilares(x, tit))) return;
    const trecho = String(f.trecho || f.contextoApuracao || f.resumo || f.snippet || '').trim();
    if (trecho.length < 40) return;
    if (urlKey) vistosUrl.add(urlKey);
    if (tit) vistosTitulo.push(tit);
    fontes.push({
      veiculo: f.veiculo || f.fonte || 'Web',
      url: f.url || f.link || null,
      titulo: tit || queryTitulo,
      resumo: String(f.resumo || '').slice(0, 500),
      trecho: trecho.slice(0, 2500),
    });
  }

  // 1) Mesmas fontes de /conteudo (Google News + Brave), sem apurar tudo (mais rápido)
  for (const q of queries.slice(0, 2)) {
    if (fontes.length >= 5) break;
    try {
      const when = whenParaGoogle(periodo || '180d');
      const encontrados = [
        ...(await buscarGoogleNewsRss(q, { when })),
        ...(await buscarBraveNews(q, 180)),
      ];
      for (const t of encontrados.slice(0, 12)) {
        if (fontes.length >= 5) break;
        const url = t.link;
        if (!url || normalizarUrl(url) === excluirUrl) continue;
        let meta = null;
        try {
          meta = await extrairMetadadosArtigo(url);
        } catch {
          /* ignore */
        }
        adicionarFonte({
          titulo: meta?.titulo || t.titulo,
          url: meta?.url || url,
          veiculo: meta?.veiculo || t.veiculo || t.fonte,
          resumo: meta?.resumo || t.resumo,
          trecho: meta?.trecho || t.resumo,
        });
      }
    } catch (err) {
      console.warn('[enriquecer] busca noticias:', err.message);
    }
  }

  // 1b) Se ainda vazio, pipeline completo (com apuração) como em Pautas com IA
  if (!fontes.length && queries[0]) {
    try {
      const topicos = await pesquisarNichos(queries[0], 6, {
        periodo: periodo || '180d',
        incluirRedesSociais: false,
        filtrarPeriodo: true,
      });
      for (const t of topicos || []) {
        if (fontes.length >= 5) break;
        const fontesAp = Array.isArray(t.fontesApuracao) ? t.fontesApuracao : [];
        if (fontesAp.length) {
          for (const fa of fontesAp) adicionarFonte(fa);
        } else {
          adicionarFonte({
            titulo: t.titulo,
            link: t.link,
            veiculo: t.veiculo || t.fonte,
            resumo: t.resumo,
            trecho: t.contextoApuracao || t.resumo,
          });
        }
      }
    } catch (err) {
      console.warn('[enriquecer] pesquisarNichos:', err.message);
    }
  }

  // 2) Fallback: busca complementar (Brave/Serper + scrape)
  if (fontes.length < 2) {
    for (const q of queries.slice(0, 2)) {
      try {
        const mais = await coletarFontesComplementares({
          titulo: q,
          resumo: materia.replace(/\s+/g, ' ').trim().slice(0, 160),
          linkExcluir: matter.fonte_url,
          max: 4,
        });
        for (const f of mais) adicionarFonte(f);
      } catch (err) {
        console.warn('[enriquecer] complementares:', err.message);
      }
    }
  }

  // 3) Snippets brutos se ainda faltar volume
  if (fontes.length < 2 && queries[0]) {
    try {
      const when = whenParaGoogle(periodo || '180d');
      const brutos = [
        ...(await buscarBraveNews(queries[0], 180)),
        ...(await buscarGoogleNewsRss(queries[0], { when })),
      ];
      for (const r of brutos.slice(0, 10)) {
        if (fontes.length >= 5) break;
        const url = r.link;
        if (!url || normalizarUrl(url) === excluirUrl) continue;
        let meta = null;
        try {
          meta = await extrairMetadadosArtigo(url);
        } catch {
          /* ignore */
        }
        adicionarFonte({
          titulo: meta?.titulo || r.titulo,
          url: meta?.url || url,
          veiculo: meta?.veiculo || r.veiculo || r.fonte,
          resumo: meta?.resumo || r.resumo,
          trecho: meta?.trecho || r.resumo,
        });
      }
    } catch (err) {
      console.warn('[enriquecer] fallback bruto:', err.message);
    }
  }

  const fontesFinais = fontes.slice(0, 5);

  if (!fontesFinais.length) {
    const err = new Error(
      'Não encontramos outras reportagens úteis. Ajuste as palavras-chave (como em Pautas com IA) ou cole infos manuais abaixo.'
    );
    err.status = 422;
    throw err;
  }

  const blocoFatos = fontesFinais
    .map(
      (f, i) =>
        `Fonte ${i + 1} — ${f.veiculo || 'Web'}${f.url ? ` (${f.url})` : ''}\nTítulo: ${f.titulo || ''}\nTrecho factual:\n${String(f.trecho || f.resumo || '').slice(0, 1800)}`
    )
    .join('\n\n---\n\n');

  let hashtags = [];
  try {
    hashtags = Array.isArray(matter.hashtags)
      ? matter.hashtags
      : JSON.parse(matter.hashtags || '[]');
  } catch {
    hashtags = [];
  }

  const reescrito = await deepseekService.enriquecerMateriaComFatos({
    titulo,
    materia,
    fatosFontes: blocoFatos,
    hashtags,
    fonteTitulo: matter.fonte_titulo,
  });

  const patch = {
    titulo: reescrito.titulo,
    materia: reescrito.materia,
    titulo_ia: reescrito.titulo,
    materia_ia: reescrito.materia,
    hashtags: JSON.stringify(reescrito.hashtags || []),
    error_message: null,
  };
  if (matter.status !== 'agendado') patch.status = 'rascunho';
  await AiMatters.update(matterId, patch);

  let updated = await AiMatters.findById(matterId);
  let imagemUrl = updated.imagem_url || null;
  let videoUrl = null;
  let aviso = `Texto enriquecido com fatos de ${fontesFinais.length} fonte(s) — mesma busca de Pautas com IA ✓`;

  const titleChanged =
    String(reescrito.titulo || '').trim() !== String(matter.titulo || '').trim();

  if (titleChanged && updated.tipo_publicacao === 'reel' && updated.video_clip_id) {
    try {
      const { applyCoverToClipNow } = require('./clipPostProcessService');
      await applyCoverToClipNow({
        clipId: updated.video_clip_id,
        userId,
        titulo: reescrito.titulo,
        force: true,
      });
      updated = await AiMatters.findById(matterId);
      if (updated.video_path) {
        videoUrl = `/media/${String(updated.video_path).replace(/\\/g, '/')}`;
      }
      aviso += ' Capa do Reel atualizada.';
    } catch (err) {
      console.warn('[enriquecer] capa reel:', err.message);
    }
  } else if (titleChanged) {
    const sourceUrl =
      updated.imagem_fonte_url ||
      (!updated.imagem_path && /^https?:\/\//i.test(String(updated.imagem_url || ''))
        ? updated.imagem_url
        : null);
    if (sourceUrl) {
      try {
        const { composeMatterArtwork } = require('./matterArtworkService');
        const artwork = await composeMatterArtwork({
          userId,
          matterId: updated.id,
          sourceUrl,
          title: reescrito.titulo,
          force: true,
        });
        updated = artwork.matter || (await AiMatters.findById(matterId));
        if (artwork.publicUrl) imagemUrl = artwork.publicUrl;
        aviso += ' Arte regenerada.';
      } catch (err) {
        console.warn('[enriquecer] arte:', err.message);
      }
    }
  }

  return {
    matter: updated,
    titulo: reescrito.titulo,
    materia: reescrito.materia,
    hashtags: reescrito.hashtags,
    fatosUsados: reescrito.fatosUsados || [],
    fontes: fontesFinais.map((f) => ({
      veiculo: f.veiculo,
      titulo: f.titulo,
      url: f.url,
    })),
    queryUsada: queries[0] || queryTitulo,
    imagemUrl,
    videoUrl,
    aviso,
  };
}

module.exports = {
  pesquisarNichos,
  buscarEmAltaAgora,
  marcarJaPublicados,
  gerarPreviewDeTopico,
  gerarCompleto,
  gerarDeLink,
  gerarVariacaoDeMateria,
  gerarMateriaManual,
  atualizarViewsDaMateria,
  sincronizarEngajamentoRecentes,
  classificarViral,
  syncConteudoReelMatter,
  limparTextoReelSocial,
  tituloCurtoReel,
  salvarMateria,
  publicarMateria,
  gerarEPublicarLote,
  criarMonitor,
  tickMonitores,
  agendarMateria,
  obterUltimoAgendamento,
  formatarHorarioAgendamento,
  toDatetimeLocalAraguaina,
  tickFilaJobs,
  resolvePage,
  enriquecerMateriaComWeb,
};
