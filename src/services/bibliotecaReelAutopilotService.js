const AiMatters = require('../models/AiMatters');
const BibliotecaAutopilot = require('../models/BibliotecaAutopilot');
const BibliotecaPosts = require('../models/BibliotecaPosts');
const Publications = require('../models/Publications');
const VideoClips = require('../models/VideoClips');
const Videos = require('../models/Videos');

const publishingMatters = new Set();

function metadataOf(video) {
  if (video?.metadata && typeof video.metadata === 'object') return video.metadata;
  try {
    return JSON.parse(video?.metadata || '{}');
  } catch {
    return {};
  }
}

async function updatePost(meta, patch = {}) {
  const postId = Number(meta?.biblioteca_post_id || 0);
  if (!postId) return;
  await BibliotecaPosts.update(postId, patch);
}

/** Persiste a autorização do piloto antes de o pós-processamento terminar. */
async function habilitarPublicacaoAutomatica({
  videoId,
  matterId,
  bibliotecaPostId,
  facebookPageId,
}) {
  const video = await Videos.findById(videoId);
  if (!video) throw new Error('Vídeo do Reel não encontrado');

  const metadata = {
    ...metadataOf(video),
    pipeline: 'conteudo_reel',
    matter_id: Number(matterId) || null,
    biblioteca_post_id: Number(bibliotecaPostId) || null,
    facebook_page_id: Number(facebookPageId) || null,
    autopilot_publish: true,
    autopilot_requested_at: new Date().toISOString(),
    autopilot_last_error: null,
  };

  await Videos.update(video.id, { metadata });
  if (metadata.biblioteca_post_id) {
    await BibliotecaPosts.update(metadata.biblioteca_post_id, {
      status: 'gerado_video',
      matter_id: metadata.matter_id,
      video_id: video.id,
    });
  }
  return Videos.findById(video.id);
}

/** Publica somente quando vídeo, transcrição/matéria e capa estão prontos. */
async function publicarSePronto({ videoId, clipId = null, matterId = null }) {
  const video = await Videos.findById(videoId);
  if (!video) return { published: false, reason: 'video_not_found' };

  const meta = metadataOf(video);
  if (!meta.autopilot_publish) return { published: false, reason: 'not_authorized' };

  const finalMatterId = Number(matterId || meta.matter_id || 0);
  if (!finalMatterId) return { published: false, reason: 'matter_not_linked' };

  let matter = await AiMatters.findById(finalMatterId);
  if (!matter) return { published: false, reason: 'matter_not_found' };

  if (matter.status === 'publicado') {
    await updatePost(meta, {
      status: 'gerado_video',
      matter_id: matter.id,
      video_id: video.id,
    });
    await Videos.update(video.id, {
      metadata: {
        ...meta,
        autopilot_publish: false,
        autopilot_published_at: meta.autopilot_published_at || new Date().toISOString(),
        autopilot_last_error: null,
      },
    });
    return { published: true, alreadyPublished: true, matter };
  }

  if (matter.publication_id) {
    const publication = await Publications.findById(matter.publication_id);
    if (publication) {
      if (publication.status === 'publicado') {
        await updatePost(meta, {
          status: 'gerado_video',
          matter_id: matter.id,
          video_id: video.id,
        });
        await Videos.update(video.id, {
          metadata: {
            ...meta,
            autopilot_publish: false,
            autopilot_published_at: meta.autopilot_published_at || new Date().toISOString(),
            autopilot_last_error: null,
          },
        });
      }
      return {
        published: publication.status === 'publicado',
        alreadyPublished: publication.status === 'publicado',
        reason: `publication_${publication.status}`,
        matter,
        publication,
      };
    }
  }

  let clip = clipId ? await VideoClips.findById(clipId) : null;
  if (!clip && matter.video_clip_id) clip = await VideoClips.findById(matter.video_clip_id);
  if (!clip) {
    const clips = await VideoClips.findByVideo(video.id);
    clip = clips.find((item) => item.status === 'pronto' && item.caminho_arquivo) || null;
  }

  const ready =
    clip?.status === 'pronto' &&
    clip?.materia_status === 'pronta' &&
    clip?.capa_status === 'pronta' &&
    Boolean(clip?.caminho_arquivo);
  if (!ready) return { published: false, reason: 'pipeline_pending' };

  const key = String(matter.id);
  if (publishingMatters.has(key)) return { published: false, reason: 'publish_in_progress' };
  publishingMatters.add(key);

  try {
    const materiaIaService = require('./materiaIaService');
    await materiaIaService.syncConteudoReelMatter({
      matterId: matter.id,
      clip,
      video,
      gerado: clip.legenda_sugerida
        ? { titulo: clip.capa_titulo, materia: clip.legenda_sugerida }
        : null,
    });
    matter = await AiMatters.findById(matter.id);

    if (!matter?.video_path || String(matter.materia || '').startsWith('⏳')) {
      return { published: false, reason: 'matter_pending' };
    }

    const publication = await materiaIaService.publicarMateria(matter.user_id, matter.id, {
      facebook_page_id: Number(meta.facebook_page_id),
      tipo_publicacao: 'reel',
      sync: true,
    });

    await updatePost(meta, {
      status: 'gerado_video',
      matter_id: matter.id,
      video_id: video.id,
    });
    await BibliotecaAutopilot.incrementPublishedByUser(matter.user_id);
    await Videos.update(video.id, {
      metadata: {
        ...meta,
        autopilot_publish: false,
        autopilot_published_at: new Date().toISOString(),
        autopilot_last_error: null,
      },
    });

    console.log(
      `[biblioteca-autopilot] Reel matter #${matter.id} publicado (${publication.fbPostUrl || 'sem URL'})`
    );
    return { published: true, matter, publication };
  } catch (err) {
    await Videos.update(video.id, {
      metadata: {
        ...meta,
        autopilot_last_error: String(err.message || err).slice(0, 500),
      },
    });
    throw err;
  } finally {
    publishingMatters.delete(key);
  }
}

/** Retoma publicações prontas que ficaram pendentes após reinício do processo. */
async function publicarPendentesDoUsuario(userId, limit = 1) {
  const budget = Math.min(5, Math.max(1, Number(limit) || 1));
  const posts = await BibliotecaPosts.findByUser(userId, {
    status: 'gerado_video',
    limit: 50,
  });
  let published = 0;
  for (const post of posts) {
    if (published >= budget) break;
    if (!post.video_id || !post.matter_id) continue;
    try {
      const result = await publicarSePronto({
        videoId: post.video_id,
        matterId: post.matter_id,
      });
      if (result.published && !result.alreadyPublished) published += 1;
    } catch (err) {
      console.warn(`[biblioteca-autopilot] retomada post #${post.id}:`, err.message);
    }
  }
  return published;
}

module.exports = {
  habilitarPublicacaoAutomatica,
  publicarSePronto,
  publicarPendentesDoUsuario,
};
