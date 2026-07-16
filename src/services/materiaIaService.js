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
const { titulosParecidos } = require('./editorialGuidelinesFb');

async function resolvePage(userId, facebookPageId) {
  const page = await FacebookPages.findById(facebookPageId);
  if (!page) return null;
  const account = await FacebookAccounts.findByUser(userId);
  if (!account || page.facebook_account_id !== account.id) return null;
  return page;
}

function montarMensagem({ titulo, materia }) {
  const t = String(titulo || '').trim();
  const m = String(materia || '').trim();
  if (!t) return m;
  if (m.toLowerCase().startsWith(t.toLowerCase())) return m;
  return `${t}\n\n${m}`;
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

async function escolherImagemCapa(topico, gerado) {
  if (topico?.imagemFonte && /^https?:\/\//i.test(topico.imagemFonte)) {
    return topico.imagemFonte;
  }

  // A Pexels não é uma fonte editorial de pessoas públicas. Se a fonte original não
  // forneceu foto, não substitui Malafaia/Flávio Bolsonaro por igreja ou política genérica.
  if (pautaTemPessoaNomeada(topico, gerado)) return null;
  if (!env.pexelsApiKey) return null;

  try {
    const termo =
      (Array.isArray(gerado.termos_imagem) && gerado.termos_imagem[0]) ||
      (gerado.hashtags && gerado.hashtags[0]) ||
      topico?.nicho ||
      String(gerado.titulo || topico?.titulo || 'news').split(/\s+/).slice(0, 3).join(' ');
    const photos = await pexelsService.searchPhotos(termo, { perPage: 5 });
    const first = photos?.photos?.[0];
    return first?.urlOriginal || first?.thumbnail || null;
  } catch (err) {
    console.warn('escolherImagemCapa:', err.message);
    return null;
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

  const imagemUrl = await escolherImagemCapa(apurado, gerado);
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

  return {
    ...gerado,
    imagemUrl,
    imagemOrigem,
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
  const matter = await AiMatters.findById(matterId);
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

  const tipo = overrides.tipo_publicacao || matter.tipo_publicacao || 'texto';
  const mensagem = montarMensagem({
    titulo: overrides.titulo || matter.titulo,
    materia: overrides.materia || matter.materia,
  });

  if (!mensagem.trim()) {
    const err = new Error('Matéria vazia');
    err.status = 400;
    throw err;
  }

  const imagemUrl = overrides.imagem_url || matter.imagem_url;
  if (tipo === 'foto' && !imagemUrl) {
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
    // Aviso não bloqueia publicação manual, mas registra
    console.warn('[duplicidade]', avisosDup.join(' | '));
  }

  const [pubId] = await Publications.create({
    video_clip_id: null,
    imagem_id: null,
    facebook_page_id: page.id,
    tipo: tipo === 'foto' ? 'foto' : 'texto',
    status: 'pendente',
    texto: mensagem,
  });

  await AiMatters.update(matter.id, {
    facebook_page_id: page.id,
    tipo_publicacao: tipo === 'foto' ? 'foto' : 'texto',
    publication_id: pubId,
    status: 'pronto',
    error_message: null,
    titulo: overrides.titulo || matter.titulo,
    materia: overrides.materia || matter.materia,
  });

  const executarPublicacao = async () => {
    const publishDispatch = require('./publishDispatch');
    const img = overrides.imagem_url || matter.imagem_url;
    const result = await publishDispatch.publishContent({
      userId,
      page,
      tipo: tipo === 'foto' && img ? 'foto' : 'texto',
      imageUrl: tipo === 'foto' && img ? img : null,
      texto: mensagem,
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

  const payload = {
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

  const querPublicar = status === 'publicado' && !gerado.forcarRascunho && facebookPageId;
  if (querPublicar) {
    const pub = await publicarMateria(userId, matter.id, {
      facebook_page_id: facebookPageId,
      tipo_publicacao: tipo,
      imagem_url: gerado.imagemUrl,
      sync: true,
    });
    payload.publication = pub;
    payload.fbPostUrl = pub.fbPostUrl || null;
    payload.matter = await AiMatters.findById(matter.id);
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
  const when = new Date(runAt);
  if (Number.isNaN(when.getTime()) || when <= new Date()) {
    const err = new Error('Informe uma data/hora futura para agendar');
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

async function tickFilaJobs() {
  const jobs = await AiFilaJobs.findDue(5);
  for (const job of jobs) {
    await AiFilaJobs.update(job.id, { status: 'processando', attempts: Number(job.attempts || 0) + 1 });
    try {
      if (job.matter_id) {
        await publicarMateria(job.user_id, job.matter_id);
      }
      await AiFilaJobs.update(job.id, { status: 'feito', erro: null });
    } catch (err) {
      await AiFilaJobs.update(job.id, { status: 'erro', erro: String(err.message).slice(0, 500) });
    }
  }
}

/**
 * Usuário cola um link → apura a notícia → reescreve com furo (sem plagiar).
 */
async function gerarDeLink({
  userId,
  url,
  facebookPageId = null,
  tipoPublicacao = 'foto',
  status = 'rascunho',
}) {
  const link = String(url || '').trim();
  if (!/^https?:\/\//i.test(link)) {
    const err = new Error('Informe um link válido (http ou https)');
    err.status = 400;
    throw err;
  }

  assertDeepseek();

  const topicoBase = {
    link,
    titulo: null,
    resumo: null,
    fonte: null,
  };

  const apurado = await apurarTopico(topicoBase);
  const temConteudo =
    Boolean(apurado.titulo) ||
    Boolean(apurado.resumo) ||
    Boolean(apurado.fontesApuracao?.length) ||
    Boolean(apurado.contextoApuracao && apurado.contextoApuracao.length > 80);

  if (!temConteudo) {
    const err = new Error(
      'Não foi possível ler a notícia deste link. Confira o endereço ou tente outro veículo.'
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
    tipoPublicacao,
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
  salvarMateria,
  publicarMateria,
  gerarEPublicarLote,
  criarMonitor,
  tickMonitores,
  agendarMateria,
  tickFilaJobs,
  resolvePage,
};
