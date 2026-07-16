const VideoClips = require('../models/VideoClips');
const Videos = require('../models/Videos');
const Users = require('../models/Users');
const clipCoverService = require('./clipCoverService');
const deepseekService = require('./deepseekService');
const transcriptionService = require('./transcriptionService');
const { enqueue } = require('../workers/queue');
const { storageAbsolutePath } = require('./downloadService');
const fs = require('fs');

function safeUnlink(relativePath) {
  if (!relativePath) return;
  try {
    const abs = storageAbsolutePath(relativePath);
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
  } catch {
    // ignore
  }
}

/** Título curto/chamativo a partir da matéria, do título da IA ou do vídeo. */
function resolveCapaTitulo({ titulo, iaTitulo, materia, videoTitulo }) {
  const candidates = [
    String(titulo || '').trim(),
    String(iaTitulo || '').trim(),
    String(materia || '')
      .replace(/#\w+/g, ' ')
      .split(/[.!?\n]/)
      .map((s) => s.trim())
      .find((s) => s.length >= 12),
    String(videoTitulo || '').trim(),
    'Assista até o final',
  ];
  const picked = candidates.find(Boolean) || 'Assista até o final';
  return picked.replace(/\s+/g, ' ').slice(0, 90);
}

/**
 * Enfileira geração da capa (frame + título Minha marca no início do corte).
 */
async function queueClipCover({ clipId, userId, titulo }) {
  const clip = await VideoClips.findById(clipId);
  if (!clip) throw Object.assign(new Error('Clipe não encontrado'), { status: 404 });
  if (!clip.caminho_arquivo) {
    throw Object.assign(new Error('Clipe sem arquivo — gere o corte novamente'), { status: 422 });
  }

  const video = await Videos.findById(clip.video_id);
  const user = await Users.findById(userId);
  if (!user) throw Object.assign(new Error('Usuário não encontrado'), { status: 404 });

  const finalTitulo = resolveCapaTitulo({
    titulo,
    materia: clip.legenda_sugerida,
    videoTitulo: video?.titulo || video?.termo_busca,
  });

  await VideoClips.update(clipId, {
    capa_status: 'gerando',
    capa_titulo: finalTitulo,
    erro_mensagem: null,
  });

  enqueue(`capa clip ${clipId}`, async () => {
    const fresh = await VideoClips.findById(clipId);
    if (!fresh) return;
    try {
      const { relativePath } = await clipCoverService.addCoverToClip({
        clip: fresh,
        user,
        titulo: finalTitulo,
      });

      const semCapa = fresh.arquivo_sem_capa || fresh.caminho_arquivo;
      if (fresh.arquivo_sem_capa && fresh.caminho_arquivo !== fresh.arquivo_sem_capa) {
        safeUnlink(fresh.caminho_arquivo);
      }

      await VideoClips.update(clipId, {
        caminho_arquivo: relativePath,
        arquivo_sem_capa: semCapa,
        capa_titulo: finalTitulo,
        capa_status: 'pronta',
        erro_mensagem: null,
      });
    } catch (err) {
      console.error(`[capa] clip ${clipId}:`, err.message || err);
      await VideoClips.update(clipId, {
        capa_status: 'erro',
        erro_mensagem: `Capa falhou: ${String(err.message || err).slice(0, 400)}`,
      });
      throw err;
    }
  });

  return { queued: true, titulo: finalTitulo };
}

/**
 * Pipeline automático após o corte: fala → matéria → capa.
 * Usado ao finalizar o ffmpeg e também pelo botão "Gerar matéria".
 */
function queueClipMateriaAndCover(clip, video, { tema = null, userId = null, force = false } = {}) {
  const uid = userId || video?.user_id;
  if (!clip?.id || !uid) return false;

  enqueue(`materia clip ${clip.id}`, async () => {
    try {
      const current = await VideoClips.findById(clip.id);
      if (!current || !current.caminho_arquivo) return;
      if (!force && current.materia_status === 'pronta' && current.legenda_sugerida) {
        // Já tem matéria — só garante a capa se ainda não tiver
        if (current.capa_status !== 'pronta' && current.capa_status !== 'gerando') {
          await queueClipCover({
            clipId: current.id,
            userId: uid,
            titulo: current.capa_titulo || null,
          });
        }
        return;
      }

      await VideoClips.update(clip.id, {
        materia_status: 'gerando',
        erro_mensagem: null,
      });

      let transcricao = current.transcricao;
      let idioma = null;

      if (!transcricao || /^\[(sem fala|falha)/i.test(String(transcricao))) {
        const result = await transcriptionService.transcribeClip({
          clipPath: current.caminho_arquivo,
          sourceUrl: video.url_original,
        });
        transcricao = result.empty ? '[sem fala detectada]' : result.text;
        idioma = result.language;
        await VideoClips.update(clip.id, { transcricao });
      }

      let gerado;
      try {
        deepseekService.assertDeepseek();
        gerado = await deepseekService.gerarMateriaVideo({
          transcricao,
          titulo: video.titulo || video.termo_busca,
          tema,
          idioma,
        });
      } catch (aiErr) {
        // Sem DeepSeek ou falha: ainda gera capa com título do vídeo
        console.warn(`[materia] clip ${clip.id}:`, aiErr.message || aiErr);
        const tituloCapa = resolveCapaTitulo({
          videoTitulo: video.titulo || video.termo_busca,
        });
        await VideoClips.update(clip.id, {
          materia_status: 'erro',
          capa_titulo: tituloCapa,
          erro_mensagem: `Matéria falhou: ${String(aiErr.message || aiErr).slice(0, 400)}`,
        });
        try {
          await queueClipCover({ clipId: clip.id, userId: uid, titulo: tituloCapa });
        } catch (capaErr) {
          console.error(`[capa] auto clip ${clip.id}:`, capaErr.message || capaErr);
        }
        try {
          const freshClip = await VideoClips.findById(clip.id);
          const meta =
            video?.metadata && typeof video.metadata === 'object'
              ? video.metadata
              : {};
          if (meta.pipeline === 'conteudo_reel' && meta.matter_id) {
            const { syncConteudoReelMatter } = require('./materiaIaService');
            await syncConteudoReelMatter({
              matterId: meta.matter_id,
              clip: freshClip,
              video,
              gerado: null,
            });
          }
        } catch (syncErr) {
          console.warn(`[conteudo-reel] sync after materia erro:`, syncErr.message);
        }
        return;
      }

      const tituloCapa = resolveCapaTitulo({
        iaTitulo: gerado.titulo,
        materia: gerado.materia,
        videoTitulo: video.titulo || video.termo_busca,
      });

      await VideoClips.update(clip.id, {
        legenda_sugerida: gerado.materia,
        materia_status: 'pronta',
        capa_titulo: tituloCapa,
        erro_mensagem: null,
      });

      try {
        await queueClipCover({
          clipId: clip.id,
          userId: uid,
          titulo: tituloCapa,
        });
      } catch (capaErr) {
        console.error(`[capa] auto clip ${clip.id}:`, capaErr.message || capaErr);
        await VideoClips.update(clip.id, {
          capa_status: 'erro',
          erro_mensagem: `Capa falhou: ${String(capaErr.message || capaErr).slice(0, 400)}`,
        });
      }

      // Reel via /conteudo → atualiza a matéria em /materias-ia
      try {
        const freshClip = await VideoClips.findById(clip.id);
        const meta =
          video?.metadata && typeof video.metadata === 'object'
            ? video.metadata
            : (() => {
                try {
                  return JSON.parse(video?.metadata || '{}');
                } catch {
                  return {};
                }
              })();
        if (meta.pipeline === 'conteudo_reel' && meta.matter_id) {
          const { syncConteudoReelMatter } = require('./materiaIaService');
          await syncConteudoReelMatter({
            matterId: meta.matter_id,
            clip: freshClip,
            video,
            gerado,
          });
        }
      } catch (syncErr) {
        console.warn(`[conteudo-reel] sync matter clip ${clip.id}:`, syncErr.message);
      }
    } catch (err) {
      await VideoClips.update(clip.id, {
        materia_status: 'erro',
        erro_mensagem: `Matéria falhou: ${String(err.message || err).slice(0, 400)}`,
      });
      throw err;
    }
  });

  return true;
}

module.exports = {
  resolveCapaTitulo,
  queueClipCover,
  queueClipMateriaAndCover,
  safeUnlink,
};
