const chatService = require('../services/materiaChatService');

async function listar(req, res, next) {
  try {
    const conversas = await chatService.listarConversas(req.session.userId);
    return res.json({ conversas });
  } catch (err) {
    return next(err);
  }
}

async function criar(req, res, next) {
  try {
    const chat = await chatService.criarConversa({
      userId: req.session.userId,
      titulo: req.body?.titulo || null,
    });
    return res.status(201).json({ ok: true, chat });
  } catch (err) {
    return next(err);
  }
}

async function obter(req, res, next) {
  try {
    const chat = await chatService.obterConversa({
      userId: req.session.userId,
      chatId: Number(req.params.id),
    });
    return res.json({ chat });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

async function renomear(req, res, next) {
  try {
    const chat = await chatService.renomearConversa({
      userId: req.session.userId,
      chatId: Number(req.params.id),
      titulo: req.body?.titulo,
    });
    return res.json({ ok: true, chat });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

async function excluir(req, res, next) {
  try {
    await chatService.excluirConversa({
      userId: req.session.userId,
      chatId: Number(req.params.id),
    });
    return res.json({ ok: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

/** Editar um pedido: apaga a mensagem e tudo que veio depois dela. */
async function apagarDaMensagem(req, res, next) {
  try {
    const resultado = await chatService.apagarMensagemEmDiante({
      userId: req.session.userId,
      chatId: Number(req.params.id),
      messageId: Number(req.params.messageId),
    });
    return res.json({ ok: true, ...resultado });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

/**
 * Resposta em NDJSON: cada linha é um evento (passo da pesquisa, pedaço do
 * texto, fim). O front lê com fetch + ReadableStream.
 */
async function enviar(req, res, next) {
  const body = req.body || {};
  const chatIdParam = req.params.id && req.params.id !== 'nova' ? Number(req.params.id) : null;

  res.status(200);
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  let encerrado = false;
  req.on('close', () => {
    encerrado = true;
  });

  const enviarEvento = (evento) => {
    if (encerrado || res.writableEnded) return;
    res.write(`${JSON.stringify(evento)}\n`);
  };

  // Transcrição local pode levar alguns minutos. Mantém o stream vivo sem
  // adicionar etapas visíveis enquanto yt-dlp/Whisper processam o áudio.
  const heartbeat = setInterval(() => enviarEvento({ tipo: 'ping' }), 15_000);

  try {
    await chatService.responder({
      userId: req.session.userId,
      chatId: chatIdParam,
      texto: body.texto || body.mensagem || '',
      pesquisarWeb: ['1', 'true', 'on', 'sim'].includes(
        String(body.pesquisarWeb ?? body.pesquisar_web ?? '').toLowerCase()
      ),
      tom: body.tom || 'natural',
      periodo: body.periodo || undefined,
      palavrasChave: body.palavrasChave || null,
      modo: body.modo === 'pautas' ? 'pautas' : 'escrever',
      transcreverVideo:
        body.transcreverVideo == null
          ? true
          : ['1', 'true', 'on', 'sim'].includes(String(body.transcreverVideo).toLowerCase()),
      onEvent: enviarEvento,
    });
    clearInterval(heartbeat);
    return res.end();
  } catch (err) {
    clearInterval(heartbeat);
    // Erro de banco/driver traz SQL e dados na mensagem: fica no log, não na tela.
    const ehErroInterno = Boolean(err.sql || err.sqlMessage || err.code);
    if (ehErroInterno) {
      console.error('[materia-chat] erro interno:', err.code || '', err.sqlMessage || err.message);
    }
    const paraUsuario = ehErroInterno
      ? 'Não consegui salvar esta resposta agora. Tente enviar de novo.'
      : err.message || 'Falha ao gerar a resposta';

    if (!res.headersSent) {
      if (ehErroInterno) return res.status(500).json({ error: paraUsuario });
      return next(err);
    }
    enviarEvento({ tipo: 'erro', erro: paraUsuario });
    return res.end();
  }
}

async function salvarMateria(req, res, next) {
  try {
    const resultado = await chatService.salvarMateriaDoChat({
      userId: req.session.userId,
      messageId: Number(req.params.messageId),
      facebookPageId: req.body?.facebookPageId || req.body?.facebook_page_id || null,
      imagemUrl: req.body?.imagemUrl || req.body?.imagem_url || null,
      creditoImagem: req.body?.creditoImagem || req.body?.credito_imagem || null,
      indice: req.body?.indice ?? req.body?.index ?? null,
      // Título alternativo escolhido pelo editor no chat (opcional).
      titulo: req.body?.titulo || req.body?.tituloEscolhido || null,
    });
    return res.status(201).json({ ok: true, ...resultado });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

/** Salva todas as matérias de uma resposta que trouxe várias. */
async function salvarTodasAsMaterias(req, res, next) {
  try {
    const resultado = await chatService.salvarTodasAsMateriasDoChat({
      userId: req.session.userId,
      messageId: Number(req.params.messageId),
      facebookPageId: req.body?.facebookPageId || req.body?.facebook_page_id || null,
      creditoImagem: req.body?.creditoImagem || req.body?.credito_imagem || null,
      indices: req.body?.indices ?? null,
    });
    return res.status(201).json({ ok: true, ...resultado });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

/** Gera e salva rascunhos diretamente a partir das pautas selecionadas. */
async function salvarPautasComoRascunhos(req, res, next) {
  try {
    const resultado = await chatService.salvarPautasComoRascunhos({
      userId: req.session.userId,
      pautas: req.body?.pautas,
      facebookPageId: req.body?.facebookPageId || req.body?.facebook_page_id || null,
      pesquisarWeb: req.body?.pesquisarWeb !== false && req.body?.pesquisar_web !== false,
      periodo: req.body?.periodo || '30d',
    });
    return res.status(201).json({ ok: true, ...resultado });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

/**
 * "Ensinar a IA" no chat: memória editorial do editor.
 * O editor escreve as regras uma vez e elas valem para as próximas matérias.
 */
async function obterOrientacoes(req, res, next) {
  try {
    const learning = require('../services/editorialLearningService');
    const dados = await learning.obterOrientacoes(req.session.userId);
    return res.json({ ok: true, ...dados });
  } catch (err) {
    return next(err);
  }
}

async function salvarOrientacoes(req, res, next) {
  try {
    const learning = require('../services/editorialLearningService');
    const texto = String(req.body?.orientacoes ?? req.body?.texto ?? '');
    if (texto.length > 8000) {
      return res.status(400).json({ error: 'Orientações muito longas. Resuma em regras curtas.' });
    }
    const acrescentar = req.body?.acrescentar === true || req.body?.modo === 'acrescentar';
    const salvo = acrescentar
      ? await learning.acrescentarOrientacao(req.session.userId, texto)
      : await learning.salvarOrientacoes(req.session.userId, texto);
    return res.json({ ok: true, ...salvo });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  listar,
  criar,
  obter,
  renomear,
  excluir,
  apagarDaMensagem,
  enviar,
  salvarMateria,
  salvarTodasAsMaterias,
  salvarPautasComoRascunhos,
  obterOrientacoes,
  salvarOrientacoes,
};
