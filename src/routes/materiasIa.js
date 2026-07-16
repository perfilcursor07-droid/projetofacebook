const express = require('express');
const controller = require('../controllers/materiasIaController');

const router = express.Router();

router.post('/pesquisar', controller.pesquisar);
router.post('/em-alta', controller.emAlta);
router.post('/reescrever-link', controller.reescreverLink);
router.post('/gerar', controller.gerar);
router.post('/gerar-preview', controller.gerarPreview);
router.post('/gerar-lote', controller.gerarLote);
router.get('/matters', controller.listarMaterias);
router.put('/matters/:id', controller.atualizarMateria);
router.patch('/matters/:id', controller.atualizarMateria);
router.delete('/matters/:id', controller.removerMateria);
router.post('/matters/:id/publicar', controller.publicar);
router.post('/matters/:id/agendar', controller.agendar);
router.post('/matters/:id/sugerir-titulo', controller.sugerirTitulo);
router.post('/monitor', controller.monitorCriar);
router.get('/monitor', controller.monitorLista);
router.post('/monitor/:id/pausar', controller.monitorPausar);
router.post('/monitor/:id/retomar', controller.monitorRetomar);

module.exports = router;
