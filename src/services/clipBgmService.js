const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const VideoClips = require('../models/VideoClips');
const { storageAbsolutePath } = require('./downloadService');
const { mixBackgroundMusic, probe } = require('./ffmpegService');
const {
  DEFAULT_BGM_PRESET,
  DEFAULT_BGM_VOLUME,
  normalizeBgmPreset,
  normalizeBgmVolume,
  writeBgmWav,
} = require('./clipBgmPresets');

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

/**
 * Aplica (ou remove) música de fundo no arquivo atual do corte.
 * Mantém `arquivo_sem_bgm` para trocar/remover sem remixar a partir do vídeo já misturado.
 */
async function aplicarBgmNoClip({ clipId, preset, volume }) {
  const clip = await VideoClips.findById(clipId);
  if (!clip) throw httpError('Corte não encontrado', 404);
  if (!['pronto', 'publicado'].includes(String(clip.status))) {
    throw httpError('Espere o corte ficar pronto antes de aplicar música.', 422);
  }

  const presetFinal = normalizeBgmPreset(preset != null ? preset : clip.bgm_preset);
  const volumeFinal = normalizeBgmVolume(
    volume != null ? volume : clip.bgm_volume,
    DEFAULT_BGM_VOLUME
  );

  // Sem música: restaura o arquivo limpo, se existir.
  if (presetFinal === 'nenhuma' || presetFinal === DEFAULT_BGM_PRESET) {
    const limpo = clip.arquivo_sem_bgm;
    if (limpo && fs.existsSync(storageAbs(limpo))) {
      const atual = clip.caminho_arquivo;
      await VideoClips.update(clip.id, {
        caminho_arquivo: limpo,
        arquivo_sem_bgm: null,
        bgm_preset: 'nenhuma',
        bgm_volume: volumeFinal,
      });
      if (atual && atual !== limpo) safeUnlink(atual);
      return {
        ok: true,
        preset: 'nenhuma',
        volume: volumeFinal,
        video_url: `/media/${limpo}`,
        message: 'Música removida.',
      };
    }
    await VideoClips.update(clip.id, {
      bgm_preset: 'nenhuma',
      bgm_volume: volumeFinal,
      arquivo_sem_bgm: null,
    });
    return {
      ok: true,
      preset: 'nenhuma',
      volume: volumeFinal,
      video_url: clip.caminho_arquivo ? `/media/${clip.caminho_arquivo}` : null,
      message: 'Sem música de fundo.',
    };
  }

  const fonteRel =
    (clip.arquivo_sem_bgm && fs.existsSync(storageAbs(clip.arquivo_sem_bgm))
      ? clip.arquivo_sem_bgm
      : null) || clip.caminho_arquivo;

  if (!fonteRel || !fs.existsSync(storageAbs(fonteRel))) {
    throw httpError('Arquivo do corte não encontrado — gere o corte novamente.', 422);
  }

  const info = await probe(storageAbs(fonteRel));
  const dur = Number(info?.format?.duration) || 30;
  const uid = crypto.randomBytes(3).toString('hex');
  const bgmRel = `temp/clip_${clip.id}_bgm_${uid}.wav`;
  const outRel = `clips/clip_${clip.id}_bgm_${Date.now()}_${uid}.mp4`;
  const bgmAbs = storageAbs(bgmRel);
  const outAbs = storageAbs(outRel);

  try {
    writeBgmWav(bgmAbs, dur + 1.5, presetFinal);
    await mixBackgroundMusic({
      videoPath: storageAbs(fonteRel),
      bgmPath: bgmAbs,
      outputPath: outAbs,
      bgmVolume: volumeFinal / 100,
    });

    if (!fs.existsSync(outAbs) || fs.statSync(outAbs).size < 1000) {
      throw new Error('arquivo com música vazio');
    }

    const anterior = clip.caminho_arquivo;
    await VideoClips.update(clip.id, {
      caminho_arquivo: outRel,
      arquivo_sem_bgm: fonteRel,
      bgm_preset: presetFinal,
      bgm_volume: volumeFinal,
    });

    // Apaga só saídas BGM antigas — não o arquivo limpo.
    if (
      anterior &&
      anterior !== fonteRel &&
      anterior !== outRel &&
      /_bgm_/i.test(String(anterior))
    ) {
      safeUnlink(anterior);
    }

    return {
      ok: true,
      preset: presetFinal,
      volume: volumeFinal,
      video_url: `/media/${outRel}`,
      message: 'Música de fundo aplicada.',
    };
  } catch (err) {
    safeUnlink(outRel);
    throw err;
  } finally {
    safeUnlink(bgmRel);
  }
}

/** Reaplica o BGM salvo no clip (após split/capa), se houver preset. */
async function reaplicarBgmSeConfigurado(clipId) {
  const clip = await VideoClips.findById(clipId);
  if (!clip) return null;
  const preset = normalizeBgmPreset(clip.bgm_preset);
  if (preset === 'nenhuma') return null;

  // Após split/capa o arquivo mudou: trata o atual como “sem BGM” e remixa.
  await VideoClips.update(clip.id, {
    arquivo_sem_bgm: clip.caminho_arquivo,
  });

  return aplicarBgmNoClip({
    clipId: clip.id,
    preset,
    volume: clip.bgm_volume,
  });
}

module.exports = {
  aplicarBgmNoClip,
  reaplicarBgmSeConfigurado,
};
