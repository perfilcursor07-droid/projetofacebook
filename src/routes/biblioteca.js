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
router.get('/agenda', controller.listarAgenda);
router.post('/agenda/montar', controller.montarAgenda);
router.post('/agenda/compactar', controller.compactarAgenda);
router.post('/agenda/limpar-sem-keyword', controller.limparAgendaSemKeyword);
router.post('/agenda/lote', controller.loteAgenda);
router.patch('/agenda/:id', controller.atualizarAgendaItem);
router.post('/agenda/:id/confirmar', controller.confirmarAgendaItem);
router.post('/agenda/:id/publicar', controller.publicarAgendaItem);
router.delete('/agenda/:id', controller.excluirAgendaItem);

module.exports = router;
