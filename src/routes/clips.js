const express = require('express');
const clipsController = require('../controllers/clipsController');
const publicationsController = require('../controllers/publicationsController');
const { uploadSplitImage } = require('../middleware/uploadSplitImage');

const router = express.Router();

router.post('/:id/transcribe', clipsController.transcribe);
router.post('/:id/materia', clipsController.gerarMateria);
router.post('/:id/retry', clipsController.retryClip);
router.post('/:id/capa', clipsController.gerarCapa);
router.delete('/:id/capa', clipsController.removerCapa);

// Tela dividida (imagem + vídeo meio a meio)
router.get('/:id/split/imagens', clipsController.buscarImagensDoSplit);
router.get('/:id/split/frames', clipsController.listarFramesDoSplit);
router.post('/:id/split/enquadrar', clipsController.reenquadrarSplit);
// uploadSplitImage ignora requisições que não são multipart, então o mesmo
// endpoint atende imagem da busca (JSON) e upload de arquivo.
router.post('/:id/split', uploadSplitImage, clipsController.montarSplit);
router.delete('/:id/split', clipsController.removerSplit);

router.delete('/:id', clipsController.removeClip);
router.post('/:id/publish', publicationsController.publishClip);

module.exports = router;
