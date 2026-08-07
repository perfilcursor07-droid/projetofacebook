const AiChats = require('../models/AiChats');
const AiChatMessages = require('../models/AiChatMessages');
const AiMatters = require('../models/AiMatters');

const PERIODOS = ['24h', '3d', '7d', '15d', '30d', '60d', '90d', '180d'];
// Um pedido de tema (sem link) precisa de contexto suficiente para virar matéria
// completa. Sete dias continua disponível no seletor, mas não é uma boa janela
// padrão para assuntos institucionais, políticos ou eleitorais.
const PERIODO_PADRAO = '30d';
const MAX_URLS_PEDIDO = 12;

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
  return urls.slice(0, MAX_URLS_PEDIDO);
}

function normalizarUrlComparacao(url) {
  return String(url || '')
    .replace(/[.,;:!?]+$/g, '')
    .replace(/\/+$/g, '')
    .trim()
    .toLowerCase();
}

function limiteMateriasDoPedido(texto) {
  const raw = String(texto || '');
  const m = raw.match(/\b(\d{1,2})\s+mat[eé]rias\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(n, MAX_URLS_PEDIDO);
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

      const comentarios = (Array.isArray(social.comentarios) ? social.comentarios : [])
        .filter((c) => String(c?.texto || '').trim().length >= 20)
        .slice(0, 6);
      const conteudoVisual = (Array.isArray(social.conteudoVisual) ? social.conteudoVisual : [])
        .filter(Boolean)
        .slice(0, 4);
      if (conteudoVisual.length) {
        trecho += `\n\nCONTEÚDO VISÍVEL NAS IMAGENS DO POST:\n${conteudoVisual
          .map((t) => `- ${String(t).slice(0, 1000)}`)
          .join('\n')}`;
      }
      if (comentarios.length) {
        trecho += `\n\nREPERCUSSÃO NOS COMENTÁRIOS PÚBLICOS (opiniões, não fatos):\n${comentarios
          .map((c) => `- @${c.autor || 'usuário'}: “${String(c.texto).slice(0, 500)}”${c.curtidas ? ` (${c.curtidas} curtida(s))` : ''}`)
          .join('\n')}`;
      }

      fontes.push({
        veiculo: social.veiculo || rotulo,
        titulo: social.titulo || texto.slice(0, 120),
        url: social.url || link,
        resumo: texto.slice(0, 400),
        trecho: trecho.slice(0, 9000),
        ehRedeSocial: true,
        plataforma: tipo,
        imagem: social.imagem || null,
        comentarios,
      });
    } catch (err) {
      console.warn(`[materia-chat] extrair ${tipo}:`, err.message);
      falhas.push({ url: raw, erro: err.message || `Falha ao ler ${rotulo}` });
    }
  }

  return { fontes, falhas };
}

