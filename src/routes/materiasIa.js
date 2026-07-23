const express = require('express');
const controller = require('../controllers/materiasIaController');
const { uploadMatterImage } = require('../middleware/uploadMatterImage');

const router = express.Router();

router.post('/pesquisar', controller.pesquisar);
router.post('/em-alta', controller.emAlta);
router.post('/radar-face', controller.radarFace);
router.post('/reescrever-link', controller.reescreverLink);
router.post('/gerar', controller.gerar);
router.post('/gerar-preview', controller.gerarPreview);
router.post('/gerar-lote', controller.gerarLote);
router.post('/gerar-manual', (req, res, next) => {
  uploadMatterImage(req, res, (uploadError) => {
    if (uploadError) {
      return res.status(uploadError.status || 400).json({ error: uploadError.message });
    }
    return controller.gerarManual(req, res, next);
  });
});
router.get('/matters', controller.listarMaterias);
router.get('/matters/:id', controller.obterMateria);
router.put('/matters/:id', controller.atualizarMateria);
router.patch('/matters/:id', controller.atualizarMateria);
router.delete('/matters/:id', controller.removerMateria);
router.post('/matters/:id/publicar', controller.publicar);
router.post('/matters/:id/agendar', controller.agendar);
router.post('/matters/:id/variacao', controller.gerarVariacao);
router.post('/matters/:id/views', controller.atualizarViews);
router.get('/matters/:id/views', controller.atualizarViews);
router.post('/matters/:id/sugerir-titulo', controller.sugerirTitulo);
router.post('/matters/:id/reescrever-com-info', controller.reescreverComInfo);
router.post('/matters/:id/enriquecer-fontes', controller.enriquecerFontes);
router.post('/matters/:id/buscar-imagem-fonte', controller.buscarImagemFonte);
router.post('/matters/:id/sugerir-imagens', controller.sugerirImagens);
router.post('/matters/:id/aplicar-imagem-url', controller.aplicarImagemUrl);
router.post('/monitor', controller.monitorCriar);
router.get('/monitor', controller.monitorLista);
router.post('/monitor/:id/pausar', controller.monitorPausar);
router.post('/monitor/:id/retomar', controller.monitorRetomar);
router.get('/links', controller.linksLista);
router.post('/links', controller.linksSalvar);
router.delete('/links/:id', controller.linksRemover);

module.exports = router;
