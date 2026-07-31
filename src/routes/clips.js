const express = require('express');
const clipsController = require('../controllers/clipsController');
const publicationsController = require('../controllers/publicationsController');
const { uploadSplitImage } = require('../middleware/uploadSplitImage');

const router = express.Router();

router.post('/:id/transcribe', clipsController.transcribe);
router.post('/:id/materia', clipsController.gerarMateria);
router.post('/:id/retry', clipsController.retryClip);
router.post('/:id/capa', clipsController.gerarCapa);
router.post('/:id/capa/sugerir-titulo', clipsController.sugerirTituloCapa);
router.delete('/:id/capa', clipsController.removerCapa);
router.post('/:id/bgm', clipsController.aplicarBgm);

router.get('/:id/status', clipsController.statusClip);

// Tela dividida (imagem + vídeo meio a meio)
router.get('/:id/split/imagens', clipsController.buscarImagensDoSplit);
router.get('/:id/split/frames', clipsController.listarFramesDoSplit);
router.post('/:id/split/enquadrar', clipsController.reenquadrarSplit);
router.post('/:id/split/sugerir-texto', clipsController.sugerirTextoSplit);
// uploadSplitImage ignora requisições que não são multipart, então o mesmo
// endpoint atende imagem da busca (JSON) e upload de arquivo.
router.post('/:id/split', uploadSplitImage, clipsController.montarSplit);
router.delete('/:id/split', clipsController.removerSplit);

router.delete('/:id', clipsController.removeClip);
router.post('/:id/publish', publicationsController.publishClip);

module.exports = router;