/** Host limpo da URL (sem www), ou null se o link for inválido. */
function hostDoLink(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Links de sites de notícia colados no chat → veículo, título e corpo do texto.
 * Usa o mesmo extrator do "reescrever link" (og tags + parágrafos + fallback Jina),
 * para o link virar fonte documentada em vez de ser ignorado.
 */
async function extrairFontesDeArtigos(urls, { onPasso } = {}) {
  const { extrairMetadadosArtigo, extrairMetadadosViaJina } = require('./articleSource');

  const fontes = [];
  const falhas = [];

  for (const raw of urls) {
    const host = hostDoLink(raw);
    if (!host) {
      falhas.push({ url: raw, erro: 'Link inválido — confira o endereço.' });
      continue;
    }

    if (typeof onPasso === 'function') {
      onPasso({ kind: 'lendo', texto: `Abrindo ${host}: ${raw}`, url: raw });
    }

    let meta = null;
    try {
      meta = await extrairMetadadosArtigo(raw);
    } catch (err) {
      console.warn('[materia-chat] extrair artigo:', err.message);
    }

    let trecho = String(meta?.trecho || '').trim();
    const resumo = String(meta?.resumo || '').trim();

    // O link colado é a base factual da matéria: corpo curto rende texto raso.
    // Tenta o leitor alternativo e fica com a versão mais completa.
    if (trecho.length < 900) {
      try {
        const viaJina = await extrairMetadadosViaJina(meta?.url || raw);
        const outro = String(viaJina?.trecho || '').trim();
        if (outro.length > trecho.length) trecho = outro;
      } catch {
        /* fallback opcional */
      }
    }

    const corpo =
      trecho.length >= 180 ? trecho : [resumo, trecho].filter(Boolean).join('\n\n').trim();
    const veiculo = meta?.veiculo || meta?.veiculoHost || host;

    if (corpo.length < 120) {
      falhas.push({
        url: raw,
        erro: `Não consegui ler o texto de ${veiculo}. O site pode exigir login/assinatura ou bloquear leitura — cole o texto da matéria aqui no chat.`,
      });
      continue;
    }

    fontes.push({
      veiculo,
      veiculoHost: meta?.veiculoHost || host,
      titulo: meta?.titulo || `Matéria — ${veiculo}`,
      url: meta?.url || raw,
      resumo: (resumo || corpo).slice(0, 400),
      trecho: corpo.slice(0, 9000),
      imagem: meta?.imagem || null,
      autor: meta?.autor || null,
      fonteColada: true,
    });

    if (typeof onPasso === 'function') {
      onPasso({
        kind: 'fontes',
        texto: `${veiculo}: ${corpo.length} caracteres de texto extraídos do link`,
      });
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

  // Marcador "### MATERIA 1" sobrando numa resposta com uma matéria só:
  // sem tirar, o título viraria "MATERIA 1" e a matéria não seria salvável.
  textoUtil = textoUtil.replace(/^\s*#{0,6}\s*mat[eé]ria\s*\d+\s*[:.\-–—]?\s*\n+/i, '').trim();
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

/**
 * Uma resposta pode conter várias matérias ("escreva 5 matérias sobre X").
 * Reconhece os separadores que a IA usa: "### MATERIA 1", "# 1. Título",
 * "## 2. Título" ou "**1. Título**" no começo da linha.
 * @returns {Array<{indice:number, titulo:string, corpo:string, hashtags:string[], conteudo:string}>}
 */
function separarMaterias(conteudo) {
  const bruto = String(conteudo || '').replace(/\r\n/g, '\n').trim();
  if (!bruto) return [];

  const linhas = bruto.split('\n');
  const cortes = [];

  linhas.forEach((linha, i) => {
    const l = linha.trim();
    if (!l) return;
    // "### MATERIA 2" (marcador pedido no prompt)
    if (/^#{1,6}\s*mat[eé]ria\s*\d+\b/i.test(l)) {
      cortes.push({ linha: i, pularLinha: true });
      return;
    }
    // "# 1. Título" / "## 2) Título" / "**3. Título**"
    if (/^(?:#{1,6}\s*|\*{2}\s*)?\d{1,2}\s*[.)]\s+\S/.test(l) && l.length <= 220) {
      const semNumero = l.replace(/^(?:#{1,6}\s*|\*{2}\s*)?\d{1,2}\s*[.)]\s+/, '').trim();
      // Título de matéria é frase, não item curto de lista.
      if (semNumero.length >= 15) cortes.push({ linha: i, pularLinha: false });
    }
  });

  if (cortes.length < 2) return [];

  const blocos = [];
  cortes.forEach((corte, idx) => {
    const inicio = corte.pularLinha ? corte.linha + 1 : corte.linha;
    const fim = idx + 1 < cortes.length ? cortes[idx + 1].linha : linhas.length;
    let texto = linhas.slice(inicio, fim).join('\n').trim();
    if (corte.pularLinha === false) {
      // Remove a numeração do título, mantendo o texto do título.
      texto = texto.replace(/^(?:#{1,6}\s*|\*{2}\s*)?\d{1,2}\s*[.)]\s+/, '');
    }
    if (texto) blocos.push(texto);
  });

  const materias = [];
  blocos.forEach((bloco, i) => {
    const info = interpretarResposta(bloco);
    const titulo = info.titulo || bloco.split('\n')[0].replace(/^#{1,6}\s*/, '').trim();
    if (!titulo) return;
    materias.push({
      indice: i,
      titulo: String(titulo).slice(0, 180),
      corpo: info.corpo || bloco,
      hashtags: info.hashtags || [],
      conteudo: bloco,
      salvavel: String(info.corpo || bloco).trim().length >= 120,
    });
  });

  return materias.filter((m) => m.salvavel).length >= 2 ? materias : [];
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

/** Aspas que ficaram no idioma da fonte estrangeira (erro visível na publicação). */
function citacoesNaoTraduzidas(resposta) {
  const achados = [];
  const rx = /[“"]([^”"]{20,400})[”"]/g;
  let match;
  while ((match = rx.exec(String(resposta || ''))) !== null) {
    const frase = match[1].replace(/\s+/g, ' ').trim();
    const en = (
      frase
        .toLowerCase()
        .match(/\b(the|and|was|were|is|are|had|have|been|she|he|his|her|they|that|with|about|for|from|all|been)\b/g) ||
      []
    ).length;
    const pt = (
      frase.toLowerCase().match(/\b(que|não|para|com|uma|dos|das|foi|era|ele|ela|muito|isso|como|mas)\b/g) || []
    ).length;
    if (en >= 3 && en > pt) achados.push(frase.length > 90 ? `${frase.slice(0, 90)}…` : frase);
  }
  return achados.slice(0, 3);
}

/** Fonte em inglês/espanhol: a matéria sai em português e as falas são traduzidas. */
function fonteEmOutroIdioma(fontes = []) {
  const texto = (Array.isArray(fontes) ? fontes : [])
    .filter((f) => f?.fonteColada)
    .map((f) => `${f?.titulo || ''} ${f?.trecho || f?.resumo || ''}`)
    .join(' ')
    .toLowerCase();
  if (texto.length < 200) return false;

  const marcasEn = (
    texto.match(
      /\b(the|and|said|was|were|have|has|been|with|from|that|this|police|church|according)\b/g
    ) || []
  ).length;
  const marcasPt = (
    texto.match(/\b(que|não|para|com|uma|dos|das|foi|era|segundo|polícia|igreja|disse)\b/g) || []
  ).length;
  return marcasEn >= 12 && marcasEn > marcasPt * 2;
}

/**
 * O crédito da fonte é obrigatório na matéria: se a IA não citou o veículo do
 * link colado, a atribuição entra no primeiro parágrafo do corpo.
 */
function garantirCitacaoDoVeiculo(resposta, fontesColadas = []) {
  const texto = String(resposta || '');
  const lista = (Array.isArray(fontesColadas) ? fontesColadas : []).filter((f) => f?.veiculo);
  if (!texto.trim() || !lista.length) return { texto, inserido: null };

  const { nomeCurtoFonte } = require('./editorialGuidelinesFb');
  const nomes = [];
  for (const f of lista.slice(0, 3)) {
    const cheio = String(f.veiculo).replace(/\s+/g, ' ').trim();
    const curto = nomeCurtoFonte(f.veiculo, f.url);
    for (const n of [cheio, curto]) {
      if (n && !nomes.includes(n)) nomes.push(n);
    }
  }

  const alvo = normalizarTexto(texto);
  const jaCita = nomes.some((n) => {
    const norm = normalizarTexto(n);
    return norm.length >= 3 && alvo.includes(norm);
  });
  if (jaCita) return { texto, inserido: null };

  const nome = nomeCurtoFonte(lista[0].veiculo, lista[0].url);
  const linhas = texto.split('\n');
  // 1ª linha é o título; a atribuição entra no fim do primeiro parágrafo do corpo.
  let idx = -1;
  for (let i = 1; i < linhas.length; i += 1) {
    if (linhas[i].trim().length >= 80 && !/^#/.test(linhas[i].trim())) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return { texto, inserido: null };

  const paragrafo = linhas[idx].trimEnd().replace(/\s*$/, '');
  const comCredito = /[.!?…]$/.test(paragrafo)
    ? `${paragrafo} A informação foi divulgada pela ${nome}.`
    : `${paragrafo}. A informação foi divulgada pela ${nome}.`;
  linhas[idx] = comCredito;

  return { texto: linhas.join('\n'), inserido: nome };
}

/**
 * Com Web desligada e link colado: monta rodapé padrão (Fonte + Foto + hashtags)
 * no final da matéria, para o editor já ver o crédito antes de salvar.
 */
function montarRespostaComRodapeOffline(resposta, fontes = []) {
  const { montarRodapeMateriaComFontes } = require('./editorialGuidelinesFb');
  const info = interpretarResposta(resposta);
  if (!info.ehMateria || !info.titulo) return resposta;

  const fontesRodape = (Array.isArray(fontes) ? fontes : []).filter((f) => f?.veiculo);
  if (!fontesRodape.length) return resposta;

  const rodape = montarRodapeMateriaComFontes({
    materia: info.corpo,
    fontes: fontesRodape,
    creditoImagem: 'Reprodução',
    hashtags: info.hashtags,
  });

  return `${info.titulo}\n\n${rodape.materia}`;
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
  // Trechos completos ficam no banco para dar continuidade factual ao chat,
  // mas o navegador só precisa dos metadados exibidos no painel de fontes.
  const fontesVisiveis = (Array.isArray(guardadas) ? guardadas : [])
    .filter((f) => f && !f.ehPauta)
    .map(({ trecho, ...fonte }) => fonte);
  const multiplas = row.role === 'assistant' ? separarMaterias(conteudo) : [];
  const salvos = parseJson(row.matter_ids, {}) || {};

  return {
    id: row.id,
    role: row.role,
    content: conteudo,
    titulo: row.titulo || info?.titulo || null,
    hashtags: parseJson(row.hashtags, []),
    passos: parseJson(row.passos, []),
    pautas,
    fontes: pautas.length ? [] : fontesVisiveis,
    pesquisouWeb: Boolean(row.pesquisou_web),
    matterId: row.matter_id || null,
    // Quando a resposta traz várias matérias, cada uma vira um rascunho próprio.
    materias: multiplas.map((m) => ({
      indice: m.indice,
      titulo: m.titulo,
      previa: String(m.corpo || '').replace(/\s+/g, ' ').trim().slice(0, 180),
      hashtags: m.hashtags,
      salvavel: m.salvavel,
      matterId: salvos[String(m.indice)] || null,
    })),
    ehMateria:
      row.role === 'assistant' ? Boolean(info?.ehMateria) || multiplas.length >= 2 : false,
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

/**
 * Editar um pedido invalida o que veio depois dele: apaga a mensagem
 * e todas as seguintes para a IA responder de novo, sem histórico duplicado.
 */
async function apagarMensagemEmDiante({ userId, chatId, messageId }) {
  const chat = await AiChats.findByIdForUser(chatId, userId);
  if (!chat) throw erro('Conversa não encontrada', 404);

  const alvo = await AiChatMessages.findById(messageId);
  if (!alvo || Number(alvo.chat_id) !== Number(chat.id)) {
    throw erro('Mensagem não encontrada', 404);
  }

  const removidas = await AiChatMessages.removeFromId(chat.id, alvo.id);
  return { removidas: Number(removidas || 0) };
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
          // Mantém a base factual para pedidos seguintes como "mais polêmica",
          // "deixe mais completa" ou "troque o título" continuarem no tema.
          ...(f.resumo ? { resumo: limparParaBanco(f.resumo, 500) } : {}),
          ...(f.trecho ? { trecho: limparParaBanco(f.trecho, 3500) } : {}),
          ...(f.imagem ? { imagem: limparParaBanco(f.imagem, 1200) } : {}),
          // Marcas usadas ao salvar o rascunho (crédito da fonte e ordem do rodapé)
          ...(f.ehRedeSocial ? { ehRedeSocial: true } : {}),
          ...(f.plataforma ? { plataforma: f.plataforma } : {}),
          ...(f.fonteColada ? { fonteColada: true } : {}),
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

  const ultimaMateriaAnterior = [...anteriores]
    .reverse()
    .find((mensagem) => mensagem?.role === 'assistant' && interpretarResposta(mensagem.content).ehMateria);
  const fontesDaMateriaAnterior = ultimaMateriaAnterior
    ? parseJson(ultimaMateriaAnterior.fontes, []).filter((fonte) => fonte && !fonte.ehPauta)
    : [];
  const infoMateriaAnterior = ultimaMateriaAnterior
    ? interpretarResposta(ultimaMateriaAnterior.content)
    : null;

  const pedidoIndicaNovaPauta =
    /\b(?:nova|outra)\s+(?:pauta|mat[eé]ria|reportagem|assunto|tema)\b|\b(?:fa[çc]a|escreva|crie|quero)\s+(?:uma\s+)?(?:nova\s+|outra\s+)?(?:mat[eé]ria|reportagem)\s+sobre\b/i.test(
      pedido
    );
  const pedidoCurtoDeContinuidade =
    Boolean(ultimaMateriaAnterior) &&
    pedido.length <= 320 &&
    !pedidoIndicaNovaPauta &&
    !/https?:\/\//i.test(pedido) &&
    /\b(quero|deix[ae]|fa[çc]a|ficou|est[aá]|pode|coloque|inclua|use|mantenha|retire|tente|gostei|vers[aã]o|t[ií]tulo|texto|mat[eé]ria|mais|menos|tom|foco|[aâ]ngulo|comece|termine)\b/i.test(
      pedido
    );

  // Ajustes curtos devem ser entendidos como continuação da última matéria,
  // do mesmo jeito que num chat: "mais polêmica", "mais forte", "outro título".
  const pedidoDeAjuste =
    Boolean(ultimaMateriaAnterior) &&
    !modoPautas &&
    !pedidoIndicaNovaPauta &&
    (pedidoCurtoDeContinuidade ||
      /\b(mais\s+(?:curt[ao]|long[ao]|complet[ao]|detalhad[ao]|pol[eê]mic[ao]|forte|impactante|diret[ao]|emocionante|jornal[ií]stic[ao])|encurt|resum|troqu|troca|mud[ae]|ajust|acrescent|adicion|aprofund|desenvolv|melhor|refa[çc]|reescrev|corrig|tire|remova|outro\s+t[ií]tulo|nova\s+vers[aã]o|mesma\s+mat[eé]ria|esse\s+texto|nesse\s+texto|essa\s+mat[eé]ria|nesta\s+mat[eé]ria)/i.test(
        pedido
      ));

  const contextoMateriaAnterior = pedidoDeAjuste
    ? [
        infoMateriaAnterior?.titulo || ultimaMateriaAnterior?.titulo,
        fontesDaMateriaAnterior.map((fonte) => fonte.titulo).filter(Boolean).slice(0, 4).join(' | '),
      ]
        .filter(Boolean)
        .join(' — ')
        .slice(0, 700)
    : '';

  let pedidoEmLote =
    /\b(uma\s+para\s+cada|cada\s+(pauta|assunto|link)|selecionad[ao]s?|v[aá]rias\s+mat[eé]rias|\d+\s+mat[eé]rias)\b/i.test(
      pedido
    );

  const urlsNoPedido = extrairUrlsDoTexto(pedido);
  const urlsSociais = urlsNoPedido.filter((u) => classificarUrlFonte(u));
  // Todo o resto é tratado como matéria/artigo de site: também precisa ser lido.
  const urlsArtigos = urlsNoPedido.filter((u) => !classificarUrlFonte(u) && hostDoLink(u));
  const urlsFonte = [...urlsSociais, ...urlsArtigos];
  // Vários links já significam "uma matéria para cada link", mesmo sem o
  // editor escrever essa instrução por extenso.
  if (urlsFonte.length > 1) pedidoEmLote = true;
  const limiteMateriasLote = pedidoEmLote
    ? limiteMateriasDoPedido(pedido) || (urlsFonte.length > 1 ? urlsFonte.length : null)
    : null;

  /** Pedido sem os links, para saber se o editor escreveu mais alguma coisa. */
  const pedidoSemUrls = () =>
    urlsFonte
      .reduce((t, u) => t.replace(u, ' '), pedido)
      .replace(/\s+/g, ' ')
      .trim();

  // Pedido curto afirmando um fato = hipótese a checar antes de virar matéria
  // Colar só o link (ou “faça matéria” + link) também pede matéria.
  const pedeMateria =
    !pedidoDeAjuste &&
    (Boolean(urlsFonte.length) ||
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
  const ajustePedeNovaApuracao =
    /\b(pesquis|busqu|procur|atualiz|mais\s+informa|mais\s+dados|novos?\s+dados|complement|apure|apurar|cruz|repercuss|coment[aá]rios?)\b/i.test(
      pedido
    );
  // Mudança apenas editorial reutiliza a apuração anterior. Só volta à web
  // quando o editor pedir explicitamente mais dados, atualização ou repercussão.
  if (pedidoDeAjuste && !ajustePedeNovaApuracao) usarPesquisa = false;

  let fontes = [];
  let blocoFatos = null;
  let temFonteDoLink = false;
  // Assunto extraído do post, usado para buscar contexto quando o pedido é só o link
  let assuntoDoLink = '';

  if (pedidoDeAjuste && ultimaMateriaAnterior) {
    fontes = [...fontesDaMateriaAnterior];
    const fatosGuardados = fontes.some((fonte) => fonte?.trecho || fonte?.resumo)
      ? materiaIaService.montarBlocoFatos(fontes)
      : '';
    // Conversas antigas não guardavam os trechos das fontes. Nelas, a matéria
    // anterior já revisada vira a base mínima para uma mudança apenas editorial.
    blocoFatos = [
      fatosGuardados,
      `MATÉRIA ANTERIOR JÁ REVISADA (mantenha o mesmo assunto e os mesmos fatos):\n${String(
        ultimaMateriaAnterior.content || ''
      ).slice(0, 9000)}`,
    ]
      .filter(Boolean)
      .join('\n\n---\n\n');
    registrarPasso({
      kind: 'pensando',
      texto: `Continuando a matéria anterior: ${infoMateriaAnterior?.titulo || 'mesmo assunto'}`,
    });
  }

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
      fontes = [...fontes, ...fontesLink];
      temFonteDoLink = true;
      registrarPasso({
        kind: 'fontes',
        texto: `${fontesLink.length} fonte(s) extraída(s) do(s) link(s)`,
      });
      blocoFatos = materiaIaService.montarBlocoFatos(fontes);
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

  // 1b) Links de sites de notícia colados no chat → veículo, título e corpo do texto
  if (urlsArtigos.length) {
    registrarPasso({
      kind: 'pensando',
      texto: `Lendo ${urlsArtigos.length} link(s) de notícia: ${urlsArtigos
        .map((u) => hostDoLink(u))
        .filter(Boolean)
        .join(', ')}`,
    });
    const { fontes: fontesArtigo, falhas } = await extrairFontesDeArtigos(urlsArtigos, {
      onPasso: registrarPasso,
    });

    if (fontesArtigo.length) {
      fontes = [...fontes, ...fontesArtigo];
      temFonteDoLink = true;
      registrarPasso({
        kind: 'fontes',
        texto: `Fonte do link: ${fontesArtigo.map((f) => f.veiculo).join(', ')}`,
      });
      blocoFatos = materiaIaService.montarBlocoFatos(fontes);
    }

    for (const f of falhas) {
      registrarPasso({
        kind: 'aviso',
        texto: `Não li o link: ${f.erro}`,
        url: f.url || null,
      });
    }
  }

  // Link colado já é a fonte da matéria: o padrão é reescrever só com ele,
  // sem pesquisa na web. A busca extra só entra se o editor pedir.
  const pediuContextoExtra =
    /\b(pesquis|busqu|busque|procur|mais informa|mais dados|contexto|complement|atualiz|repercuss|apure|apurar|cruz)/i.test(
      pedidoSemUrls()
    );
  if (temFonteDoLink && usarPesquisa && !modoPautas && !pediuContextoExtra) {
    usarPesquisa = false;
    registrarPasso({
      kind: 'pensando',
      texto: 'Fonte do link é suficiente: reescrevendo sem pesquisa extra na web.',
    });
  } else if (temFonteDoLink && usarPesquisa && !modoPautas) {
    assuntoDoLink = String(fontes[0]?.titulo || fontes[0]?.resumo || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
    registrarPasso({
      kind: 'pensando',
      texto: assuntoDoLink
        ? `Link lido. Buscando reportagens sobre “${assuntoDoLink}” para dar contexto, como você pediu.`
        : 'Link lido. Buscando reportagens para dar contexto, como você pediu.',
    });
  }

  if (usarPesquisa) {
    const { rotuloPeriodo } = require('./newsResearch');
    const janela = rotuloPeriodo(periodoFinal);
    registrarPasso({
      kind: 'pensando',
      texto: `Analisando o pedido e montando as buscas (${janela})…`,
    });

    let consultas = [];
    let temaPesquisa = '';
    const pedidoParaPesquisa = pedidoDeAjuste && contextoMateriaAnterior
      ? `Assunto da matéria anterior: ${contextoMateriaAnterior}\nAjuste solicitado: ${pedido}`
      : assuntoDoLink
        ? `${assuntoDoLink} ${pedido}`.trim()
        : pedido;
    try {
      const sugestao = await deepseekService.sugerirConsultasPesquisa({
        // Em continuação, pesquisa o TEMA anterior; nunca a instrução isolada
        // (por exemplo, "mais polêmica recente Brasil").
        pedido: pedidoParaPesquisa,
        palavrasChave: palavrasChave || assuntoDoLink || contextoMateriaAnterior || null,
      });
      consultas = sugestao.consultas || [];
      temaPesquisa = sugestao.tema || '';
    } catch (err) {
      console.warn('[materia-chat] consultas:', err.message);
    }

    // Garante variação de consultas para alcançar mais veículos
    if (consultas.length === 1) {
      const extra = String(consultas[0]).replace(/\s+/g, ' ').trim();
      if (extra.length >= 8) consultas.push(`${extra} repercussão`);
    }
    if (!consultas.length) {
      const semUrls = pedidoSemUrls();
      const base = String(
        palavrasChave || semUrls || fontes[0]?.titulo || fontes[0]?.resumo || pedido
      )
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
      if (base.length >= 8) consultas = [base];
    }

    // O modelo às vezes devolve só 1–2 consultas. Para uma pauta ampla isso
    // concentra a apuração no primeiro evento encontrado. Garante ângulos
    // editoriais diferentes antes de coletar as páginas.
    const baseAprofundamento = String(
      temaPesquisa || contextoMateriaAnterior || consultas[0] || pedidoSemUrls() || pedido
    )
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 110);
    if (baseAprofundamento.length >= 8 && consultas.length < 4) {
      for (const complemento of [
        'estrutura e posicionamento',
        'ações documentos e lideranças',
        'apoios articulações eleições',
        'controvérsias e contrapontos',
      ]) {
        const consulta = `${baseAprofundamento} ${complemento}`.trim();
        if (!consultas.some((item) => normalizarTexto(item) === normalizarTexto(consulta))) {
          consultas.push(consulta);
        }
        if (consultas.length >= 4) break;
      }
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
        resumoContexto: pedidoParaPesquisa.slice(0, 500),
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

    // Tema amplo não pode virar um texto de três linhas só porque a janela
    // escolhida trouxe pouca apuração. Quando o pedido não exige atualidade
    // imediata, complementa a pesquisa com histórico de até 180 dias.
      const pedidoAmplo =
        !temFonteDoLink &&
        !modoPautas &&
        /\b(sobre|panorama|cen[aá]rio|pol[ií]tica|elei[cç][aã]o|conven[cç][aã]o|2026)\b/i.test(pedidoParaPesquisa) &&
      !/\b(hoje|agora|nesta semana|esta semana|[uú]ltimas?\s+(?:24|48)\s+horas|[uú]ltimos?\s+dias|recente)\b/i.test(pedido);
    const volumeApurado = fontesWeb.reduce(
      (total, fonte) => total + String(fonte?.trecho || fonte?.resumo || '').trim().length,
      0
    );
    if (
      pedidoAmplo &&
      periodoFinal !== '180d' &&
      (fontesWeb.length < 4 || volumeApurado < 4500)
    ) {
      registrarPasso({
        kind: 'pensando',
        texto: 'Pouco material na janela inicial; ampliando a apuração para 180 dias…',
      });
      try {
        const historicas = await materiaIaService.coletarFatosNaWeb({
          consultas: consultas.slice(0, 6),
          periodo: '180d',
          max: 14,
          incluirRedes: true,
          redesAmplas: true,
          resumoContexto: pedidoParaPesquisa.slice(0, 500),
          logPrefix: '[materia-chat:ampliada]',
          onProgress: (evento) => {
            if (evento.tipo === 'lendo') {
              lidas += 1;
              if (lidas <= 20) {
                registrarPasso({
                  kind: 'lendo',
                  texto: `Aprofundando em ${evento.veiculo || 'página'}: ${evento.titulo || evento.url}`,
                  url: evento.url || null,
                });
              }
            }
          },
        });
        const urlsVistas = new Set(
          fontesWeb.map((fonte) => normalizarUrlComparacao(fonte?.url)).filter(Boolean)
        );
        for (const fonte of historicas) {
          const url = normalizarUrlComparacao(fonte?.url);
          if (url && urlsVistas.has(url)) continue;
          if (url) urlsVistas.add(url);
          fontesWeb.push(fonte);
        }
        registrarPasso({
          kind: 'fontes',
          texto: `${fontesWeb.length} fonte(s) reunidas após ampliar a apuração`,
        });
      } catch (err) {
        console.warn('[materia-chat] pesquisa ampliada:', err.message);
      }
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
        texto: `Não achei fontes na web nesse período (${janela}). Aumente o período ou cole o link da fonte (matéria de site, Facebook, Instagram ou YouTube).`,
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

  // Antes de escrever uma pauta pesquisada e ampla, sintetiza as fontes em um
  // dossiê. Isso impede que a matéria se limite ao primeiro simpósio/evento e
  // deixa explícitos estrutura, iniciativas, falas, apoios e contrapontos.
  if (!modoPautas && usarPesquisa && blocoFatos && fontes.length >= 2) {
    registrarPasso({
      kind: 'pensando',
      texto: 'Cruzando as fontes e montando o dossiê da matéria…',
    });
    try {
      const dossie = await deepseekService.montarDossieApuracao({
        pedido: pedidoDeAjuste && contextoMateriaAnterior
          ? `${contextoMateriaAnterior}\nAjuste solicitado: ${pedido}`
          : pedido,
        fatosFontes: blocoFatos,
      });
      if (dossie) {
        blocoFatos = `DOSSIÊ EDITORIAL EXTRAÍDO DAS FONTES (não substitui os trechos originais):\n${dossie}\n\n--- FONTES ORIGINAIS ---\n\n${blocoFatos}`;
        registrarPasso({
          kind: 'fontes',
          texto: 'Dossiê concluído: contexto, cronologia, posições e controvérsias organizados',
        });
      }
    } catch (err) {
      console.warn('[materia-chat] dossiê:', err.message);
      registrarPasso({
        kind: 'aviso',
        texto: 'Não consegui montar o dossiê; a matéria seguirá diretamente com as fontes lidas.',
      });
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
  // Pedido = só o link (ou "faça uma matéria" + link): o fato está no próprio
  // texto que o editor colou, então não gasta uma chamada de checagem.
  const soReescreverOLink = temFonteDoLink && pedidoSemUrls().length < 40;

  if ((usarPesquisa || temFonteDoLink) && !pedidoDeAjuste && !usuarioInsiste) {
    let checagem = null;
    if (blocoFatos && !soReescreverOLink) {
      registrarPasso({ kind: 'checagem', texto: 'Checando o pedido contra as fontes…' });
      try {
        checagem = await deepseekService.checarPedidoNasFontes({ pedido, fatosFontes: blocoFatos });
      } catch (err) {
        console.warn('[materia-chat] checagem:', err.message);
      }
    }

    const afirmaFato = !pedidoEmLote && (!checagem || checagem.tipoPedido === 'fato');
    const naoConfirmado = !blocoFatos || (checagem && checagem.confirmado === false);
    // Pedido = só o link (ou “faça matéria deste link”): o fato está no próprio
    // post/vídeo/matéria que o editor colou, então não precisa de confirmação extra.
    const pedidoCentadoNoLink =
      temFonteDoLink &&
      (pedidoEmLote || !checagem || checagem.tipoPedido === 'tema' || pedidoSemUrls().length < 40);

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

  // Um link novo é uma pauta nova. Não deixa uma matéria anterior da conversa
  // competir com a legenda que acabou de ser extraída do post atual.
  const historicoBase = urlsFonte.length && !pedidoDeAjuste ? [] : anteriores;
  const historico = historicoBase.map((m) => ({ role: m.role, content: m.content }));

  // Fontes que o editor colou: o nome do veículo tem de sair citado na matéria.
  const fontesColadas = fontes.filter((f) => f?.fonteColada || f?.ehRedeSocial);
  const veiculosColados = fontesColadas
    .map((f) => ({ veiculo: f.veiculo, url: f.url || null }))
    .filter((f) => f.veiculo);
  const fonteEstrangeira = fonteEmOutroIdioma(fontes);
  if (fonteEstrangeira) {
    registrarPasso({
      kind: 'pensando',
      texto: 'Fonte em outro idioma: traduzindo os fatos e as falas para português.',
    });
  }

  let resposta = '';
  try {
    if (pedidoEmLote && fontes.length > 1) {
      const partes = [];
      const instrucaoExtra = pedidoSemUrls();
      const urlsSelecionadas = new Set(urlsFonte.map(normalizarUrlComparacao).filter(Boolean));
      const fontesDoLote = (urlsSelecionadas.size
        ? fontes.filter((f) => urlsSelecionadas.has(normalizarUrlComparacao(f?.url)))
        : fontes
      ).slice(0, limiteMateriasLote || urlsFonte.length || fontes.length);
      for (let indiceFonte = 0; indiceFonte < fontesDoLote.length; indiceFonte += 1) {
        const fonteAtual = fontesDoLote[indiceFonte];
        const marcador = `### MATERIA ${indiceFonte + 1}`;
        registrarPasso({
          kind: 'escrevendo',
          texto: `Escrevendo matéria ${indiceFonte + 1} de ${fontesDoLote.length}: ${fonteAtual.veiculo || fonteAtual.url || 'link'}`,
        });
        onEvent({ tipo: 'delta', texto: `${indiceFonte ? '\n\n' : ''}${marcador}\n` });

        const textoMateria = await deepseekService.conversarMateria({
          pedido: [
            'Escreva UMA matéria somente sobre a fonte abaixo.',
            'Não use fatos, pessoas ou falas dos outros links enviados pelo editor.',
            instrucaoExtra && instrucaoExtra.length >= 8 ? `Instrução adicional: ${instrucaoExtra}` : null,
            `Link desta matéria: ${fonteAtual.url || ''}`,
          ]
            .filter(Boolean)
            .join('\n'),
          historico: [],
          fatosFontes: materiaIaService.montarBlocoFatos([fonteAtual]),
          tom,
          permitirSemConfirmacao: usuarioInsiste,
          veiculosColados: fonteAtual.veiculo
            ? [{ veiculo: fonteAtual.veiculo, url: fonteAtual.url || null }]
            : [],
          fonteEstrangeira: fonteEmOutroIdioma([fonteAtual]),
          onDelta: (delta) => onEvent({ tipo: 'delta', texto: delta }),
        });
        partes.push(`${marcador}\n${textoMateria}`);
      }
      resposta = partes.join('\n\n');
    } else {
      resposta = await deepseekService.conversarMateria({
        pedido,
        historico,
        fatosFontes: blocoFatos,
        tom,
        permitirSemConfirmacao: usuarioInsiste,
        veiculosColados,
        fonteEstrangeira,
        onDelta: (delta) => onEvent({ tipo: 'delta', texto: delta }),
      });
    }
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
      // Fonte em outro idioma: a fala traduzida nunca bate palavra por palavra
      // com o original — comparar aqui só geraria alarme falso.
      if (fonteEstrangeira) {
        for (const fala of citacoesNaoTraduzidas(texto)) {
          lista.push(`fala ainda no idioma da fonte (traduza): “${fala}”`);
        }
      } else {
        for (const fala of citacoesSemFonte(texto, contexto)) lista.push(`fala sem fonte: “${fala}”`);
      }
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

  const suspeitasIniciais = levantarSuspeitas(resposta);
  // Web desligada (ou link sem pedido de contexto): só reescreve/traduz o link.
  // Mesmo assim, revisa a resposta contra a legenda para impedir mistura de pauta.
  const soReescritaDoLink = Boolean(temFonteDoLink && !usarPesquisa);
  const pularRevisao = !temFonteDoLink && soReescreverOLink && !suspeitasIniciais.length;
  if (soReescritaDoLink && ehMateriaGerada) {
    registrarPasso({
      kind: 'fontes',
      texto: fonteEstrangeira
        ? 'Reescrita do link em português (sem plágio) — sem pesquisa em outras fontes.'
        : 'Reescrita do link sem plágio — sem pesquisa em outras fontes.',
    });
  }

  // Revisão frase a frase só quando houve pesquisa/apuração na web
  if (ehMateriaGerada && blocoFatos && !pularRevisao) {
    registrarPasso({ kind: 'checagem', texto: 'Revisando a matéria frase por frase contra as fontes…' });
    try {
      const revisao = await deepseekService.revisarMateriaContraFontes({
        texto: resposta,
        fatosFontes: blocoFatos,
        pedido,
        suspeitas: suspeitasIniciais,
        fonteEstrangeira,
        veiculosColados,
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
        for (const p of revisao.problemas.slice(0, 3)) {
          const curto = String(p).replace(/\s+/g, ' ').trim();
          registrarPasso({
            kind: 'checagem',
            texto: `Ajustado na checagem: ${curto.length > 140 ? `${curto.slice(0, 140)}…` : curto}`,
          });
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

  // Crédito da fonte no texto
  if (ehMateriaGerada && fontesColadas.length) {
    if (soReescritaDoLink) {
      resposta = montarRespostaComRodapeOffline(resposta, fontes);
      registrarPasso({
        kind: 'fontes',
        texto: 'Fonte e foto de crédito anexadas ao final da matéria.',
      });
    } else {
      const { texto: comCredito, inserido } = garantirCitacaoDoVeiculo(resposta, fontesColadas);
      if (inserido) {
        resposta = comCredito;
        registrarPasso({
          kind: 'fontes',
          texto: `Crédito da fonte acrescentado no texto: ${inserido}`,
        });
      }
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
  indice = null,
}) {
  const { montarRodapeMateriaComFontes } = require('./editorialGuidelinesFb');
  const materiaIaService = require('./materiaIaService');

  const row = await AiChatMessages.findByIdWithChat(messageId);
  if (!row || Number(row.chat_user_id) !== Number(userId)) {
    throw erro('Mensagem não encontrada', 404);
  }
  if (row.role !== 'assistant') throw erro('Só é possível salvar a resposta da IA', 400);

  // Resposta com várias matérias: cada índice salva um rascunho separado.
  const multiplas = separarMaterias(row.content);
  const idx = indice == null || indice === '' ? null : Number(indice);
  const escolhida =
    idx != null && multiplas.length ? multiplas.find((m) => Number(m.indice) === idx) : null;
  if (idx != null && multiplas.length && !escolhida) {
    throw erro('Matéria não encontrada nesta resposta', 404);
  }

  const salvosPrev = parseJson(row.matter_ids, {}) || {};
  if (escolhida) {
    const jaSalvo = salvosPrev[String(escolhida.indice)];
    if (jaSalvo) {
      const existente = await AiMatters.findById(jaSalvo);
      if (existente) {
        return {
          matterId: existente.id,
          redirect: `/materias-ia/${existente.id}`,
          indice: escolhida.indice,
          jaExistia: true,
        };
      }
    }
  } else if (row.matter_id) {
    const existente = await AiMatters.findById(row.matter_id);
    if (existente) {
      return { matterId: existente.id, redirect: `/materias-ia/${existente.id}`, jaExistia: true };
    }
  }

  const info = escolhida
    ? {
        titulo: escolhida.titulo,
        corpo: escolhida.corpo,
        hashtags: escolhida.hashtags,
        ehMateria: true,
      }
    : interpretarResposta(row.content);
  const corpo = String(info.corpo || (escolhida ? escolhida.conteudo : row.content) || '').trim();
  if (corpo.length < 120) throw erro('Essa resposta é curta demais para virar matéria', 400);

  const fontes = parseJson(row.fontes, []);
  const fontesLista = Array.isArray(fontes) ? fontes : [];
  const fonteDoIndice = escolhida ? fontesLista[Number(escolhida.indice)] : null;
  const fontesDaMateria = fonteDoIndice ? [fonteDoIndice] : fontesLista;
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
    fontes: fontesDaMateria,
    creditoImagem: creditoImagem || 'Reprodução',
    hashtags: info.hashtags || parseJson(row.hashtags, []),
  });
  const materia = rodape.materia;

  const titulo = info.titulo || row.titulo || 'Matéria do chat';
  const fontePrincipal = fontesDaMateria[0] || null;
  const imagemFonte =
    imagemUrl && /^https?:\/\//i.test(imagemUrl)
      ? imagemUrl
      : /^https?:\/\//i.test(String(fontePrincipal?.imagem || ''))
        ? String(fontePrincipal.imagem)
        : null;

  const [matterId] = await AiMatters.create({
    user_id: userId,
    facebook_page_id: pageId || null,
    titulo: titulo.slice(0, 180),
    materia,
    titulo_ia: titulo.slice(0, 180),
    materia_ia: materia,
    hashtags: JSON.stringify(info.hashtags || []),
    fonte_titulo: (() => {
      const colada = fontesDaMateria.find((f) => f.fonteColada && f.veiculo);
      if (colada) {
        return row.pesquisou_web
          ? `Chat de matérias + ${colada.veiculo} + pesquisa na web`
          : `Chat de matérias + ${colada.veiculo}`;
      }
      const rede = fontesDaMateria.find((f) => f.ehRedeSocial);
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
    contexto_apuracao: fontesDaMateria.length
      ? fontesDaMateria.map((f) => `${f.veiculo || 'Web'} — ${f.url || ''}`).join('\n').slice(0, 8000)
      : null,
    fonte_credito: rodape.fonteCredito || null,
    status: 'rascunho',
    tipo_publicacao: 'foto',
    imagem_url: imagemFonte,
    error_message: null,
  });

  if (escolhida) {
    const mapa = { ...salvosPrev, [String(escolhida.indice)]: matterId };
    const patch = { matter_ids: JSON.stringify(mapa) };
    // matter_id continua apontando para o primeiro rascunho salvo da mensagem.
    if (!row.matter_id) patch.matter_id = matterId;
    try {
      await AiChatMessages.update(row.id, patch);
    } catch (err) {
      // Se a coluna matter_ids ainda não existe (migração não rodou), não perde
      // o rascunho já criado: grava só o vínculo antigo.
      console.warn('[materia-chat] matter_ids indisponível:', err.code || err.message);
      if (!row.matter_id) {
        await AiChatMessages.update(row.id, { matter_id: matterId });
      }
    }
  } else {
    await AiChatMessages.update(row.id, { matter_id: matterId });
  }

  if (imagemFonte) {
    try {
      const { composeMatterArtwork } = require('./matterArtworkService');
      await composeMatterArtwork({
        userId,
        matterId,
        sourceUrl: imagemFonte,
        title: titulo,
        force: true,
      });
    } catch (err) {
      console.warn('[materia-chat] arte:', err.message);
      await AiMatters.update(matterId, {
        imagem_url: imagemFonte,
        imagem_fonte_url: imagemFonte,
      });
    }
  }

  return {
    matterId,
    redirect: `/materias-ia/${matterId}`,
    ...(escolhida ? { indice: escolhida.indice } : {}),
  };
}

/**
 * Salva de uma vez todas as matérias de uma resposta com várias
 * (ex.: "escreva 5 matérias sobre X" → 5 rascunhos).
 */
async function salvarTodasAsMateriasDoChat({
  userId,
  messageId,
  facebookPageId = null,
  creditoImagem = null,
}) {
  const row = await AiChatMessages.findByIdWithChat(messageId);
  if (!row || Number(row.chat_user_id) !== Number(userId)) {
    throw erro('Mensagem não encontrada', 404);
  }

  const multiplas = separarMaterias(row.content);
  if (multiplas.length < 2) {
    throw erro('Esta resposta tem só uma matéria. Use “Salvar como rascunho”.', 400);
  }

  const salvas = [];
  const erros = [];

  for (const materia of multiplas) {
    if (!materia.salvavel) {
      erros.push({ indice: materia.indice, titulo: materia.titulo, error: 'Texto curto demais' });
      continue;
    }
    try {
      const r = await salvarMateriaDoChat({
        userId,
        messageId,
        facebookPageId,
        creditoImagem,
        indice: materia.indice,
      });
      salvas.push({
        indice: materia.indice,
        titulo: materia.titulo,
        matterId: r.matterId,
        redirect: r.redirect,
        jaExistia: Boolean(r.jaExistia),
      });
    } catch (err) {
      erros.push({ indice: materia.indice, titulo: materia.titulo, error: err.message });
    }
  }

  return {
    total: multiplas.length,
    salvas,
    erros,
    mensagem: `${salvas.length} rascunho(s) criado(s)${erros.length ? ` · ${erros.length} falha(s)` : ''}.`,
  };
}

function limparPautaParaRascunho(pauta) {
  if (!pauta || typeof pauta !== 'object') return null;
  const titulo = String(pauta.titulo || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const url = String(pauta.url || pauta.link || '').trim().slice(0, 600);
  const veiculo = String(pauta.veiculo || pauta.fonte || 'Web')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  const resumo = String(pauta.resumo || pauta.trecho || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1200);
  if (!titulo && !url && !resumo) return null;
  return { titulo, url, veiculo, resumo };
}

function montarInformacoesDaPauta(pauta) {
  return [
    'Gere uma materia jornalistica original a partir desta pauta selecionada na pesquisa.',
    'Reescreva sem plagiar, nao copie trechos do veiculo original e nao misture com outra pauta.',
    'Busque um angulo de furo de reportagem: explique a repercussao, contexto, bastidores publicos, impacto para o publico evangelico/gospel e o que ainda precisa ser acompanhado.',
    '',
    pauta.titulo ? `Titulo da pauta: ${pauta.titulo}` : null,
    pauta.veiculo ? `Veiculo/Fonte: ${pauta.veiculo}` : null,
    pauta.url ? `Link principal: ${pauta.url}` : null,
    pauta.resumo ? `Resumo encontrado: ${pauta.resumo}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Fluxo curto para o modo "Pesquisar pautas": seleciona as pautas encontradas,
 * gera cada materia em separado e ja salva como rascunho.
 */
async function salvarPautasComoRascunhos({
  userId,
  pautas = [],
  facebookPageId = null,
  pesquisarWeb = true,
  periodo = '30d',
}) {
  const lista = (Array.isArray(pautas) ? pautas : [])
    .map(limparPautaParaRascunho)
    .filter(Boolean)
    .slice(0, 8);

  if (!lista.length) throw erro('Selecione ao menos uma pauta para salvar.', 400);

  const materiaIaService = require('./materiaIaService');
  const salvas = [];
  const erros = [];

  for (let i = 0; i < lista.length; i += 1) {
    const pauta = lista[i];
    try {
      const payload = {
        userId,
        facebookPageId,
        informacoes: montarInformacoesDaPauta(pauta),
        angulo: 'Furo de reportagem para publico gospel/evangelico, com contexto e repercussao',
        tom: 'natural',
        pesquisarWeb,
        palavrasChave: [pauta.titulo, pauta.veiculo].filter(Boolean).join(' '),
        periodo,
        imagemUrl: null,
        creditoImagem: pauta.veiculo || 'Reproducao',
      };
      let result;
      try {
        result = await materiaIaService.gerarMateriaManual(payload);
      } catch (err) {
        if (!pesquisarWeb || err.status !== 422) throw err;
        result = await materiaIaService.gerarMateriaManual({ ...payload, pesquisarWeb: false });
      }
      salvas.push({
        indice: i + 1,
        titulo: result.matter?.titulo || pauta.titulo || 'Materia',
        matterId: result.matter?.id,
        redirect: result.matter?.id ? `/materias-ia/${result.matter.id}` : '/minhas-materias',
        pauta,
      });
    } catch (err) {
      erros.push({
        indice: i + 1,
        titulo: pauta.titulo || 'Pauta',
        error: err.message || 'Falha ao gerar rascunho',
      });
    }
  }

  if (!salvas.length) {
    throw erro(erros[0]?.error || 'Nao foi possivel salvar os rascunhos das pautas.', 422);
  }

  return {
    total: lista.length,
    salvas,
    erros,
    mensagem: `${salvas.length} rascunho(s) criado(s)${erros.length ? ` - ${erros.length} falha(s)` : ''}.`,
  };
}

module.exports = {
  listarConversas,
  criarConversa,
  obterConversa,
  renomearConversa,
  excluirConversa,
  apagarMensagemEmDiante,
  responder,
  salvarMateriaDoChat,
  salvarTodasAsMateriasDoChat,
  salvarPautasComoRascunhos,
  interpretarResposta,
  separarMaterias,
  extrairUrlsDoTexto,
  extrairFontesDeArtigos,
  garantirCitacaoDoVeiculo,
  fonteEmOutroIdioma,
};
