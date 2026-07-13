const pexelsService = require('../services/pexelsService');
const Imagens = require('../models/Imagens');
const processingService = require('../services/processingService');

/** Enfileira o download do arquivo da imagem. */
async function download(req, res, next) {
  try {
    const imagem = await Imagens.findById(req.params.id);
    if (!imagem || imagem.user_id !== req.session.userId) {
      const err = new Error('Imagem não encontrada');
      err.status = 404;
      throw err;
    }
    if (imagem.status === 'baixado') {
      return res.json({ imagem, queued: false, message: 'Imagem já baixada' });
    }

    processingService.queueImageDownload(imagem);
    res.status(202).json({ queued: true, message: 'Download enfileirado' });
  } catch (err) {
    next(err);
  }
}

async function list(req, res, next) {
  try {
    const userId = req.session.userId;
    if (!userId) {
      const err = new Error('Usuário não autenticado');
      err.status = 401;
      throw err;
    }

    const imagens = await Imagens.findByUser(userId, {
      status: req.query.status || undefined,
    });
    res.json({ imagens });
  } catch (err) {
    next(err);
  }
}

async function search(req, res, next) {
  try {
    const termo = req.query.termo || req.query.q || '';
    const result = await pexelsService.searchPhotos(termo, {
      page: req.query.page,
      perPage: req.query.per_page || req.query.perPage,
    });
    res.json(result);
  } catch (err) {
    if (err.response?.status === 401 || err.response?.status === 403) {
      err.status = 502;
      err.message = 'Falha de autenticação na Pexels. Verifique PEXELS_API_KEY.';
    } else if (err.response?.status === 429) {
      err.status = 429;
      err.message = 'Rate limit da Pexels atingido. Tente novamente em alguns minutos.';
    } else if (err.response) {
      err.status = 502;
      err.message = err.response.data?.error || 'Erro ao consultar a Pexels API';
    }
    next(err);
  }
}

/**
 * Registra a imagem no banco (status pendente) a partir do ID Pexels.
 */
async function selectImage(req, res, next) {
  try {
    const pexelsId = req.params.pexelsId;
    const termo = (req.body.termo || req.query.termo || '').trim() || 'sem termo';
    const userId = req.session.userId;

    if (!userId) {
      const err = new Error('Usuário não autenticado');
      err.status = 401;
      throw err;
    }

    const existing = await Imagens.findByPexelsId(userId, pexelsId);
    if (existing) {
      return res.json({ imagem: existing, created: false });
    }

    const remote = await pexelsService.getPhotoById(pexelsId);
    if (!remote.urlOriginal) {
      const err = new Error('Imagem sem arquivo disponível');
      err.status = 422;
      throw err;
    }

    const [id] = await Imagens.create({
      user_id: userId,
      termo_busca: termo,
      pexels_id: remote.pexelsId,
      url_original: remote.urlOriginal,
      thumbnail: remote.thumbnail,
      largura: remote.largura,
      altura: remote.altura,
      autor: remote.autor,
      autor_url: remote.autorUrl,
      status: 'pendente',
      metadata: {
        pexels_url: remote.url,
        alt: remote.alt,
        cor_media: remote.corMedia,
      },
    });

    const imagem = await Imagens.findById(id);
    res.status(201).json({ imagem, created: true });
  } catch (err) {
    if (err.response) {
      err.status = 502;
      err.message = 'Não foi possível obter a imagem na Pexels';
    }
    next(err);
  }
}

module.exports = {
  list,
  search,
  selectImage,
  download,
};
