const path = require('path');
const multer = require('multer');

const allowedTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);
const allowedExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp']);

const uploadMatterImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 1 },
  fileFilter(_req, file, cb) {
    const extension = path.extname(file.originalname || '').toLowerCase();
    if (!allowedTypes.has(file.mimetype) || !allowedExtensions.has(extension)) {
      const error = new Error('Imagem inválida. Envie PNG, JPG ou WebP de até 12 MB.');
      error.status = 400;
      return cb(error);
    }
    return cb(null, true);
  },
}).single('imagem');

module.exports = { uploadMatterImage };