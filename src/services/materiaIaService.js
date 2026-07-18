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
const { enqueue } = require('../workers/queue');
const { env } = require('../config/env');
const { titulosParecidos, formatFacebookCaption } = require('./editorialGuidelinesFb');
const { applyBrandArtworkToResult } = require('./matterArtworkService');

async function resolvePage(userId, facebookPageId) {
  const page = await FacebookPages.findById(facebookPageId);
  if (!page) return null;
  const account = await FacebookAccounts.findByUser(userId);
  if (!account || page.facebook_account_id !== account.id) return null;
  return page;
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

/** Legenda formatada para o Facebook (espaços, parágrafos, hashtags). */
function montarMensagem({ titulo, materia, hashtags }) {
  return formatFacebookCaption({
    titulo,
    materia,
    hashtags: parseHashtagsField(hashtags),
  });
}

/**
 * Checa duplicidade com matérias/publicações recentes da mesma página/usuário.
 */
async function checarDuplicidade({ userId, facebookPageId, titulo, materia }) {
  const avisos = [];
  const recentes = await AiMatters.findByUser(userId, 25);
  for (const m of recentes) {
    if (titulosParecidos(titulo, m.titulo) || titulosParecidos(materia?.slice(0, 180), m.materia?.slice(0, 180))) {
      avisos.push(`Possível duplicata de matéria #${m.id}: “${m.titulo || 'sem título'}”`);
      break;
    }
  }

  if (facebookPageId) {
    try {
      const pubs = await Publications.recent(userId, 20);
      for (const p of pubs) {
        const texto = p.texto || p.legenda_sugerida || '';
        if (titulosParecidos(titulo, texto.slice(0, 120))) {
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

  const matters = await AiMatters.findByUser(userId, 100);
  const urls = new Set();
  const titulos = [];
  for (const m of matters) {
    if (facebookPageId && m.facebook_page_id && Number(m.facebook_page_id) !== Number(facebookPageId)) {
      continue;
    }
    // Só marca o que realmente saiu (ou foi enfileirado) na Página
    if (m.status !== 'publicado' && !m.publication_id) continue;
    if (m.fonte_url) urls.add(String(m.fonte_url).split(/[?#]/)[0].toLowerCase());
    if (m.fonte_titulo) titulos.push(m.fonte_titulo);
    if (m.titulo) titulos.push(m.titulo);
  }

  return lista.map((t) => {
    const link = String(t.link || '')
      .split(/[?#]/)[0]
      .toLowerCase();
    const jaPorUrl = Boolean(link && urls.has(link));
    const jaPorTitulo = titulos.some((x) => titulosParecidos(t.titulo, x));
    return { ...t, jaPublicado: jaPorUrl || jaPorTitulo };
  });
}

async function gerarPreviewDeTopico(topico, { userId, facebookPageId, tipoPublicacao = 'texto', investigativa = false, furoReportagem = false } = {}) {
  assertDeepseek();
  const apurado = await apurarTopico(topico || {});
  const gerado = await gerarMateriaNoticiaFacebook({
    tituloReferencia: apurado.titulo,
    resumoReferencia: apurado.resumo,
    fonte: apurado.fonte || apurado.veiculo,
    nicho: apurado.nicho,
    contextoApuracao: apurado.contextoApuracao,
    fontesApuracao: apurado.fontesApuracao,
    dataReferencia: apurado.dataReferencia || apurado.data,
    emAlta: Boolean(apurado.emAlta || apurado.emAltaAgora),
    redeSocial: Boolean(apurado.redeSocial || apurado.tipoFonte === 'rede_social'),
    investigativa,
    furoReportagem,
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
    CREDITO_IMAGEM_FALLBACK,
  } = require('./editorialGuidelinesFb');
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

  const materiaComFontes = anexarCreditosFontes(gerado.materia, {
    fonteNome: apurado.fonte || apurado.veiculo || null,
    fonteUrl: apurado.link || null, // só para derivar o nome do site se faltar
    imagemAutor,
  });

  return {
    ...gerado,
    materia: materiaComFontes,
    imagemUrl,
    imagemOrigem,
    imagemAutor,
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
    hashtags: JSON.stringify(gerado.hashtags || []),
    fonte_titulo: topico?.titulo || null,
    fonte_url: topico?.link || null,
    fonte_resumo: topico?.resumo || null,
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
    materia: overrides.materia || matter.materia,
    hashtags: overrides.hashtags || matter.hashtags,
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
      // PostSyncer: settings.title sobrescreve a legenda — não enviar em Reels
      titulo: pubTipo === 'reel' ? null : overrides.titulo || matter.titulo || null,
    });

    const postId = result.post_id || result.id;
    const fbPostUrl = result.fb_post_url || publishDispatch.buildFbPostUrl(page, postId);
    await Publications.update(pubId, {
      status: 'publicado',
      fb_post_id: postId,
      fb_post_url: fbPostUrl,
      published_at: new Date(),
      erro_mensagem: null,
    });
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
      throw err;
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
      throw err;
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
}) {
  const tipo = tipoPublicacao === 'foto' ? 'foto' : 'texto';
  const gerado = await gerarPreviewDeTopico(topico, {
    userId,
    facebookPageId,
    tipoPublicacao: tipo,
    investigativa,
    furoReportagem,
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
  const [jobId] = await AiFilaJobs.create({
    user_id: userId,
    matter_id: matter.id,
    run_at: when,
    status: 'pendente',
    payload: JSON.stringify({ action: 'publish', matterId: matter.id }),
  });
  return { jobId, matterId: matter.id, runAt: when };
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

  const link = String(url || '').trim();
  const plataforma = detectarPlataformaSocial(link) || 'rede';

  let meta = {};
  let metaWarning = null;
  try {
    meta = await importService.fetchLinkMetadata(link);
  } catch (metaErr) {
    metaWarning = importService.humanizeYtDlpError(metaErr);
    console.warn('[conteudo-reel] metadata:', metaWarning);
    meta = { titulo: null, thumbnail: null, extractor: null, autor: null, autorUrl: null, duracao: null };
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
  } else if (/reaction|shares?/i.test(String(video.titulo || '')) || String(video.titulo || '').length > 120) {
    // Corrige título antigo longo/sujo sem recriar o vídeo
    const metaBase =
      video.metadata && typeof video.metadata === 'object' ? video.metadata : {};
    await Videos.update(video.id, {
      titulo,
      metadata: {
        ...metaBase,
        titulo_completo:
          metaBase.titulo_completo ||
          textoLimpo.slice(0, 2000) ||
          String(tituloBruto).slice(0, 2000),
      },
    });
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
      status: 'rascunho',
      tipo_publicacao: 'reel',
      imagem_url: meta.thumbnail || video.thumbnail || null,
      video_path: null,
      video_clip_id: null,
      error_message: null,
    });
    matter = await AiMatters.findById(matterId);
  } else {
    // Sempre normaliza título curto + limpa lixo de tentativas anteriores
    const patchLimpeza = {
      titulo,
      fonte_titulo: titulo,
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

    // Nunca gerar matéria social sem legenda real (evita alucinação)
    if (String(social.texto || '').trim().length < 60) {
      const err = new Error(
        'Não foi possível ler a legenda deste post. Cole o texto da postagem no campo auxiliar e tente de novo.'
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

module.exports = {
  pesquisarNichos,
  buscarEmAltaAgora,
  marcarJaPublicados,
  gerarPreviewDeTopico,
  gerarCompleto,
  gerarDeLink,
  syncConteudoReelMatter,
  limparTextoReelSocial,
  tituloCurtoReel,
  salvarMateria,
  publicarMateria,
  gerarEPublicarLote,
  criarMonitor,
  tickMonitores,
  agendarMateria,
  tickFilaJobs,
  resolvePage,
};
