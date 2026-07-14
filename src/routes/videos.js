const express = require('express');
const videosController = require('../controllers/videosController');
const { uploadVideo } = require('../middleware/upload');

const router = express.Router();

router.get('/', videosController.list);
router.get('/search', videosController.search);
router.post('/upload', (req, res, next) => {
  uploadVideo(req, res, (err) => {
    if (err) {
      err.status = err.status || 400;
      return next(err);
    }
    next();
  });
}, videosController.upload);
router.post('/import', videosController.importLink);
router.post('/:pexelsId/select', videosController.selectVideo);
router.post('/:id/download', videosController.download);
router.post('/:id/clip', videosController.clip);
router.post('/:id/clip-auto', videosController.clipAuto);
router.delete('/:id', videosController.removeVideo);

module.exports = router;
