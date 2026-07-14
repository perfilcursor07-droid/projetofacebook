const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { env } = require('../config/env');

const uploadDir = path.resolve(env.storagePath, 'logos', 'tmp');
const allowed = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp'],
]);

const storage = multer.diskStorage({
  destination(_req, _file, cb) {
    fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename(req, file, cb) {
    const ext = allowed.get(file.mimetype) || path.extname(file.originalname).toLowerCase();
    cb(null, `logo_${req.session.userId}_${Date.now()}${ext}`);
  },
});

const uploadLogo = multer({
  storage,
  limits: { fileSize: 3 * 1024 * 1024, files: 1 },
  fileFilter(_req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    const validExt = ['.png', '.jpg', '.jpeg', '.webp'].includes(ext);
    if (!allowed.has(file.mimetype) || !validExt) {
      const err = new Error('Logo inválida. Envie PNG, JPG ou WebP de até 3 MB.');
      err.status = 400;
      return cb(err);
    }
    cb(null, true);
  },
}).single('logo');

module.exports = { uploadLogo };
