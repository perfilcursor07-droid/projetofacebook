const path = require('path');
const multer = require('multer');

/**
 * Anexo do chat de matérias. Fica em memória: o texto é extraído na hora
 * e o arquivo não precisa ser guardado em disco.
 */
const uploadChatDoc = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter(_req, file, cb) {
    const extensao = path.extname(file.originalname || '').toLowerCase();
    const tipoOk = file.mimetype === 'application/pdf' || file.mimetype === 'application/x-pdf';
    if (!tipoOk || extensao !== '.pdf') {
      const error = new Error('Envie um arquivo PDF de até 15 MB.');
      error.status = 400;
      return cb(error);
    }
    return cb(null, true);
  },
}).single('arquivo');

module.exports = { uploadChatDoc };
