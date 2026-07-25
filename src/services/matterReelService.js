/**
 * Gera Reel 9:16 a partir da imagem da matéria + narração TTS (ElevenLabs).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const { env } = require('../config/env');
const { probe } = require('./ffmpegService');
const { resolveArtworkPath } = require('./matterArtworkService');
const { storageAbsolutePath } = require('./downloadService');
const elevenLabsTts = require('./elevenLabsTtsService');
const AiMatters = require('../models/AiMatters');

const REEL_W = 1080;
const REEL_H = 1920;
const OUTPUT_FPS = 30;
const MAX_NARRATION_CHARS = 1100;
const MIN_AUDIO_SECONDS = 3;
const MAX_AUDIO_SECONDS = 90;

function storageAbs(relative) {
  return path.resolve(env.storagePath, relative);
}

function tempPath(name) {
  const dir = storageAbs('temp');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

function even(n) {
  const v = Math.max(2, Math.round(Number(n) || 2));
  return v % 2 === 0 ? v : v + 1;
}

/**
 * Monta texto de narração: título + corpo, sem bloco Fontes/créditos, ~60–90s.
 */
function prepararTextoNarracao(matter) {
  const titulo = String(matter.titulo || '')
    .replace(/\s+/g, ' ')
    .trim();
  let corpo = String(matter.materia || '')
    .replace(/\r\n/g, '\n')
    .trim();

  // Remove bloco Fontes: … até o fim (créditos não devem ser narrados)
  corpo = corpo.replace(/\n\s*Fontes?\s*:\s*[\s\S]*$/i, '').trim();
  // Remove linhas só de hashtags
  corpo = corpo
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      if (!t) return false;
      if (/^#[\w\u00C0-\u024F]+(\s+#[\w\u00C0-\u024F]+)*$/i.test(t)) return false;
      return true;
    })
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();

  let texto = titulo ? `${titulo}. ${corpo}` : corpo;
  texto = texto.replace(/\s+/g, ' ').trim();

  if (texto.length > MAX_NARRATION_CHARS) {
    const slice = texto.slice(0, MAX_NARRATION_CHARS);
    const lastStop = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '));
    texto = (lastStop > MAX_NARRATION_CHARS * 0.55 ? slice.slice(0, lastStop + 1) : slice).trim();
    if (!/[.!?]$/.test(texto)) texto += '…';
  }

  return texto;
}

/**
 * Resolve arquivo de imagem local para o Reel (arte Minha marca, /media/, ou download remoto).
 * @returns {Promise<{ absPath: string, cleanup: string|null }>}
 */
async function resolveImagemParaReel(matter) {
  const artwork = resolveArtworkPath(matter.imagem_path);
  if (artwork) return { absPath: artwork, cleanup: null };

  if (matter.imagem_path) {
    const fromStorage = storageAbsolutePath(matter.imagem_path);
    if (fs.existsSync(fromStorage)) return { absPath: fromStorage, cleanup: null };
  }

  const url = String(matter.imagem_url || matter.imagem_fonte_url || '').trim();
  if (url.startsWith('/media/')) {
    const relative = url.slice('/media/'.length).replace(/\//g, path.sep);
    const abs = storageAbsolutePath(relative);
    if (fs.existsSync(abs)) return { absPath: abs, cleanup: null };
  }

  if (/^https?:\/\//i.test(url)) {
    try {
      const parsed = new URL(url);
      if (parsed.pathname.startsWith('/media/')) {
        const relative = parsed.pathname.slice('/media/'.length).replace(/\//g, path.sep);
        const abs = storageAbsolutePath(relative);
        if (fs.existsSync(abs)) return { absPath: abs, cleanup: null };
      }
    } catch {
      /* ignore */
    }

    const tmp = tempPath(`reel_img_${crypto.randomBytes(8).toString('hex')}.jpg`);
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 60000,
      maxRedirects: 5,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ViralizeAI/1.0)' },
      validateStatus: (s) => s >= 200 && s < 400,
    });
    const buf = Buffer.from(response.data);
    if (buf.length < 500) {
      const err = new Error('Não foi possível baixar a imagem da matéria');
      err.status = 422;
      throw err;
    }
    fs.writeFileSync(tmp, buf);
    return { absPath: tmp, cleanup: tmp };
  }

  const err = new Error(
    'Gere a arte (Minha marca) ou defina uma imagem na matéria antes de criar o Reel narrado.'
  );
  err.status = 422;
  throw err;
}

