/**
 * Extras do chat de matérias (/materia-manual):
 *  - "Em alta": radar dos assuntos do momento para o usuário escolher.
 *  - Anexo PDF: devolve o texto extraído para virar base da matéria.
 *
 * Fica separado do router principal de propósito: o chat existente não muda.
 */
const express = require('express');
const { uploadChatDoc } = require('../middleware/uploadChatDoc');

const router = express.Router();

/** Radar de assuntos em alta agora. */
router.post('/em-alta', async (req, res, next) => {
  try {
    const materiaIaService = require('../services/materiaIaService');
    const body = req.body || {};
    const extras = String(body.palavrasExtras || body.palavras_extras || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);
    const horas = Number(body.horas) === 48 ? 48 : 24;

    const resultado = await materiaIaService.buscarEmAltaAgora(extras, { horas });

    const topicos = (resultado?.topicos || [])
      .filter((t) => t && t.titulo && (t.link || t.url))
      .map((t) => ({
        titulo: String(t.titulo).replace(/\s+/g, ' ').trim().slice(0, 300),
        url: String(t.link || t.url).trim().slice(0, 500),
        veiculo: String(t.veiculo || t.fonte || 'Web').replace(/\s+/g, ' ').trim().slice(0, 80),
        resumo: String(t.resumo || t.trecho || '').replace(/\s+/g, ' ').trim().slice(0, 320),
        contagemFontes: Number(t.contagemFontes) || 1,
        calor: Number(t.calor) || 0,
      }));

    return res.json({
      ok: true,
      horas,
      totalAnalisado: Number(resultado?.totalAnalisado) || 0,
      topicos,
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * Anexo PDF. O arquivo não é guardado: o texto volta para o navegador,
 * que o envia junto da mensagem do chat.
 */
router.post('/anexos', (req, res, next) => {
  uploadChatDoc(req, res, async (uploadError) => {
    if (uploadError) {
      const mensagem =
        uploadError.code === 'LIMIT_FILE_SIZE'
          ? 'PDF muito grande. O limite é 15 MB.'
          : uploadError.message || 'Falha ao receber o arquivo';
      return res.status(uploadError.status || 400).json({ error: mensagem });
    }

    try {
      if (!req.file?.buffer?.length) {
        return res.status(400).json({ error: 'Escolha um arquivo PDF para enviar.' });
      }
      const { extrairTextoDePdf } = require('../services/documentText');
      const doc = await extrairTextoDePdf(req.file.buffer);
      const nome =
        String(req.file.originalname || 'documento.pdf')
          .replace(/[\r\n\t]+/g, ' ')
          .trim()
          .slice(0, 200) || 'documento.pdf';
      return res.json({ ok: true, anexo: { nome, ...doc } });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      return next(err);
    }
  });
});

module.exports = router;
