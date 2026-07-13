const express = require('express');
const imagensController = require('../controllers/imagensController');

const router = express.Router();

router.get('/', imagensController.list);
router.get('/search', imagensController.search);
router.post('/:pexelsId/select', imagensController.selectImage);
router.post('/:id/download', imagensController.download);
router.post('/:id/publish', require('../controllers/publicationsController').publishImage);

module.exports = router;
