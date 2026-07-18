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

function sameCapaTitulo(a, b) {
  return (
    String(a || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase() ===
    String(b || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
  );
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
    await applyCoverToClipNow({ clipId, userId, titulo: finalTitulo });
  });

  return { queued: true, titulo: finalTitulo };
}

/**
 * Aplica a capa Minha marca e atualiza a matéria do Reel (video_path).
 * Por padrão reutiliza capa já pronta (evita travar a publicação por minutos no ffmpeg).
 * Passe force: true ao mudar o título.
 */
async function applyCoverToClipNow({ clipId, userId, titulo = null, force = false }) {
  const clip = await VideoClips.findById(clipId);
  if (!clip) throw Object.assign(new Error('Clipe não encontrado'), { status: 404 });
  if (!clip.caminho_arquivo && !clip.arquivo_sem_capa) {
    throw Object.assign(new Error('Clipe sem arquivo'), { status: 422 });
  }

  const video = await Videos.findById(clip.video_id);
  const user = await Users.findById(userId);
  if (!user) throw Object.assign(new Error('Usuário não encontrado'), { status: 404 });

  const finalTitulo = resolveCapaTitulo({
    titulo,
    materia: clip.legenda_sugerida,
    videoTitulo: video?.titulo || video?.termo_busca,
  });

  // Reutiliza capa pronta (ou arquivo _capa_ se o status ficou preso em "gerando")
  const looksLikeCover =
    Boolean(clip.caminho_arquivo) && /_capa_/i.test(String(clip.caminho_arquivo));
  if (
    !force &&
    clip.caminho_arquivo &&
    (clip.capa_status === 'pronta' || looksLikeCover)
  ) {
    const abs = storageAbsolutePath(clip.caminho_arquivo);
    const titleOk = !titulo || sameCapaTitulo(clip.capa_titulo, finalTitulo);
    if (titleOk && fs.existsSync(abs)) {
      if (clip.capa_status !== 'pronta') {
        await VideoClips.update(clipId, {
          capa_status: 'pronta',
          capa_titulo: clip.capa_titulo || finalTitulo,
          erro_mensagem: null,
        });
      }
      console.log(`[capa] clip ${clipId}: reutilizando capa pronta (${clip.caminho_arquivo})`);
      try {
        const meta =
          video?.metadata && typeof video.metadata === 'object'
            ? video.metadata
            : {};
        if (meta.pipeline === 'conteudo_reel' && meta.matter_id) {
          const { syncConteudoReelMatter } = require('./materiaIaService');
          await syncConteudoReelMatter({
            matterId: meta.matter_id,
            clip,
            video,
            gerado: clip.legenda_sugerida
              ? { titulo: clip.capa_titulo || finalTitulo, materia: clip.legenda_sugerida }
              : null,
          });
        } else {
          const db = require('../config/db');
          const AiMatters = require('../models/AiMatters');
          const matter = await db('ai_matters')
            .where({ video_clip_id: clipId, tipo_publicacao: 'reel' })
            .orderBy('id', 'desc')
            .first();
          if (matter) {
            await AiMatters.update(matter.id, { video_path: clip.caminho_arquivo });
          }
        }
      } catch (syncErr) {
        console.warn(`[capa] sync reuse clip ${clipId}:`, syncErr.message);
      }
      return {
        relativePath: clip.caminho_arquivo,
        titulo: clip.capa_titulo || finalTitulo,
        clip,
        reused: true,
      };
    }
  }

  await VideoClips.update(clipId, {
    capa_status: 'gerando',
    capa_titulo: finalTitulo,
    erro_mensagem: null,
  });

  const fresh = await VideoClips.findById(clipId);
  try {
    console.log(`[capa] clip ${clipId}: gerando capa (“${finalTitulo.slice(0, 60)}”)…`);
    const started = Date.now();
    const { relativePath } = await clipCoverService.addCoverToClip({
      clip: fresh,
      user,
      titulo: finalTitulo,
    });
    console.log(`[capa] clip ${clipId}: pronta em ${Math.round((Date.now() - started) / 1000)}s`);

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

    const updatedClip = await VideoClips.findById(clipId);
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
      try {
        const { syncConteudoReelMatter } = require('./materiaIaService');
        await syncConteudoReelMatter({
          matterId: meta.matter_id,
          clip: updatedClip,
          video,
          gerado: updatedClip.legenda_sugerida
            ? { titulo: finalTitulo, materia: updatedClip.legenda_sugerida }
            : null,
        });
      } catch (syncErr) {
        console.warn(`[conteudo-reel] sync after capa:`, syncErr.message);
      }
    } else {
      try {
        const AiMatters = require('../models/AiMatters');
        const db = require('../config/db');
        const matter = await db('ai_matters')
          .where({ video_clip_id: clipId, tipo_publicacao: 'reel' })
          .orderBy('id', 'desc')
          .first();
        if (matter) {
          await AiMatters.update(matter.id, {
            video_path: relativePath,
            titulo: finalTitulo.slice(0, 300),
            error_message: null,
          });
        }
      } catch (linkErr) {
        console.warn(`[capa] link matter clip ${clipId}:`, linkErr.message);
      }
    }

    return { relativePath, titulo: finalTitulo, clip: updatedClip, reused: false };
  } catch (err) {
    console.error(`[capa] clip ${clipId}:`, err.message || err);
    await VideoClips.update(clipId, {
      capa_status: 'erro',
      erro_mensagem: `Capa falhou: ${String(err.message || err).slice(0, 400)}`,
    });
    throw err;
  }
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
        // Já tem matéria — garante a capa (refaz se ficou presa em gerando/erro)
        const capaOk =
          current.capa_status === 'pronta' &&
          current.caminho_arquivo &&
          /_capa_/i.test(String(current.caminho_arquivo));
        if (!capaOk) {
          try {
            await applyCoverToClipNow({
              clipId: current.id,
              userId: uid,
              titulo: current.capa_titulo || null,
              force: current.capa_status === 'gerando' || current.capa_status === 'erro',
            });
          } catch (capaErr) {
            console.error(`[capa] auto clip ${current.id}:`, capaErr.message || capaErr);
          }
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
        const { limparTextoReelSocial } = require('./materiaIaService');

        const candidatos = [
          meta.titulo_completo,
          meta.description,
          video?.titulo,
        ];
        // Matéria do Reel pode ter a legenda limpa em fonte_resumo
        if (meta.matter_id) {
          try {
            const AiMatters = require('../models/AiMatters');
            const matterRow = await AiMatters.findById(meta.matter_id);
            if (matterRow) {
              candidatos.push(
                matterRow.fonte_resumo,
                matterRow.fonte_titulo,
                String(matterRow.materia || '').startsWith('⏳') ? null : matterRow.materia,
                matterRow.titulo
              );
            }
          } catch {
            /* ignore */
          }
        }

        let caption = '';
        for (const raw of candidatos) {
          const limpo = limparTextoReelSocial(raw);
          if (limpo && limpo.length > caption.length && !limpo.startsWith('⏳')) {
            caption = limpo;
          }
        }

        try {
          // Áudio SEM capa (evita transcrever o silêncio da intro)
          const clipPath = current.arquivo_sem_capa || current.caminho_arquivo;
          const result = await transcriptionService.transcribeClip({
            clipPath,
            sourceUrl: video.url_original,
          });
          if (result.empty || !String(result.text || '').trim()) {
            throw new Error('sem fala detectada');
          }
          transcricao = result.text;
          idioma = result.language;
          console.log(
            `[materia] clip ${clip.id}: fala via ${result.source || 'transcrição'} (${String(transcricao).length} chars)`
          );
        } catch (txErr) {
          // Sem Whisper/legendas: usa legenda/título do post FB/IG (mesmo se curto)
          if (caption && caption.length >= 12) {
            console.warn(
              `[materia] clip ${clip.id}: sem fala (${txErr.message}). Usando legenda/título do post (${caption.length} chars).`
            );
            transcricao = caption;
            idioma = 'pt';
          } else {
            console.warn(
              `[materia] clip ${clip.id}: sem fala e sem legenda útil (${txErr.message}). Seguindo só com título.`
            );
            transcricao =
              limparTextoReelSocial(video?.titulo || video?.termo_busca || '') ||
              'Reel sem legenda disponível — gere a matéria com base no título.';
            idioma = 'pt';
          }
        }
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
          await applyCoverToClipNow({
            clipId: clip.id,
            userId: uid,
            titulo: tituloCapa,
            force: true,
          });
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

      // Aplica a capa no mesmo job (evita fila aninhada e status "gerando" preso)
      try {
        await applyCoverToClipNow({
          clipId: clip.id,
          userId: uid,
          titulo: tituloCapa,
          force: true,
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

      // Se o Reel veio do piloto da Biblioteca, publica somente após matéria e capa prontas.
      try {
        const reelAutopilot = require('./bibliotecaReelAutopilotService');
        await reelAutopilot.publicarSePronto({
          videoId: video.id,
          clipId: clip.id,
        });
      } catch (publishErr) {
        console.warn(`[biblioteca-autopilot] publicação Reel clip #${clip.id}:`, publishErr.message);
      }
    } catch (err) {
      console.error(`[materia] clip ${clip.id} falhou:`, err.message || err);
      await VideoClips.update(clip.id, {
        materia_status: 'erro',
        erro_mensagem: `Matéria falhou: ${String(err.message || err).slice(0, 400)}`,
      });
      // Não relança: a fila não precisa “falhar” — capa ainda pode ser tentada
      try {
        const tituloCapa = resolveCapaTitulo({
          videoTitulo: video?.titulo || video?.termo_busca,
        });
        await applyCoverToClipNow({
          clipId: clip.id,
          userId: uid,
          titulo: tituloCapa,
          force: true,
        });
      } catch (capaErr) {
        console.warn(`[capa] após erro matéria clip ${clip.id}:`, capaErr.message);
      }
      try {
        const meta =
          video?.metadata && typeof video.metadata === 'object' ? video.metadata : {};
        if (meta.pipeline === 'conteudo_reel' && meta.matter_id) {
          const freshClip = await VideoClips.findById(clip.id);
          const { syncConteudoReelMatter } = require('./materiaIaService');
          await syncConteudoReelMatter({
            matterId: meta.matter_id,
            clip: freshClip,
            video,
            gerado: null,
          });
        }
      } catch {
        /* ignore */
      }
    }
  });

  return true;
}

module.exports = {
  resolveCapaTitulo,
  queueClipCover,
  applyCoverToClipNow,
  queueClipMateriaAndCover,
  safeUnlink,
};
