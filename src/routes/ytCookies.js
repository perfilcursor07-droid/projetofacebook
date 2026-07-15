const express = require('express');
const multer = require('multer');
const ytCookiesController = require('../controllers/ytCookiesController');

const router = express.Router();

const uploadTxt = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // mesmo limite aceito pelo ytDlpAuth
  fileFilter(_req, file, cb) {
    if (!file.originalname.toLowerCase().endsWith('.txt')) {
      return cb(new Error('Envie um arquivo .txt (formato Netscape cookies.txt).'));
    }
    cb(null, true);
  },
}).single('arquivo');

router.get('/status', ytCookiesController.getStatus);
router.post('/test', ytCookiesController.test);
router.post('/', (req, res, next) => {
  uploadTxt(req, res, (err) => {
    if (err) {
      err.status = err.status || 400;
      return next(err);
    }
    next();
  });
}, ytCookiesController.upload);

module.exports = router;
