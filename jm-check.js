require('dotenv').config();
const card = require('./src/services/editorialCardService');
const { ART_MODELS } = require('./src/services/editorialCardModels');
(async () => {
  const user = {
    id: 1, marca_nome: 'JM NOTÍCIA', marca_rodape: 'JMNOTICIA.COM.BR',
    marca_cor_primaria: '#f5b301', marca_cor_secundaria: '#1d5fa8', logo_path: 'logos/user_1.png',
  };
  for (const m of ART_MODELS) {
    try {
      const png = await card.buildBrandModelPreviewPng({ user, model: m.id, width: 432, height: 540 });
      console.log(String(m.id).padEnd(20), 'ok', String(png.length).padStart(7), 'bytes');
    } catch (e) {
      console.log(String(m.id).padEnd(20), 'ERRO:', e.message);
    }
  }
})();
