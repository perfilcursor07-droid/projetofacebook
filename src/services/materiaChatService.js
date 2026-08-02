const AiChats = require('../models/AiChats');
const AiChatMessages = require('../models/AiChatMessages');
const AiMatters = require('../models/AiMatters');

const PERIODOS = ['24h', '3d', '7d', '15d', '30d', '60d', '90d', '180d'];
const PERIODO_PADRAO = '7d';

function erro(mensagem, status = 400) {
  const err = new Error(mensagem);
  err.status = status;
  return err;
}

function parseJson(raw, fallback) {
  if (Array.isArray(raw) || (raw && typeof raw === 'object')) return raw;
  try {
    const parsed = JSON.parse(String(raw || ''));
    return parsed || fallback;
  } catch {
    return fallback;
  }
}

function tituloDaConversa(texto) {
  const t = String(texto || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return 'Nova conversa';
  return t.length > 70 ? `${t.slice(0, 70).trim()}…` : t;
}

/** URLs http(s) no pedido (remove pontuação final comum). */
function extrairUrlsDoTexto(texto) {
  const matches = String(texto || '').match(/https?:\/\/[^\s<>"'`)\]]+/gi) || [];
  const vistos = new Set();
  const urls = [];
  for (const raw of matches) {
    const limpa = String(raw).replace(/[.,;:!?]+$/g, '').trim();
    if (!limpa || vistos.has(limpa)) continue;
    vistos.add(limpa);
    urls.push(limpa);
  }
  return urls.slice(0, 4);
}

function classificarUrlFonte(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    if (
      host.includes('facebook.com') ||
      host === 'fb.com' ||
      host === 'fb.watch' ||
      host === 'm.facebook.com'
    ) {
      return 'facebook';
    }
    if (host.includes('instagram.com')) return 'instagram';
    if (host.includes('youtube.com') || host === 'youtu.be' || host === 'm.youtube.com') {
      return 'youtube';
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * YouTube → título + descrição (+ legendas/auto-captions se existirem).
 * Não baixa o vídeo inteiro.
 */
async function extrairYoutubeComoFonte(url, { onPasso } = {}) {
  const fs = require('fs');
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
  const exec = binary ? youtubedlPkg.create(binary) : youtubedlPkg;
  const info = await runYtDlp(
    exec,
    url,
    {
      dumpSingleJson: true,
      noWarnings: true,
      skipDownload: true,
      noPlaylist: true,
      socketTimeout: 45,
      retries: 1,
    },
    { platform: 'youtube' }
  );

  const titulo = String(info.title || '').trim() || null;
  const descricao = String(info.description || '').trim();
  const veiculo = String(info.uploader || info.channel || 'YouTube').trim();
  let trecho = [titulo ? `Título: ${titulo}` : null, descricao || null].filter(Boolean).join('\n\n');

  // Legendas/auto-captions enriquecem o factual (fala do vídeo)
  try {
    const { trySubtitlesFromUrl } = require('./transcriptionService');
    const subs = await trySubtitlesFromUrl(url);
    if (subs?.text && String(subs.text).trim().length >= 40) {
      const transcricao = String(subs.text).trim();
      trecho = `${trecho}\n\nTranscrição/legendas:\n${transcricao.slice(0, 12000)}`;
      if (typeof onPasso === 'function') {
        onPasso({
          kind: 'fontes',
          texto: `Transcrição do YouTube encontrada (${transcricao.length} caracteres)`,
        });
      }
    }
  } catch (err) {
    console.warn('[materia-chat] youtube subs:', err.message);
  }

  if (String(trecho || '').trim().length < 40) {
    const err = new Error(
      'Não consegui ler título/descrição suficientes deste YouTube. O vídeo pode estar privado ou bloqueado; cole o texto da descrição no chat.'
    );
    err.status = 422;
    throw err;
  }

  return {
    veiculo,
    titulo: titulo || `Vídeo — ${veiculo}`,
    url,
    resumo: String(descricao || trecho).slice(0, 400),
    trecho: trecho.slice(0, 14000),
    ehRedeSocial: true,
    plataforma: 'youtube',
  };
}

/**
 * Extrai legenda/texto de FB, IG ou YT colados no chat.
 * Devolve fontes no formato do montarBlocoFatos.
 */
async function extrairFontesDeLinks(urls, { onPasso } = {}) {
  const {
    isSocialPostUrl,
    extrairPostSocial,
    normalizarUrlSocial,
  } = require('./socialPostExtract');

  const fontes = [];
  const falhas = [];

  for (const raw of urls) {
    const tipo = classificarUrlFonte(raw);
    if (!tipo) continue;

    const rotulo =
      tipo === 'facebook' ? 'Facebook' : tipo === 'instagram' ? 'Instagram' : 'YouTube';
    if (typeof onPasso === 'function') {
      onPasso({ kind: 'lendo', texto: `Lendo ${rotulo}: ${raw}`, url: raw });
    }

    try {
      if (tipo === 'youtube') {
        fontes.push(await extrairYoutubeComoFonte(raw, { onPasso }));
        continue;
      }

      const link = normalizarUrlSocial(raw);
      if (!isSocialPostUrl(link)) {
        falhas.push({
          url: raw,
          erro: `Link de ${rotulo} não parece ser um post/foto/Reel. Use o link da publicação.`,
        });
        continue;
      }

      const social = await extrairPostSocial(link);
      const texto = String(social.texto || '').trim();
      if (texto.length < 40) {
        falhas.push({
          url: raw,
          erro: `Legenda de ${rotulo} vazia ou curta demais. Cole o texto do post no chat.`,
        });
        continue;
      }

      // Em vídeo, tenta legendas se a legenda for curta
      let trecho = texto;
      if (texto.length < 220 && /reel|reels|videos|fb\.watch|\/tv\//i.test(link)) {
        try {
          const { trySubtitlesFromUrl } = require('./transcriptionService');
          const subs = await trySubtitlesFromUrl(link);
          if (subs?.text && String(subs.text).trim().length >= 40) {
            trecho = `${texto}\n\nTranscrição/legendas:\n${String(subs.text).trim().slice(0, 3500)}`;
          }
        } catch {
          /* opcional */
        }
      }

      fontes.push({
        veiculo: social.veiculo || rotulo,
        titulo: social.titulo || texto.slice(0, 120),
        url: social.url || link,
        resumo: texto.slice(0, 400),
        trecho: trecho.slice(0, 5000),
        ehRedeSocial: true,
        plataforma: tipo,
        imagem: social.imagem || null,
      });
    } catch (err) {
      console.warn(`[materia-chat] extrair ${tipo}:`, err.message);
      falhas.push({ url: raw, erro: err.message || `Falha ao ler ${rotulo}` });
    }
  }

  return { fontes, falhas };
}

/**
 * A resposta do chat pode ser matéria ou só um recado/resposta curta.
 * Quando é matéria, separa título, corpo e hashtags para virar rascunho.
 */
function interpretarResposta(conteudo) {
  const { extrairHashtagsDoTexto } = require('./editorialGuidelinesFb');
  const bruto = String(conteudo || '').trim();
  if (!bruto) return { ehMateria: false, titulo: null, corpo: '', hashtags: [] };

  const { body, tags } = extrairHashtagsDoTexto(bruto);

  // Remove preâmbulo conversacional antes da matéria real.
  // A IA pode responder: "A matéria é sobre X...\n---\nTítulo real\n\n..."
  let textoUtil = String(body || '');
  const sepMatch = textoUtil.match(/\n-{3,}\s*\n/);
  if (sepMatch) {
    const sepIdx = sepMatch.index;
    const antesSep = textoUtil.slice(0, sepIdx).trim();
    const depoisSep = textoUtil.slice(sepIdx + sepMatch[0].length).trim();
    if (antesSep.length < 600 && depoisSep.length > 400) {
      textoUtil = depoisSep;
    }
  }

  const linhas = textoUtil.split('\n').map((l) => l.trim());
  const primeira = linhas.find((l) => l.length > 0) || '';
  const restoTexto = textoUtil.slice(textoUtil.indexOf(primeira) + primeira.length).trim();
  const paragrafos = restoTexto.split(/\n\s*\n/).filter((p) => p.trim().length > 0);

  const tituloLimpo = primeira
    .replace(/^#{1,6}\s*/, '')
    .replace(/^\*+|\*+$/g, '')
    .replace(/^["“”']+|["“”']+$/g, '')
    .trim();

  // Recado da checagem nunca é matéria (não pode virar rascunho)
  const ehRecadoDeChecagem = /^n[ãa]o achei confirma/i.test(tituloLimpo);

  const ehMateria =
    !ehRecadoDeChecagem &&
    restoTexto.length >= 400 &&
    paragrafos.length >= 2 &&
    tituloLimpo.length >= 15 &&
    tituloLimpo.length <= 200;

  return {
    ehMateria,
    titulo: ehMateria ? tituloLimpo.slice(0, 180) : null,
    corpo: ehMateria ? restoTexto : body,
    hashtags: tags.slice(0, 6),
  };
}

function normalizarTexto(texto) {
  return String(texto || '')
    .toLocaleLowerCase('pt-BR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Falas entre aspas que não aparecem na apuração — o erro mais perigoso da IA.
 * Compara janelas de 5 palavras da citação com o texto das fontes.
 */
function citacoesSemFonte(resposta, contexto) {
  const ctx = normalizarTexto(contexto);
  if (!ctx) return [];
  const suspeitas = [];
  const rx = /[“"]([^”"]{25,400})[”"]/g;
  let match;
  while ((match = rx.exec(String(resposta || ''))) !== null) {
    const frase = match[1].replace(/\s+/g, ' ').trim();
    const palavras = normalizarTexto(frase).split(' ').filter(Boolean);
    if (palavras.length < 5) continue;
    let encontrada = false;
    for (let i = 0; i + 5 <= palavras.length; i += 1) {
      if (ctx.includes(palavras.slice(i, i + 5).join(' '))) {
        encontrada = true;
        break;
      }
    }
    if (!encontrada) suspeitas.push(frase.length > 90 ? `${frase.slice(0, 90)}…` : frase);
  }
  return suspeitas.slice(0, 3);
}

/** Muletas de bastidor inventado — só passam se aparecerem nas fontes. */
const EXPRESSOES_BASTIDOR = [
  'nos bastidores',
  'segundo interlocutores',
  'fontes ouvidas',
  'aliados afirmam',
  'aliados dizem',
  'uma ala',
  'outra ala',
  'reclamam',
  'cresce a insatisfacao',
  'nao tem posicao oficial',
  'nao ha posicao oficial',
  'nao se manifestou',
  'nao deu detalhes',
  'segue em silencio',
  'segundo apuracao',
  'de acordo com apuracao',
  'conforme apurado',
  'segundo pessoas',
];

function expressoesSemFonte(resposta, contexto) {
  const texto = normalizarTexto(resposta);
  const ctx = normalizarTexto(contexto);
  return EXPRESSOES_BASTIDOR.filter((e) => texto.includes(e) && !ctx.includes(e));
}

/**
 * Manchete de fonte usada como se fosse fala da pessoa — erro clássico
 * (o título do artigo de opinião vira "declarou X").
 */
function citacoesQueSaoTitulos(resposta, fontes = []) {
  const titulos = (Array.isArray(fontes) ? fontes : [])
    .map((f) => normalizarTexto(f?.titulo))
    .filter((t) => t.length >= 25);
  if (!titulos.length) return [];

  const suspeitas = [];
  const rx = /[“"]([^”"]{25,400})[”"]/g;
  let match;
  while ((match = rx.exec(String(resposta || ''))) !== null) {
    const frase = match[1].replace(/\s+/g, ' ').trim();
    const norm = normalizarTexto(frase);
    if (norm.length < 25) continue;
    const bate = titulos.some((t) => t.includes(norm) || norm.includes(t));
    if (bate) suspeitas.push(frase.length > 90 ? `${frase.slice(0, 90)}…` : frase);
  }
  return suspeitas.slice(0, 3);
}

/**
 * Deixa texto de fonte externa seguro para gravar no MySQL.
 * Cortar com slice() pode partir um par de surrogates (emoji) no meio e gerar
 * UTF-8 inválido, que o banco recusa — aqui o corte é limpo.
 */
function limparParaBanco(valor, max = 500) {
  let texto = String(valor ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (max > 0 && texto.length > max) texto = texto.slice(0, max);
  // Remove surrogates órfãos (inclusive os criados pelo corte acima)
  return texto
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/([^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/g, '$1')
    .trim();
}

function serializarMensagem(row) {
  const conteudo = String(row.content || '');
  const info = row.role === 'assistant' ? interpretarResposta(conteudo) : null;
  const guardadas = parseJson(row.fontes, []);
  const pautas = (Array.isArray(guardadas) ? guardadas : []).filter((f) => f && f.ehPauta);
  return {
    id: row.id,
    role: row.role,
    content: conteudo,
    titulo: row.titulo || info?.titulo || null,
    hashtags: parseJson(row.hashtags, []),
    passos: parseJson(row.passos, []),
    pautas,
    fontes: pautas.length ? [] : guardadas,
    pesquisouWeb: Boolean(row.pesquisou_web),
    matterId: row.matter_id || null,
    ehMateria: row.role === 'assistant' ? Boolean(info?.ehMateria) : false,
    createdAt: row.created_at,
  };
}

async function listarConversas(userId) {
  const rows = await AiChats.findByUser(userId, { limit: 80 });
  return rows.map((c) => ({
    id: c.id,
    titulo: c.titulo || 'Nova conversa',
    pesquisarWeb: Boolean(c.pesquisar_web),
    tom: c.tom || 'natural',
    periodo: c.periodo || PERIODO_PADRAO,
    totalMensagens: Number(c.total_mensagens || 0),
    lastMessageAt: c.last_message_at || c.created_at,
  }));
}

async function criarConversa({ userId, titulo = null, facebookPageId = null }) {
  const id = await AiChats.create({
    user_id: userId,
    facebook_page_id: facebookPageId || null,
    titulo: titulo ? tituloDaConversa(titulo) : null,
  });
  const chat = await AiChats.findById(id);
  return { id: chat.id, titulo: chat.titulo || 'Nova conversa', mensagens: [] };
}

async function obterConversa({ userId, chatId }) {
  const chat = await AiChats.findByIdForUser(chatId, userId);
  if (!chat) throw erro('Conversa não encontrada', 404);
  const rows = await AiChatMessages.findByChat(chat.id);
  return {
    id: chat.id,
    titulo: chat.titulo || 'Nova conversa',
    pesquisarWeb: Boolean(chat.pesquisar_web),
    tom: chat.tom || 'natural',
    periodo: chat.periodo || PERIODO_PADRAO,
    mensagens: rows.map(serializarMensagem),
  };
}

async function renomearConversa({ userId, chatId, titulo }) {
  const chat = await AiChats.findByIdForUser(chatId, userId);
  if (!chat) throw erro('Conversa não encontrada', 404);
  const novo = tituloDaConversa(titulo);
  await AiChats.update(chat.id, { titulo: novo });
  return { id: chat.id, titulo: novo };
}

async function excluirConversa({ userId, chatId }) {
  const chat = await AiChats.findByIdForUser(chatId, userId);
  if (!chat) throw erro('Conversa não encontrada', 404);
  await AiChats.remove(chat.id, userId);
  return { ok: true };
}

/**
 * Núcleo do chat: salva o pedido, pesquisa na web (avisando o progresso),
 * conversa com a IA em streaming e guarda a resposta na conversa.
 * `onEvent` recebe { tipo, ... } para o front desenhar em tempo real.
 */
async function responder({
  userId,
  chatId = null,
  texto,
  pesquisarWeb = true,
  tom = 'natural',
  periodo = PERIODO_PADRAO,
  palavrasChave = null,
  modo = 'escrever',
  onEvent = () => {},
}) {
  // 'pautas': pesquisa o tema e devolve a lista de matérias para o usuário
  // escolher qual quer reescrever, em vez de já escrever a matéria.
  const modoPautas = String(modo) === 'pautas';
  const deepseekService = require('./deepseekService');
  const materiaIaService = require('./materiaIaService');
  deepseekService.assertDeepseek();

  const pedido = String(texto || '').replace(/\s+$/g, '').trim();
  if (pedido.length < 3) throw erro('Escreva o que você quer que a IA faça', 400);

  const periodoFinal = PERIODOS.includes(String(periodo)) ? String(periodo) : PERIODO_PADRAO;

  let chat = chatId ? await AiChats.findByIdForUser(chatId, userId) : null;
  if (chatId && !chat) throw erro('Conversa não encontrada', 404);
  if (!chat) {
    const novoId = await AiChats.create({
      user_id: userId,
      titulo: tituloDaConversa(pedido),
      pesquisar_web: pesquisarWeb ? 1 : 0,
      tom,
      periodo: periodoFinal,
    });
    chat = await AiChats.findById(novoId);
    onEvent({ tipo: 'conversa', chat: { id: chat.id, titulo: chat.titulo, nova: true } });
  } else {
    const patch = { pesquisar_web: pesquisarWeb ? 1 : 0, tom, periodo: periodoFinal };
    if (!chat.titulo) patch.titulo = tituloDaConversa(pedido);
    await AiChats.update(chat.id, patch);
    if (patch.titulo) {
      onEvent({ tipo: 'conversa', chat: { id: chat.id, titulo: patch.titulo, nova: false } });
    }
  }

  const anteriores = await AiChatMessages.findByChat(chat.id);

  const userMessageId = await AiChatMessages.create({
    chat_id: chat.id,
    role: 'user',
    content: pedido,
  });
  onEvent({
    tipo: 'mensagem-usuario',
    mensagem: serializarMensagem({
      id: userMessageId,
      chat_id: chat.id,
      role: 'user',
      content: pedido,
      created_at: new Date(),
    }),
  });

  const passos = [];
  const registrarPasso = (passo) => {
    passos.push(passo);
    onEvent({ tipo: 'passo', passo });
  };

  /** Salva a resposta na conversa e avisa o front (usado no fluxo normal e na checagem). */
  const finalizar = async (resposta, { fontesUsadas = [], usouWeb = false, pautas = null } = {}) => {
    const info = interpretarResposta(resposta);

    // Passos e fontes vêm de páginas externas: limita volume e limpa o texto
    // antes de gravar, para um resumo malformado não derrubar a conversa.
    const passosSalvos = passos.slice(-40).map((p) => ({
      kind: p.kind,
      texto: limparParaBanco(p.texto, 300),
      ...(p.url ? { url: limparParaBanco(p.url, 500) } : {}),
    }));

    const fontesSalvas = pautas
      ? pautas.slice(0, 12).map((p) => ({
          veiculo: limparParaBanco(p.veiculo, 120),
          titulo: limparParaBanco(p.titulo, 300),
          url: limparParaBanco(p.url, 500),
          resumo: limparParaBanco(p.resumo, 320),
          ehPauta: true,
        }))
      : (fontesUsadas || []).slice(0, 12).map((f) => ({
          veiculo: limparParaBanco(f.veiculo, 120),
          titulo: limparParaBanco(f.titulo, 300),
          url: limparParaBanco(f.url, 500),
        }));

    const registro = {
      chat_id: chat.id,
      role: 'assistant',
      content: resposta,
      titulo: info.titulo ? limparParaBanco(info.titulo, 180) : null,
      hashtags: JSON.stringify(info.hashtags || []),
      passos: JSON.stringify(passosSalvos),
      // Lista de pautas fica no mesmo campo de fontes, marcada com ehPauta
      // para o chat reabrir a conversa já com os cartões de escolha.
      fontes: JSON.stringify(fontesSalvas),
      pesquisou_web: usouWeb ? 1 : 0,
    };

    let assistantId;
    try {
      assistantId = await AiChatMessages.create(registro);
    } catch (err) {
      // Não perde a resposta por causa dos metadados da apuração.
      console.error(
        '[materia-chat] falha ao salvar mensagem:',
        err.code || '',
        err.sqlMessage || err.message
      );
      assistantId = await AiChatMessages.create({
        chat_id: chat.id,
        role: 'assistant',
        content: registro.content,
        titulo: registro.titulo,
        hashtags: '[]',
        passos: '[]',
        fontes: '[]',
        pesquisou_web: registro.pesquisou_web,
      });
    }
    await AiChats.touch(chat.id);
    const salva = await AiChatMessages.findById(assistantId);
    const mensagem = serializarMensagem(salva);
    onEvent({ tipo: 'fim', chatId: chat.id, mensagem });
    return { chatId: chat.id, mensagem };
  };

  /** Texto que o chat mostra quando a apuração não sustenta o pedido. */
  const respostaSemConfirmacao = (checagem, fontesEncontradas) => {
    const partes = ['Não achei confirmação para isso na apuração — por isso não escrevi a matéria.'];
    if (checagem?.oQueAsFontesDizem) {
      partes.push(`O que as fontes trazem: ${checagem.oQueAsFontesDizem}`);
    } else if (!fontesEncontradas.length) {
      partes.push('Nenhuma reportagem sobre esse fato apareceu nas buscas que fiz.');
    }
    if (checagem?.oQueFalta) partes.push(`Não confirmei: ${checagem.oQueFalta}`);
    if (checagem?.sugestao) partes.push(`Dá para sustentar esta matéria: ${checagem.sugestao}`);
    partes.push(
      'Se você tem a fonte (link, vídeo ou print), cole aqui que eu escrevo com ela. Se quiser o texto sem confirmação, responda “pode escrever mesmo assim” — aí sai por sua conta e risco.'
    );
    return partes.join('\n\n');
  };

  // Ajuste da matéria que já está na conversa não passa pela checagem
  const pedidoDeAjuste =
    /\b(mais curto|mais longo|encurt|resum|troqu|troca|mud[ae]|ajust|acrescent|adicion|melhor|refa[çc]|corrig|tire|remova|mesma mat[eé]ria|esse texto|nesse texto)/i.test(
      pedido
    );

  const urlsNoPedido = extrairUrlsDoTexto(pedido);
  const urlsSociais = urlsNoPedido.filter((u) => classificarUrlFonte(u));

  // Pedido curto afirmando um fato = hipótese a checar antes de virar matéria
  // Colar só o link (ou “faça matéria” + link) também pede matéria.
  const pedeMateria =
    !pedidoDeAjuste &&
    (Boolean(urlsSociais.length) ||
      (pedido.length < 700 &&
        /\b(mat[eé]ria|reportagem|escrev|escreva|fa[çc]a|monte|poste?|texto)\b/i.test(pedido)));
  const usuarioInsiste =
    /\b(mesmo assim|pode escrever|escreva assim|escreve assim|sem confirma|eu confirmo|eu garanto|é verdade|e verdade|assumo)\b/i.test(
      pedido
    );

  // O usuário pode desligar a busca dentro do próprio texto
  const pediuSemPesquisa =
    /\b(n[ãa]o\s+(pesquis|busqu|procur)|sem\s+(pesquis|busca|buscar|internet))/i.test(pedido);
  // Listar pautas exige busca — é o objetivo do modo.
  let usarPesquisa = modoPautas || (Boolean(pesquisarWeb) && !pediuSemPesquisa);

  let fontes = [];
  let blocoFatos = null;
  let temFonteDoLink = false;
  // Assunto extraído do post, usado para buscar contexto quando o pedido é só o link
  let assuntoDoLink = '';

  // 1) Links FB / IG / YT colados no chat → legenda, descrição ou legendas
  if (urlsSociais.length) {
    registrarPasso({
      kind: 'pensando',
      texto: `Lendo ${urlsSociais.length} link(s) de Facebook/Instagram/YouTube…`,
    });
    const { fontes: fontesLink, falhas } = await extrairFontesDeLinks(urlsSociais, {
      onPasso: registrarPasso,
    });
    if (fontesLink.length) {
      fontes = fontesLink;
      temFonteDoLink = true;
      registrarPasso({
        kind: 'fontes',
        texto: `${fontesLink.length} fonte(s) extraída(s) do(s) link(s)`,
      });
      blocoFatos = materiaIaService.montarBlocoFatos(fontes);

      // Pedido ≈ só o link: matéria sai do post/vídeo; pesquisa web só se pedirem.
      const resto = urlsSociais
        .reduce((t, u) => t.replace(u, ' '), pedido)
        .replace(/\s+/g, ' ')
        .trim();
      const pediuSemComplemento = /\b(s[óo]\s+(o\s+)?link|apenas\s+(o\s+)?link|sem\s+pesquis)/i.test(resto);
      if (pediuSemComplemento) {
        usarPesquisa = false;
        registrarPasso({
          kind: 'pensando',
          texto: 'Usando só o conteúdo do link, como você pediu.',
        });
      } else if (resto.length < 50 && usarPesquisa && !modoPautas) {
        // Só o link: a legenda sozinha rende matéria curta. Cruza com
        // reportagens do mesmo assunto para dar contexto real ao texto.
        assuntoDoLink = String(fontes[0]?.titulo || fontes[0]?.resumo || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 120);
        registrarPasso({
          kind: 'pensando',
          texto: assuntoDoLink
            ? `Post lido. Buscando reportagens sobre “${assuntoDoLink}” para dar contexto à matéria.`
            : 'Post lido. Buscando reportagens sobre o mesmo assunto para dar contexto.',
        });
      }
    }
    for (const f of falhas) {
      registrarPasso({
        kind: 'aviso',
        texto: `Não li o link: ${f.erro}`,
        url: f.url || null,
      });
    }
    if (!fontesLink.length && falhas.length) {
      registrarPasso({
        kind: 'aviso',
        texto:
          'Não consegui extrair o texto do link. Cole a legenda/descrição no chat ou tente outro link público.',
      });
    }
  }

  if (usarPesquisa) {
    const { rotuloPeriodo } = require('./newsResearch');
    const janela = rotuloPeriodo(periodoFinal);
    registrarPasso({
      kind: 'pensando',
      texto: `Analisando o pedido e montando as buscas (${janela})…`,
    });

    let consultas = [];
    try {
      const sugestao = await deepseekService.sugerirConsultasPesquisa({
        // Com link colado sozinho, o assunto vem do próprio post
        pedido: assuntoDoLink ? `${assuntoDoLink} ${pedido}`.trim() : pedido,
        palavrasChave: palavrasChave || assuntoDoLink || null,
      });
      consultas = sugestao.consultas || [];
    } catch (err) {
      console.warn('[materia-chat] consultas:', err.message);
    }

    // Garante variação de consultas para alcançar mais veículos
    if (consultas.length === 1) {
      const extra = String(consultas[0]).replace(/\s+/g, ' ').trim();
      if (extra.length >= 8) consultas.push(`${extra} repercussão`);
    }
    if (!consultas.length) {
      const semUrls = urlsSociais
        .reduce((t, u) => t.replace(u, ' '), pedido)
        .replace(/\s+/g, ' ')
        .trim();
      const base = String(
        palavrasChave || semUrls || fontes[0]?.titulo || fontes[0]?.resumo || pedido
      )
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
      if (base.length >= 8) consultas = [base];
    }

    let lidas = 0;
    let fontesWeb = [];
    try {
      fontesWeb = await materiaIaService.coletarFatosNaWeb({
        consultas: consultas.slice(0, 6),
        periodo: periodoFinal,
        // Apuração ampla: mais sites e também redes sociais
        max: modoPautas ? 20 : temFonteDoLink ? 12 : 14,
        incluirRedes: true,
        redesAmplas: true,
        resumoContexto: pedido.slice(0, 300),
        logPrefix: '[materia-chat]',
        onProgress: (evento) => {
          if (evento.tipo === 'buscando') {
            registrarPasso({
              kind: 'busca',
              texto: evento.redes
                ? `Procurando em redes sociais (Instagram, Facebook, YouTube, X, TikTok…): “${evento.consulta}”`
                : `Pesquisando na web (${evento.periodo || janela}): “${evento.consulta}”`,
            });
          } else if (evento.tipo === 'encontrados') {
            const descartados = Number(evento.descartados || 0);
            const onde = evento.redes ? ' em redes sociais' : '';
            registrarPasso({
              kind: 'encontrados',
              texto: descartados
                ? `${evento.total} resultado(s)${onde} no período (${descartados} fora da janela, descartados)`
                : `${evento.total} resultado(s)${onde} encontrados`,
            });
          } else if (evento.tipo === 'redes-indisponivel') {
            registrarPasso({
              kind: 'aviso',
              texto: `Redes sociais sem resultado: ${evento.motivo}. A matéria segue com as fontes de notícias.`,
            });
          } else if (evento.tipo === 'redes-descartadas') {
            const partes = [];
            if (evento.semConteudo) partes.push(`${evento.semConteudo} sem conteúdo (perfil/login)`);
            if (evento.semData) partes.push(`${evento.semData} sem data confirmada no período`);
            registrarPasso({
              kind: 'encontrados',
              texto: `Posts descartados: ${partes.join(' · ')}`,
            });
          } else if (evento.tipo === 'fora-do-tema') {
            registrarPasso({
              kind: 'encontrados',
              texto: `${evento.total} resultado(s) descartados por fugir do assunto pesquisado`,
            });
          } else if (evento.tipo === 'lendo') {
            lidas += 1;
            if (lidas <= 20) {
              registrarPasso({
                kind: 'lendo',
                texto: `Lendo ${evento.veiculo || 'página'}: ${evento.titulo || evento.url}`,
                url: evento.url || null,
              });
            }
          }
        },
      });
    } catch (err) {
      console.warn('[materia-chat] pesquisa:', err.message);
    }

    if (fontesWeb.length) {
      const urlsJa = new Set(fontes.map((f) => String(f.url || '').toLowerCase()).filter(Boolean));
      const extras = fontesWeb.filter((f) => {
        const u = String(f.url || '').toLowerCase();
        if (u && urlsJa.has(u)) return false;
        if (u) urlsJa.add(u);
        return true;
      });
      fontes = [...fontes, ...extras];
      registrarPasso({
        kind: 'fontes',
        texto: `${extras.length} fonte(s) da web aproveitadas na apuração (${janela})`,
      });
      blocoFatos = `Janela da apuração: ${janela}. Não trate fato antigo como novidade.\n\n${materiaIaService.montarBlocoFatos(
        fontes
      )}`;
    } else if (!temFonteDoLink) {
      registrarPasso({
        kind: 'aviso',
        texto: `Não achei fontes na web nesse período (${janela}). Aumente o período ou cole o link da fonte (Facebook, Instagram ou YouTube).`,
      });
      usarPesquisa = false;
    } else {
      registrarPasso({
        kind: 'aviso',
        texto: `Sem reportagens extras na web (${janela}) — a matéria sai com o conteúdo do link.`,
      });
      usarPesquisa = false;
    }
  }

  // Modo pautas: para aqui e devolve a lista para o usuário escolher.
  if (modoPautas) {
    const tema = pedido.replace(/\s+/g, ' ').trim().slice(0, 120);
    const pautas = fontes
      .filter((f) => f.url && f.titulo)
      .map((f) => ({
        veiculo: limparParaBanco(f.veiculo, 120) || 'Web',
        titulo: limparParaBanco(f.titulo, 300),
        url: limparParaBanco(f.url, 500),
        resumo: limparParaBanco(f.resumo || f.trecho, 320),
        ehPauta: true,
      }));

    onEvent({ tipo: 'inicio-resposta' });

    if (!pautas.length) {
      const { rotuloPeriodo } = require('./newsResearch');
      const aviso = [
        `Não encontrei matérias sobre “${tema}” no período escolhido (${rotuloPeriodo(periodoFinal)}).`,
        'Aumente o período, tente outras palavras ou cole o link da matéria que você quer reescrever.',
      ].join('\n\n');
      onEvent({ tipo: 'delta', texto: aviso });
      return finalizar(aviso, { fontesUsadas: [], usouWeb: true });
    }

    registrarPasso({
      kind: 'fontes',
      texto: `${pautas.length} pauta(s) encontradas para escolher`,
    });
    const resumo = `Encontrei ${pautas.length} matéria(s) sobre “${tema}”. Escolha qual você quer reescrever com furo de reportagem — o texto sai original, sem plágio, e eu pesquiso mais informações sobre ela.`;
    onEvent({ tipo: 'delta', texto: resumo });
    onEvent({ tipo: 'pautas', pautas });
    return finalizar(resumo, { usouWeb: true, pautas });
  }

  // Portão anti-invenção: pedido que AFIRMA um fato só passa se a apuração confirmar.
  // Link social/YouTube já é fonte documentada — a checagem usa o texto extraído.
  if ((usarPesquisa || temFonteDoLink) && !pedidoDeAjuste && !usuarioInsiste) {
    let checagem = null;
    if (blocoFatos) {
      registrarPasso({ kind: 'checagem', texto: 'Checando o pedido contra as fontes…' });
      try {
        checagem = await deepseekService.checarPedidoNasFontes({ pedido, fatosFontes: blocoFatos });
      } catch (err) {
        console.warn('[materia-chat] checagem:', err.message);
      }
    }

    const afirmaFato = !checagem || checagem.tipoPedido === 'fato';
    const naoConfirmado = !blocoFatos || (checagem && checagem.confirmado === false);
    // Pedido = só o link (ou “faça matéria deste link”): o fato está no próprio post/vídeo
    const pedidoCentadoNoLink =
      temFonteDoLink &&
      (!checagem ||
        checagem.tipoPedido === 'tema' ||
        urlsSociais.some((u) => pedido.replace(u, '').replace(/\s+/g, ' ').trim().length < 40));

    if (afirmaFato && naoConfirmado && pedeMateria && !pedidoCentadoNoLink) {
      registrarPasso({
        kind: 'aviso',
        texto: 'A apuração não confirmou o fato do pedido — matéria não escrita.',
      });
      onEvent({ tipo: 'inicio-resposta' });
      const resposta = respostaSemConfirmacao(checagem, fontes);
      onEvent({ tipo: 'delta', texto: resposta });
      return finalizar(resposta, {
        fontesUsadas: fontes,
        usouWeb: Boolean(fontes.some((f) => !f.ehRedeSocial)),
      });
    }

    if (checagem?.confirmado || (temFonteDoLink && pedidoCentadoNoLink)) {
      registrarPasso({
        kind: 'fontes',
        texto: temFonteDoLink
          ? 'Conteúdo do link usado como base factual'
          : 'Fato do pedido confirmado na apuração',
      });
    } else if (checagem?.tipoPedido === 'tema') {
      registrarPasso({
        kind: 'checagem',
        texto: 'Pedido de tema: a matéria vai sair só com o que está nas fontes',
      });
    }
  }

  if (usuarioInsiste) {
    registrarPasso({
      kind: 'aviso',
      texto: 'Escrevendo a seu pedido, sem confirmação nas fontes — revise antes de publicar.',
    });
  }
  registrarPasso({ kind: 'escrevendo', texto: 'Escrevendo…' });
  onEvent({ tipo: 'inicio-resposta' });

  const historico = anteriores.map((m) => ({ role: m.role, content: m.content }));

  let resposta = '';
  try {
    resposta = await deepseekService.conversarMateria({
      pedido,
      historico,
      fatosFontes: blocoFatos,
      tom,
      permitirSemConfirmacao: usuarioInsiste,
      onDelta: (delta) => onEvent({ tipo: 'delta', texto: delta }),
    });
  } catch (err) {
    await AiChats.touch(chat.id);
    throw err;
  }

  const contexto = [blocoFatos || '', pedido, ...historico.map((h) => h.content || '')].join('\n');

  /** Trechos que a checagem local considera sem lastro nas fontes. */
  const levantarSuspeitas = (texto) => {
    const lista = [];
    try {
      const { detectarCitacoesInventadas } = require('./editorialGuidelinesFb');
      for (const fala of citacoesSemFonte(texto, contexto)) lista.push(`fala sem fonte: “${fala}”`);
      for (const expr of expressoesSemFonte(texto, contexto)) {
        lista.push(`bastidor sem fonte: "${expr}"`);
      }
      for (const titulo of citacoesQueSaoTitulos(texto, fontes)) {
        lista.push(`manchete usada como fala (não é declaração): “${titulo}”`);
      }
      for (const nome of detectarCitacoesInventadas(texto, contexto)) {
        lista.push(`nome citado fora da apuração: ${nome}`);
      }
    } catch (err) {
      console.warn('[materia-chat] checagem local:', err.message);
    }
    return lista;
  };

  const ehMateriaGerada = interpretarResposta(resposta).ehMateria;

  // Rede de segurança: matéria sem nenhuma fonte (web ou link), com pesquisa pedida, não vale
  if (
    ehMateriaGerada &&
    pesquisarWeb &&
    !pediuSemPesquisa &&
    !blocoFatos &&
    !temFonteDoLink &&
    !usuarioInsiste
  ) {
    registrarPasso({
      kind: 'aviso',
      texto: 'Matéria descartada: a IA escreveu sem nenhuma fonte apurada.',
    });
    const aviso = respostaSemConfirmacao(null, []);
    onEvent({ tipo: 'delta', texto: `\n\n${aviso}` });
    return finalizar(aviso, { fontesUsadas: [], usouWeb: false });
  }

  // Revisão obrigatória do texto contra as fontes quando houve pesquisa
  if (ehMateriaGerada && blocoFatos) {
    registrarPasso({ kind: 'checagem', texto: 'Revisando a matéria frase por frase contra as fontes…' });
    try {
      const revisao = await deepseekService.revisarMateriaContraFontes({
        texto: resposta,
        fatosFontes: blocoFatos,
        pedido,
        suspeitas: levantarSuspeitas(resposta),
      });
      if (revisao.revisaoDescartada) {
        registrarPasso({
          kind: 'aviso',
          texto: 'A revisão devolveu texto incompleto — mantive o original, confira com atenção.',
        });
      } else if (revisao.texto && revisao.texto !== resposta) {
        resposta = revisao.texto;
        registrarPasso({
          kind: 'checagem',
          texto: revisao.problemas.length
            ? `Revisão aplicada — ${revisao.problemas.length} trecho(s) sem lastro corrigidos`
            : 'Revisão aplicada no texto final',
        });
        for (const p of revisao.problemas.slice(0, 5)) {
          registrarPasso({ kind: 'aviso', texto: `Cortado na checagem: ${p}` });
        }
      } else {
        registrarPasso({ kind: 'checagem', texto: 'Revisão sem correções: texto bate com as fontes' });
      }
    } catch (err) {
      console.warn('[materia-chat] revisão:', err.message);
      registrarPasso({
        kind: 'aviso',
        texto: 'Não consegui rodar a revisão contra as fontes — confira o texto antes de publicar.',
      });
    }
  }

  // Última passada local no texto que vai ficar salvo
  for (const suspeita of levantarSuspeitas(resposta)) {
    registrarPasso({ kind: 'aviso', texto: `Confira antes de publicar — ${suspeita}` });
  }

  return finalizar(resposta, {
    fontesUsadas: fontes,
    usouWeb: Boolean(usarPesquisa || fontes.some((f) => !f.ehRedeSocial)),
  });
}

/**
 * Vira rascunho em ai_matters (Fonte/Foto/hashtags organizados) e devolve
 * o link da edição — /materias-ia/:id.
 */
async function salvarMateriaDoChat({
  userId,
  messageId,
  facebookPageId = null,
  imagemUrl = null,
  creditoImagem = null,
}) {
  const { montarRodapeMateriaComFontes } = require('./editorialGuidelinesFb');
  const materiaIaService = require('./materiaIaService');

  const row = await AiChatMessages.findByIdWithChat(messageId);
  if (!row || Number(row.chat_user_id) !== Number(userId)) {
    throw erro('Mensagem não encontrada', 404);
  }
  if (row.role !== 'assistant') throw erro('Só é possível salvar a resposta da IA', 400);
  if (row.matter_id) {
    const existente = await AiMatters.findById(row.matter_id);
    if (existente) {
      return { matterId: existente.id, redirect: `/materias-ia/${existente.id}`, jaExistia: true };
    }
  }

  const info = interpretarResposta(row.content);
  const corpo = String(info.corpo || row.content || '').trim();
  if (corpo.length < 120) throw erro('Essa resposta é curta demais para virar matéria', 400);

  const fontes = parseJson(row.fontes, []);
  let pageId = facebookPageId || row.chat_page_id || null;
  if (pageId) {
    const page = await materiaIaService.resolvePage(userId, pageId);
    pageId = page?.id || null;
  }
  if (!pageId) {
    const { defaultPageForUser } = require('./facebookPageResolver');
    const page = await defaultPageForUser(userId);
    pageId = page?.id || null;
  }

  const rodape = montarRodapeMateriaComFontes({
    materia: corpo,
    fontes,
    creditoImagem: creditoImagem || 'Reprodução',
    hashtags: info.hashtags || parseJson(row.hashtags, []),
  });
  const materia = rodape.materia;

  const titulo = info.titulo || row.titulo || 'Matéria do chat';
  const fontePrincipal = Array.isArray(fontes) ? fontes[0] : null;

  const [matterId] = await AiMatters.create({
    user_id: userId,
    facebook_page_id: pageId || null,
    titulo: titulo.slice(0, 180),
    materia,
    titulo_ia: titulo.slice(0, 180),
    materia_ia: materia,
    hashtags: JSON.stringify(info.hashtags || []),
    fonte_titulo: (() => {
      const rede = fontes.find((f) => f.ehRedeSocial);
      if (rede) {
        const plat =
          rede.plataforma === 'youtube'
            ? 'YouTube'
            : rede.plataforma === 'instagram'
              ? 'Instagram'
              : rede.plataforma === 'facebook'
                ? 'Facebook'
                : 'rede social';
        return row.pesquisou_web
          ? `Chat de matérias + ${plat} + pesquisa na web`
          : `Chat de matérias + ${plat}`;
      }
      return row.pesquisou_web ? 'Chat de matérias + pesquisa na web' : 'Chat de matérias';
    })(),
    fonte_url: fontePrincipal?.url || null,
    fonte_resumo: String(row.chat_titulo || '').slice(0, 1500) || null,
    contexto_apuracao: fontes.length
      ? fontes.map((f) => `${f.veiculo || 'Web'} — ${f.url || ''}`).join('\n').slice(0, 8000)
      : null,
    fonte_credito: rodape.fonteCredito || null,
    status: 'rascunho',
    tipo_publicacao: 'foto',
    imagem_url: imagemUrl && /^https?:\/\//i.test(imagemUrl) ? imagemUrl : null,
    error_message: null,
  });

  await AiChatMessages.update(row.id, { matter_id: matterId });

  if (imagemUrl && /^https?:\/\//i.test(imagemUrl)) {
    try {
      const { composeMatterArtwork } = require('./matterArtworkService');
      await composeMatterArtwork({
        userId,
        matterId,
        sourceUrl: imagemUrl,
        title: titulo,
        force: true,
      });
    } catch (err) {
      console.warn('[materia-chat] arte:', err.message);
      await AiMatters.update(matterId, {
        imagem_url: imagemUrl,
        imagem_fonte_url: imagemUrl,
      });
    }
  }

  return { matterId, redirect: `/materias-ia/${matterId}` };
}

module.exports = {
  listarConversas,
  criarConversa,
  obterConversa,
  renomearConversa,
  excluirConversa,
  responder,
  salvarMateriaDoChat,
  interpretarResposta,
};
