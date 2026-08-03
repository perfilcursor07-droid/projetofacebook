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

  try {
    await chatService.responder({
      userId: req.session.userId,
      chatId: chatIdParam,
      texto: body.texto || body.mensagem || '',
      pesquisarWeb: body.pesquisarWeb !== false && body.pesquisarWeb !== '0',
      tom: body.tom || 'natural',
      periodo: body.periodo || undefined,
      palavrasChave: body.palavrasChave || null,
      modo: body.modo === 'pautas' ? 'pautas' : 'escrever',
      onEvent: enviarEvento,
    });
    return res.end();
  } catch (err) {
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
    });
    return res.status(201).json({ ok: true, ...resultado });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
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
};
