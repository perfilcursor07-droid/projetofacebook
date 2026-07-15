const express = require('express');
const clipsController = require('../controllers/clipsController');
const publicationsController = require('../controllers/publicationsController');

const router = express.Router();

router.post('/:id/transcribe', clipsController.transcribe);
router.post('/:id/materia', clipsController.gerarMateria);
router.post('/:id/retry', clipsController.retryClip);
router.post('/:id/capa', clipsController.gerarCapa);
router.delete('/:id/capa', clipsController.removerCapa);
router.delete('/:id', clipsController.removeClip);
router.post('/:id/publish', publicationsController.publishClip);

module.exports = router;
