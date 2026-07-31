const fs = require('fs');
const crypto = require('crypto');
const VideoClips = require('../models/VideoClips');
const { storageAbsolutePath } = require('./downloadService');
const { changePlaybackSpeed, probe } = require('./ffmpegService');

const SPEED_OPTIONS = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];

function httpError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function storageAbs(relative) {
  return storageAbsolutePath(relative);
}

function safeUnlink(relative) {
  if (!relative) return;
  try {
    const abs = storageAbs(relative);
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
  } catch {
    /* ignore */
  }
}

function normalizePlaybackSpeed(value, fallback = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const clamped = Math.min(3, Math.max(0.5, Math.round(n * 100) / 100));
  // Encaixa no preset mais próximo (evita 1.37 etc.)
  let best = SPEED_OPTIONS[0];
  let bestDiff = Math.abs(clamped - best);
  for (const opt of SPEED_OPTIONS) {
    const d = Math.abs(clamped - opt);
    if (d < bestDiff) {
      best = opt;
      bestDiff = d;
    }
  }
  return best;
}

function formatSpeedLabel(speed) {
  const s = normalizePlaybackSpeed(speed);
  if (Number.isInteger(s)) return `${s}x`;
  return `${String(s).replace(/\.?0+$/, '')}x`;
}

/**
 * Aplica velocidade ao arquivo do corte (ou volta a 1x).
 * Sempre parte do arquivo sem velocidade (arquivo_sem_speed) para não acumular.
 */
async function aplicarVelocidadeNoClip({ clipId, speed }) {
  const clip = await VideoClips.findById(clipId);
  if (!clip) throw httpError('Corte não encontrado', 404);
  if (!['pronto', 'publicado'].includes(String(clip.status))) {
    throw httpError('Espere o corte ficar pronto antes de alterar a velocidade.', 422);
  }
  if (!clip.caminho_arquivo && !clip.arquivo_sem_speed) {
    throw httpError('Clipe sem arquivo de vídeo.', 422);
  }

  const speedFinal = normalizePlaybackSpeed(speed, 1);
  const uid = crypto.randomBytes(3).toString('hex');

  // Base sem velocidade anterior
  let fonteRel =
    clip.arquivo_sem_speed && fs.existsSync(storageAbs(clip.arquivo_sem_speed))
      ? clip.arquivo_sem_speed
      : clip.caminho_arquivo;

  if (!fonteRel || !fs.existsSync(storageAbs(fonteRel))) {
    throw httpError('Arquivo do corte não encontrado no disco.', 404);
  }

  // Voltar a 1x = restaurar backup
  if (speedFinal === 1) {
    const backup = clip.arquivo_sem_speed;
    if (backup && fs.existsSync(storageAbs(backup))) {
      const atual = clip.caminho_arquivo;
      await VideoClips.update(clip.id, {
        caminho_arquivo: backup,
        arquivo_sem_speed: null,
        playback_speed: 1,
      });
      if (atual && atual !== backup && /_speed_/i.test(String(atual))) {
        safeUnlink(atual);
      }

      // Reaplica BGM sobre o arquivo restaurado, se houver
      try {
        const fresh = await VideoClips.findById(clip.id);
        if (fresh?.bgm_preset && fresh.bgm_preset !== 'nenhuma') {
          const clipBgmService = require('./clipBgmService');
          await VideoClips.update(clip.id, { arquivo_sem_bgm: backup });
          await clipBgmService.aplicarBgmNoClip({
            clipId: clip.id,
            preset: fresh.bgm_preset,
            volume: fresh.bgm_volume,
          });
        }
      } catch (bgmErr) {
        console.warn(`[speed] BGM após 1x #${clip.id}:`, bgmErr.message || bgmErr);
      }

      const after = await VideoClips.findById(clip.id);
      let duracao = null;
      try {
        const meta = await probe(storageAbs(after.caminho_arquivo));
        duracao = Math.round(Number(meta.format?.duration) || 0) || null;
      } catch {
        /* ignore */
      }

      return {
        ok: true,
        speed: 1,
        speed_label: '1x',
        video_url: after.caminho_arquivo ? `/media/${after.caminho_arquivo}` : null,
        duracao,
        message: 'Velocidade normal (1x) restaurada.',
      };
    }

    await VideoClips.update(clip.id, { playback_speed: 1, arquivo_sem_speed: null });
    return {
      ok: true,
      speed: 1,
      speed_label: '1x',
      video_url: clip.caminho_arquivo ? `/media/${clip.caminho_arquivo}` : null,
      message: 'Velocidade já está em 1x.',
    };
  }

  const outRel = `clips/clip_${clip.id}_speed_${String(speedFinal).replace('.', '_')}_${Date.now()}_${uid}.mp4`;
  const outAbs = storageAbs(outRel);
  const started = Date.now();

  const result = await changePlaybackSpeed({
    videoPath: storageAbs(fonteRel),
    outputPath: outAbs,
    speed: speedFinal,
  });

  console.log(
    `[speed] clip #${clip.id} ${speedFinal}x em ${Math.round((Date.now() - started) / 1000)}s → ${Math.round(result.duracao || 0)}s`
  );

  const anterior = clip.caminho_arquivo;
  await VideoClips.update(clip.id, {
    caminho_arquivo: outRel,
    arquivo_sem_speed: fonteRel,
    playback_speed: speedFinal,
  });

  if (
    anterior &&
    anterior !== outRel &&
    anterior !== fonteRel &&
    /_speed_/i.test(String(anterior))
  ) {
    safeUnlink(anterior);
  }

  // Se tinha BGM, remixa sobre o arquivo já acelerado
  try {
    const fresh = await VideoClips.findById(clip.id);
    if (fresh?.bgm_preset && fresh.bgm_preset !== 'nenhuma') {
      const clipBgmService = require('./clipBgmService');
      await VideoClips.update(clip.id, { arquivo_sem_bgm: outRel });
      await clipBgmService.aplicarBgmNoClip({
        clipId: clip.id,
        preset: fresh.bgm_preset,
        volume: fresh.bgm_volume,
      });
    }
  } catch (bgmErr) {
    console.warn(`[speed] BGM após ${speedFinal}x #${clip.id}:`, bgmErr.message || bgmErr);
  }

  const after = await VideoClips.findById(clip.id);
  let duracao = Math.round(result.duracao || 0) || null;
  try {
    if (after.caminho_arquivo) {
      const meta = await probe(storageAbs(after.caminho_arquivo));
      duracao = Math.round(Number(meta.format?.duration) || duracao || 0) || duracao;
    }
  } catch {
    /* ignore */
  }

  return {
    ok: true,
    speed: speedFinal,
    speed_label: formatSpeedLabel(speedFinal),
    video_url: after.caminho_arquivo ? `/media/${after.caminho_arquivo}` : `/media/${outRel}`,
    duracao,
    message: `Velocidade ${formatSpeedLabel(speedFinal)} aplicada${
      duracao ? ` (~${duracao}s)` : ''
    }.`,
  };
}

module.exports = {
  SPEED_OPTIONS,
  normalizePlaybackSpeed,
  formatSpeedLabel,
  aplicarVelocidadeNoClip,
};
