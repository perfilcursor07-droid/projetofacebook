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

function fileExists(relative) {
  return Boolean(relative) && fs.existsSync(storageAbs(relative));
}

function isCapaPath(relative) {
  return /_capa_/i.test(String(relative || ''));
}

function normalizePlaybackSpeed(value, fallback = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const clamped = Math.min(3, Math.max(0.5, Math.round(n * 100) / 100));
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

function capaEstaAtiva(clip) {
  return String(clip.capa_status || '') === 'pronta';
}

/**
 * Corpo do vídeo para acelerar — sem intro de capa.
 * Se a capa estiver desmarcada, nunca usa arquivo `_capa_`.
 */
function resolveSpeedFonte(clip) {
  const capaOn = capaEstaAtiva(clip);
  const ranked = [];

  // 1) Backup sem velocidade, sem capa
  if (fileExists(clip.arquivo_sem_speed) && !isCapaPath(clip.arquivo_sem_speed)) {
    ranked.push(clip.arquivo_sem_speed);
  }
  // 2) Corpo sem capa (quando a capa ainda está “em cima”)
  if (fileExists(clip.arquivo_sem_capa)) {
    ranked.push(clip.arquivo_sem_capa);
  }
  // 3) Arquivo atual, se não for capa
  if (fileExists(clip.caminho_arquivo) && !isCapaPath(clip.caminho_arquivo)) {
    ranked.push(clip.caminho_arquivo);
  }

  if (!capaOn) {
    const semCapa = ranked.find((p) => !isCapaPath(p));
    if (semCapa) return semCapa;
  }

  // Capa ativa: ainda preferimos o corpo sem capa para não acelerar a intro “queimada”
  if (capaOn && fileExists(clip.arquivo_sem_capa)) {
    return clip.arquivo_sem_capa;
  }

  if (ranked.length) return ranked[0];

  // Último recurso
  if (fileExists(clip.arquivo_sem_speed)) return clip.arquivo_sem_speed;
  if (fileExists(clip.caminho_arquivo)) return clip.caminho_arquivo;
  return null;
}

async function reaplicarBgmSeHouver(clipId, baseRel) {
  try {
    const fresh = await VideoClips.findById(clipId);
    if (fresh?.bgm_preset && fresh.bgm_preset !== 'nenhuma') {
      const clipBgmService = require('./clipBgmService');
      await VideoClips.update(clipId, { arquivo_sem_bgm: baseRel });
      await clipBgmService.aplicarBgmNoClip({
        clipId,
        preset: fresh.bgm_preset,
        volume: fresh.bgm_volume,
      });
    }
  } catch (bgmErr) {
    console.warn(`[speed] BGM clip #${clipId}:`, bgmErr.message || bgmErr);
  }
}

async function regenerarCapaSeAtiva(clipId, userId, titulo) {
  try {
    const fresh = await VideoClips.findById(clipId);
    if (!fresh || String(fresh.capa_status) !== 'pronta') return;
    const { applyCoverToClipNow } = require('./clipPostProcessService');
    await applyCoverToClipNow({
      clipId,
      userId,
      titulo: titulo || fresh.capa_titulo,
      force: true,
    });
  } catch (err) {
    console.warn(`[speed] refazer capa #${clipId}:`, err.message || err);
  }
}

/**
 * Aplica velocidade ao arquivo do corte (ou volta a 1x).
 * Sempre parte do corpo SEM capa; se a capa estiver marcada, refaz a capa depois.
 */
async function aplicarVelocidadeNoClip({ clipId, userId = null, speed }) {
  const clip = await VideoClips.findById(clipId);
  if (!clip) throw httpError('Corte não encontrado', 404);
  if (!['pronto', 'publicado'].includes(String(clip.status))) {
    throw httpError('Espere o corte ficar pronto antes de alterar a velocidade.', 422);
  }
  if (!clip.caminho_arquivo && !clip.arquivo_sem_speed && !clip.arquivo_sem_capa) {
    throw httpError('Clipe sem arquivo de vídeo.', 422);
  }

  const speedFinal = normalizePlaybackSpeed(speed, 1);
  const uid = crypto.randomBytes(3).toString('hex');
  const capaOn = capaEstaAtiva(clip);
  const fonteRel = resolveSpeedFonte(clip);

  if (!fonteRel || !fileExists(fonteRel)) {
    throw httpError('Arquivo do corte não encontrado no disco.', 404);
  }

  // Voltar a 1x = restaurar corpo sem velocidade (sem capa)
  if (speedFinal === 1) {
    let backup = resolveSpeedFonte({
      ...clip,
      // Força preferência pelo backup 1x sem capa
      caminho_arquivo: clip.arquivo_sem_speed || clip.caminho_arquivo,
    });
    if (fileExists(clip.arquivo_sem_speed) && !isCapaPath(clip.arquivo_sem_speed)) {
      backup = clip.arquivo_sem_speed;
    } else if (fileExists(clip.arquivo_sem_capa) && !isCapaPath(clip.arquivo_sem_capa)) {
      backup = clip.arquivo_sem_capa;
    } else if (fileExists(clip.caminho_arquivo) && !isCapaPath(clip.caminho_arquivo)) {
      backup = clip.caminho_arquivo;
    }

    if (backup && fileExists(backup)) {
      const atual = clip.caminho_arquivo;
      const patch = {
        caminho_arquivo: backup,
        arquivo_sem_speed: null,
        playback_speed: 1,
      };
      // Mantém referência do corpo sem capa
      if (!capaOn) {
        patch.arquivo_sem_capa = null;
        patch.capa_status = String(clip.capa_status) === 'pronta' ? 'pendente' : clip.capa_status;
      } else {
        patch.arquivo_sem_capa = backup;
      }

      await VideoClips.update(clip.id, patch);
      if (atual && atual !== backup && (/_speed_/i.test(String(atual)) || isCapaPath(atual))) {
        safeUnlink(atual);
      }

      await reaplicarBgmSeHouver(clip.id, backup);
      if (capaOn && userId) {
        await regenerarCapaSeAtiva(clip.id, userId, clip.capa_titulo);
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
        capa_status: after.capa_status || 'pendente',
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
      capa_status: clip.capa_status || 'pendente',
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
    `[speed] clip #${clip.id} ${speedFinal}x (fonte=${isCapaPath(fonteRel) ? 'capa!' : 'corpo'}) em ${Math.round((Date.now() - started) / 1000)}s → ${Math.round(result.duracao || 0)}s`
  );

  const anterior = clip.caminho_arquivo;
  const patch = {
    caminho_arquivo: outRel,
    arquivo_sem_speed: fonteRel,
    playback_speed: speedFinal,
  };

  if (capaOn) {
    // Corpo acelerado vira base; a capa será refeita em cima
    patch.arquivo_sem_capa = outRel;
  } else {
    // Capa desmarcada: preview/publicação sem intro
    patch.arquivo_sem_capa = null;
    if (String(clip.capa_status) === 'pronta') patch.capa_status = 'pendente';
  }

  await VideoClips.update(clip.id, patch);

  if (
    anterior &&
    anterior !== outRel &&
    anterior !== fonteRel &&
    (/_speed_/i.test(String(anterior)) || isCapaPath(anterior))
  ) {
    safeUnlink(anterior);
  }

  await reaplicarBgmSeHouver(clip.id, outRel);

  if (capaOn && userId) {
    await regenerarCapaSeAtiva(clip.id, userId, clip.capa_titulo);
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
    capa_status: after.capa_status || (capaOn ? 'pronta' : 'pendente'),
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
  resolveSpeedFonte,
  isCapaPath,
};
