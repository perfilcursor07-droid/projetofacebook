const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { env } = require('../config/env');

/**
 * Baixa uma URL para um arquivo dentro de storage/.
 * @param {string} url
 * @param {string} relativeDest ex: "videos/video_1.mp4"
 * @returns {Promise<string>} caminho relativo salvo
 */
async function downloadToStorage(url, relativeDest) {
  const destPath = path.resolve(env.storagePath, relativeDest);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  const response = await axios.get(url, {
    responseType: 'stream',
    timeout: 120000,
    maxRedirects: 5,
  });

  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(destPath);
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
    response.data.on('error', reject);
  });

  return relativeDest;
}

function storageAbsolutePath(relativePath) {
  return path.resolve(env.storagePath, relativePath);
}

module.exports = { downloadToStorage, storageAbsolutePath };
