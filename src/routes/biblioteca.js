const express = require('express');
const controller = require('../controllers/bibliotecaController');

const router = express.Router();

router.get('/', controller.listar);
router.post('/fontes', controller.criar);
router.patch('/fontes/:id', controller.atualizar);
router.delete('/fontes/:id', controller.remover);
router.post('/fontes/:id/escanear', controller.escanear);
router.get('/fontes/:id/posts', controller.postsDaFonte);
router.post('/posts/:postId/gerar-texto', controller.gerarTexto);
router.post('/posts/:postId/gerar-video', controller.gerarVideo);
router.post('/posts/:postId/publicar', controller.publicarDireto);
router.get('/alertas', controller.listarAlertas);
router.put('/alertas/keywords', controller.salvarAlertasKeywords);
router.post('/alertas/:id/lido', controller.marcarAlertaLido);
router.post('/alertas/lidos', controller.marcarTodosLidos);
router.get('/melhores', controller.listarMelhores);
router.post('/melhores/analisar', controller.analisarMelhores);
router.delete('/melhores/:postId', controller.ocultarMelhor);
router.get('/autopilot', controller.getAutopilot);
router.put('/autopilot', controller.putAutopilot);

module.exports = router;