function imageAudioToReel({ imagePath, audioPath, outputPath, durationSec }) {
  const w = even(REEL_W);
  const h = even(REEL_H);
  const dur = Math.min(MAX_AUDIO_SECONDS, Math.max(MIN_AUDIO_SECONDS, Number(durationSec) || MAX_AUDIO_SECONDS));

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(imagePath)
      .inputOptions(['-loop', '1'])
      .input(audioPath)
      .outputOptions([
        '-t',
        String(dur),
        '-r',
        String(OUTPUT_FPS),
        '-vsync',
        'cfr',
        '-pix_fmt',
        'yuv420p',
        '-c:v',
        'libx264',
        '-tune',
        'stillimage',
        '-preset',
        'veryfast',
        '-crf',
        '23',
        '-g',
        String(OUTPUT_FPS * 2),
        '-keyint_min',
        String(OUTPUT_FPS * 2),
        '-sc_threshold',
        '0',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-ar',
        '48000',
        '-ac',
        '2',
        '-vf',
        `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black`,
        '-shortest',
        '-movflags',
        '+faststart',
      ])
      .on('error', reject)
      .on('end', () => resolve(outputPath))
      .save(outputPath);
  });
}

function safeUnlink(filePath) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    /* ignore */
  }
}

/**
 * Gera MP4 Reel narrado e atualiza a matéria (video_path + tipo reel).
 * @param {{ userId: number, matterId: number }} opts
 */
async function gerarReelNarrado({ userId, matterId }) {
  if (!elevenLabsTts.isConfigured()) {
    const err = new Error(
      'ELEVENLABS_API_KEY não configurada. Adicione no .env para narrar o Reel.'
    );
    err.status = 503;
    throw err;
  }

  const matter = await AiMatters.findById(matterId);
  if (!matter || Number(matter.user_id) !== Number(userId)) {
    const err = new Error('Matéria não encontrada');
    err.status = 404;
    throw err;
  }

  const texto = prepararTextoNarracao(matter);
  if (texto.length < 40) {
    const err = new Error('Texto da matéria muito curto para narrar. Amplie o conteúdo e tente de novo.');
    err.status = 400;
    throw err;
  }

  const image = await resolveImagemParaReel(matter);
  const stamp = `${matter.id}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const audioRel = path.join('temp', `reel_tts_${stamp}.mp3`);
  const audioAbs = storageAbs(audioRel);
  const videoRel = path.join('reels', `matter_${matter.id}`, `narrado_${stamp}.mp4`).replace(/\\/g, '/');
  const videoAbs = storageAbs(videoRel);

  let rendered = false;
  try {
    await elevenLabsTts.synthetizar({ texto, outputPath: audioAbs });

    const info = await probe(audioAbs);
    const audioDur = Number(info?.format?.duration) || 0;
    if (audioDur < MIN_AUDIO_SECONDS) {
      const err = new Error(
        `Áudio muito curto (${audioDur.toFixed(1)}s). O Facebook Reel exige pelo menos ${MIN_AUDIO_SECONDS}s.`
      );
      err.status = 422;
      throw err;
    }

    const useDur = Math.min(audioDur, MAX_AUDIO_SECONDS);
    await imageAudioToReel({
      imagePath: image.absPath,
      audioPath: audioAbs,
      outputPath: videoAbs,
      durationSec: useDur,
    });
    rendered = true;

    if (!fs.existsSync(videoAbs) || fs.statSync(videoAbs).size < 1000) {
      const err = new Error('Falha ao montar o vídeo do Reel (arquivo inválido)');
      err.status = 500;
      throw err;
    }

    const oldVideo = matter.video_path ? storageAbs(matter.video_path) : null;

    await AiMatters.update(matter.id, {
      video_path: videoRel,
      video_clip_id: null,
      tipo_publicacao: 'reel',
      status: matter.status === 'publicado' || matter.status === 'agendado' ? matter.status : 'pronto',
      error_message: null,
    });

    // Remove vídeo narrado anterior (só se estiver em reels/matter_*)
    if (
      oldVideo &&
      oldVideo !== videoAbs &&
      String(matter.video_path || '').includes(`matter_${matter.id}`) &&
      fs.existsSync(oldVideo)
    ) {
      safeUnlink(oldVideo);
    }

    const updated = await AiMatters.findById(matter.id);
    return {
      matter: updated,
      videoPath: videoRel,
      videoUrl: `/media/${videoRel}`,
      duracao: useDur,
      charsNarrados: texto.length,
      voiceId: elevenLabsTts.voiceId(),
    };
  } finally {
    safeUnlink(audioAbs);
    if (image.cleanup) safeUnlink(image.cleanup);
    if (!rendered) safeUnlink(videoAbs);
  }
}

module.exports = {
  gerarReelNarrado,
  prepararTextoNarracao,
  MAX_NARRATION_CHARS,
};
