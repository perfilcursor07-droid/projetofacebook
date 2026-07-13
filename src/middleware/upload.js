const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { env } = require('../config/env');

const uploadDir = path.resolve(env.storagePath, 'videos');

const storage = multer.diskStorage({
  destination(_req, _file, cb) {
    fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename(_req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase() || '.mp4';
    cb(null, `upload_${Date.now()}_${Math.round(Math.random() * 1e6)}${ext}`);
  },
});

const ALLOWED_EXT = ['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v'];

const uploadVideo = multer({
  storage,
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1 GB
  fileFilter(_req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) {
      return cb(new Error(`Formato não suportado (${ext}). Use: ${ALLOWED_EXT.join(', ')}`));
    }
    cb(null, true);
  },
}).single('arquivo');

module.exports = { uploadVideo };
