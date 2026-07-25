/**
 * Reel narrado 9:16: slideshow com zoom (Ken Burns) + narração suspense + BGM baixa.
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
const MAX_SLIDE_IMAGES = 8;
const MIN_SLIDE_SEC = 3.2;
const MAX_SLIDE_SEC = 7.5;
/** Volume da trilha de suspense (0–1). amix com normalize=0 — audível no celular sem cobrir a voz */
const BGM_VOLUME = 0.32;
const VOICE_VOLUME = 1.05;

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

function safeUnlink(filePath) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    /* ignore */
  }
}

/**
 * Monta texto de narração: título + corpo, sem bloco Fontes/créditos, ~60–90s.
 * Pausas leves (“…”) para ritmo de suspense.
 */
function prepararTextoNarracao(matter) {
  const titulo = String(matter.titulo || '')
    .replace(/\s+/g, ' ')
    .trim();
  let corpo = String(matter.materia || '')
    .replace(/\r\n/g, '\n')
    .trim();

  corpo = corpo.replace(/\n\s*Fontes?\s*:\s*[\s\S]*$/i, '').trim();
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

  // Ritmo: após frases, pausa breve (TTS interpreta reticências)
  texto = texto.replace(/\.(\s+)/g, '… ');

  return texto;
}

async function downloadImageToTemp(url, stamp) {
  const tmp = tempPath(`reel_slide_${stamp}_${crypto.randomBytes(4).toString('hex')}.jpg`);
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 45000,
    maxRedirects: 5,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ViralizeAI/1.0)' },
    validateStatus: (s) => s >= 200 && s < 400,
    maxContentLength: 12 * 1024 * 1024,
  });
  const buf = Buffer.from(response.data);
  if (buf.length < 800) return null;
  fs.writeFileSync(tmp, buf);
  return tmp;
}

/**
 * Resolve arquivo de imagem local da matéria (arte / media / URL).
 */
async function resolveImagemPrincipal(matter) {
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
    const stamp = crypto.randomBytes(4).toString('hex');
    const tmp = await downloadImageToTemp(url, stamp);
    if (tmp) return { absPath: tmp, cleanup: tmp };
  }

  const err = new Error(
    'Gere a arte (Minha marca) ou defina uma imagem na matéria antes de criar o Reel narrado.'
  );
  err.status = 422;
  throw err;
}

/**
 * Imagens do Reel: SOMENTE as da própria matéria (arte Minha marca + foto da fonte).
 * Nunca busca Google/Pexels/stock — evita pessoas/cenas sem relação (e conteúdo impróprio).
 */
async function montarSlides(matter, { maxImagens = MAX_SLIDE_IMAGES } = {}) {
  const cleanups = [];
  const paths = [];
  const seen = new Set();

  function addPath(absPath, cleanup = null) {
    if (!absPath || !fs.existsSync(absPath)) return;
    const key = path.resolve(absPath);
    if (seen.has(key)) return;
    seen.add(key);
    paths.push(absPath);
    if (cleanup) cleanups.push(cleanup);
  }

  // 1) Arte / capa da matéria (obrigatória)
  const principal = await resolveImagemPrincipal(matter);
  addPath(principal.absPath, principal.cleanup);

  // 2) Foto original da fonte (se existir e for diferente da arte)
  const fonteUrl = String(matter.imagem_fonte_url || '').trim();
  if (/^https?:\/\//i.test(fonteUrl) && paths.length < maxImagens) {
    try {
      const stamp = `fonte_${matter.id}_${crypto.randomBytes(3).toString('hex')}`;
      const local = await downloadImageToTemp(fonteUrl, stamp);
      if (local) addPath(local, local);
    } catch (err) {
      console.warn('[matterReel] imagem fonte:', err.message);
    }
  }

  // 3) Variedade visual = reutilizar a(s) imagem(ns) da matéria com zooms diferentes
  //    (NÃO baixar stock / pessoas aleatórias)
  const base = [...paths];
  while (paths.length < Math.min(3, maxImagens) && base.length) {
    paths.push(base[paths.length % base.length]);
  }

  return { paths: paths.slice(0, maxImagens), cleanups };
}

/**
 * Trilha de suspense gerada em PCM (sem lavfi).
 * Inclui médios (~200–400 Hz) para celular ouvir; só grave some no alto-falante do phone.
 */
function writeSuspenseBgmWav(outputPath, seconds) {
  const sampleRate = 48000;
  const channels = 2;
  const bitsPerSample = 16;
  const numSamples = Math.max(1, Math.ceil(Number(seconds) * sampleRate) + sampleRate);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = numSamples * blockAlign;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * blockAlign, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  // Acorde menor tenso (Hz) — graves + médios audíveis no phone
  const freqs = [55, 82.5, 110, 165, 220, 330, 440];
  const amps = [0.18, 0.16, 0.14, 0.12, 0.11, 0.08, 0.05];

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const lfo = 0.62 + 0.38 * Math.sin(2 * Math.PI * 0.09 * t);
    const pulse = 0.8 + 0.2 * Math.sin(2 * Math.PI * 0.42 * t);
    // Hit ritmado leve (~cada 2s) — sensação de trilha, não só zumbido
    const beat = 1 + 0.35 * Math.max(0, Math.sin(2 * Math.PI * 0.5 * t)) ** 8;

    let sample = 0;
    for (let f = 0; f < freqs.length; f++) {
      sample += amps[f] * Math.sin(2 * Math.PI * freqs[f] * t);
    }
    sample += (Math.random() * 2 - 1) * 0.018;
    sample *= lfo * pulse * beat * 0.55;

    let intSample = Math.max(-1, Math.min(1, sample));
    intSample = Math.round(intSample * 30000);
    const offset = 44 + i * blockAlign;
    buffer.writeInt16LE(intSample, offset);
    buffer.writeInt16LE(intSample, offset + 2);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, buffer);
  return outputPath;
}

/**
 * Slide com movimento SEM cortar o título da arte.
 * Fundo: mesma imagem em tela cheia, escurecida/desfocada, com zoom lento.
 * Frente: arte inteira (fit + pad) — título e marca sempre legíveis.
 */
function imageToMotionClip({ imagePath, outputPath, durationSec, zoomIn = true, variant = 0 }) {
  const w = even(REEL_W);
  const h = even(REEL_H);
  const dur = Math.max(MIN_SLIDE_SEC, Number(durationSec) || MIN_SLIDE_SEC);
  const frames = Math.max(Math.round(dur * OUTPUT_FPS), Math.round(MIN_SLIDE_SEC * OUTPUT_FPS));

  // Zoom só no fundo blur — arte da frente não é cropada
  const zExpr = zoomIn
    ? `min(1.0+0.0007*on,1.1)`
    : `max(1.1-0.0007*on,1.0)`;

  const pans = [
    `iw/2-(iw/zoom/2)`,
    `iw/2-(iw/zoom/2)+12`,
    `iw/2-(iw/zoom/2)-12`,
  ];
  const xPan = pans[Math.abs(Number(variant) || 0) % pans.length];

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const run = (useBlur) =>
    new Promise((resolve, reject) => {
      const bgChain = useBlur
        ? `[0:v]scale=${w * 2}:${h * 2}:force_original_aspect_ratio=increase,crop=${w * 2}:${h * 2},eq=brightness=-0.2:saturation=0.7,zoompan=z='${zExpr}':x='${xPan}':y='ih/2-(ih/zoom/2)':d=${frames}:s=${w}x${h}:fps=${OUTPUT_FPS},boxblur=18:8[bg]`
        : `[0:v]scale=${w * 2}:${h * 2}:force_original_aspect_ratio=increase,crop=${w * 2}:${h * 2},eq=brightness=-0.25:saturation=0.65,zoompan=z='${zExpr}':x='${xPan}':y='ih/2-(ih/zoom/2)':d=${frames}:s=${w}x${h}:fps=${OUTPUT_FPS}[bg]`;

      // Frente: arte completa (decrease + sem crop) — título intacto
      const fgChain = `[0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,setsar=1,format=rgba[fg]`;
      const overlay = `[bg][fg]overlay=(W-w)/2:(H-h)/2:format=auto,format=yuv420p,eq=contrast=1.03:saturation=1.04[vout]`;

      ffmpeg()
        .input(imagePath)
        .inputOptions(['-loop', '1'])
        .complexFilter([bgChain, fgChain, overlay])
        .outputOptions([
          '-map',
          '[vout]',
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
          '-preset',
          'veryfast',
          '-crf',
          '23',
          '-an',
          '-movflags',
          '+faststart',
        ])
        .on('error', reject)
        .on('end', () => resolve(outputPath))
        .save(outputPath);
    });

  // Fallback: só arte inteira + pad (zero crop) se blur/overlay falhar
  const runSafeFit = () =>
    new Promise((resolve, reject) => {
      const vf = [
        `scale=${w}:${h}:force_original_aspect_ratio=decrease`,
        `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black`,
        `eq=contrast=1.04:saturation=1.05:brightness=-0.01`,
      ].join(',');

      ffmpeg()
        .input(imagePath)
        .inputOptions(['-loop', '1'])
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
          '-preset',
          'veryfast',
          '-crf',
          '23',
          '-an',
          '-vf',
          vf,
          '-movflags',
          '+faststart',
        ])
        .on('error', reject)
        .on('end', () => resolve(outputPath))
        .save(outputPath);
    });

  return run(true).catch((err) => {
    console.warn('[matterReel] motion+blur falhou, tentando sem blur:', err.message);
    return run(false).catch((err2) => {
      console.warn('[matterReel] motion falhou, fit seguro:', err2.message);
      return runSafeFit();
    });
  });
}

/** @deprecated nome antigo — mantém compat se chamado em algum lugar */
function imageToKenBurnsClip(opts) {
  return imageToMotionClip(opts);
}

function concatClips(clipPaths, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const listFile = tempPath(`concat_${crypto.randomBytes(6).toString('hex')}.txt`);
  // concat demuxer: caminhos absolutos com / (funciona no Windows também)
  const body = clipPaths
    .map((p) => {
      const normalized = path.resolve(p).replace(/\\/g, '/').replace(/'/g, "'\\''");
      return `file '${normalized}'`;
    })
    .join('\n');
  fs.writeFileSync(listFile, body, 'utf8');

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(listFile)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .outputOptions(['-c', 'copy', '-movflags', '+faststart'])
      .on('error', (err) => {
        safeUnlink(listFile);
        reject(err);
      })
      .on('end', () => {
        safeUnlink(listFile);
        resolve(outputPath);
      })
      .save(outputPath);
  });
}

/**
 * Junta vídeo (sem áudio) + voz + BGM.
 * normalize=0 no amix: sem isso o ffmpeg divide o volume e a trilha some.
 */
function mixVideoVoiceBgm({ videoPath, voicePath, bgmPath, outputPath, durationSec }) {
  const dur = Math.min(MAX_AUDIO_SECONDS, Math.max(MIN_AUDIO_SECONDS, Number(durationSec) || 30));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(videoPath)
      .input(voicePath)
      .input(bgmPath)
      .complexFilter([
        `[1:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${VOICE_VOLUME}[voice]`,
        `[2:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${BGM_VOLUME},afade=t=in:st=0:d=0.8[bgm]`,
        `[voice][bgm]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`,
      ])
      .outputOptions([
        '-map',
        '0:v:0',
        '-map',
        '[aout]',
        '-c:v',
        'copy',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-ar',
        '48000',
        '-ac',
        '2',
        '-t',
        String(dur),
        '-shortest',
        '-movflags',
        '+faststart',
      ])
      .on('error', reject)
      .on('end', () => resolve(outputPath))
      .save(outputPath);
  });
}

/** Fallback se amix/afade falhar no build do servidor: mix mais simples. */
function mixVideoVoiceBgmSimple({ videoPath, voicePath, bgmPath, outputPath, durationSec }) {
  const dur = Math.min(MAX_AUDIO_SECONDS, Math.max(MIN_AUDIO_SECONDS, Number(durationSec) || 30));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(videoPath)
      .input(voicePath)
      .input(bgmPath)
      .complexFilter([
        `[1:a]volume=${VOICE_VOLUME}[voice]`,
        `[2:a]volume=${BGM_VOLUME}[bgm]`,
        `[voice][bgm]amix=inputs=2:duration=first:normalize=0[aout]`,
      ])
      .outputOptions([
        '-map',
        '0:v:0',
        '-map',
        '[aout]',
        '-c:v',
        'copy',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-t',
        String(dur),
        '-shortest',
        '-movflags',
        '+faststart',
      ])
      .on('error', reject)
      .on('end', () => resolve(outputPath))
      .save(outputPath);
  });
}

async function mixVideoVoiceBgmSafe(opts) {
  try {
    return await mixVideoVoiceBgm(opts);
  } catch (err) {
    console.warn('[matterReel] mix BGM principal falhou, tentando simples:', err.message);
    return mixVideoVoiceBgmSimple(opts);
  }
}

/**
 * Fallback: um Ken Burns longo + mix voz/BGM (se o slideshow multi-clip falhar).
 */
async function singleImageWithAudio({ imagePath, voicePath, bgmPath, outputPath, durationSec }) {
  const silent = tempPath(`reel_fallback_${crypto.randomBytes(6).toString('hex')}.mp4`);
  try {
    await imageToMotionClip({
      imagePath,
      outputPath: silent,
      durationSec,
      zoomIn: true,
    });
    await mixVideoVoiceBgmSafe({
      videoPath: silent,
      voicePath,
      bgmPath,
      outputPath,
      durationSec,
    });
  } finally {
    safeUnlink(silent);
  }
}

function planejarDuracoes(totalSec, nSlides) {
  const n = Math.max(1, nSlides);
  let each = totalSec / n;
  each = Math.min(MAX_SLIDE_SEC, Math.max(MIN_SLIDE_SEC, each));
  // Ajusta quantidade se o total não cobrir o áudio
  let count = Math.max(1, Math.ceil(totalSec / each));
  count = Math.min(count, n);
  const durs = [];
  let remaining = totalSec;
  for (let i = 0; i < count; i++) {
    const left = count - i;
    const d = i === count - 1 ? remaining : Math.min(MAX_SLIDE_SEC, Math.max(MIN_SLIDE_SEC, remaining / left));
    durs.push(d);
    remaining -= d;
  }
  return durs;
}

/**
 * Gera MP4 Reel narrado e atualiza a matéria (video_path + tipo reel).
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

  const stamp = `${matter.id}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const audioAbs = tempPath(`reel_tts_${stamp}.mp3`);
  const bgmAbs = tempPath(`reel_bgm_${stamp}.wav`);
  const silentVideoAbs = tempPath(`reel_vid_${stamp}.mp4`);
  const videoRel = path.join('reels', `matter_${matter.id}`, `narrado_${stamp}.mp4`).replace(/\\/g, '/');
  const videoAbs = storageAbs(videoRel);
  fs.mkdirSync(path.dirname(videoAbs), { recursive: true });

  const slides = await montarSlides(matter);
  const clipPaths = [];
  let rendered = false;

  try {
    await elevenLabsTts.synthetizar({ texto, outputPath: audioAbs, estilo: 'suspense' });

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
    writeSuspenseBgmWav(bgmAbs, useDur + 2);

    const durs = planejarDuracoes(useDur, slides.paths.length);
    const usedPaths = slides.paths.slice(0, durs.length);

    try {
      for (let i = 0; i < usedPaths.length; i++) {
        const clipOut = tempPath(`reel_clip_${stamp}_${i}.mp4`);
        await imageToMotionClip({
          imagePath: usedPaths[i],
          outputPath: clipOut,
          durationSec: durs[i],
          zoomIn: i % 2 === 0,
          variant: i,
        });
        clipPaths.push(clipOut);
      }

      await concatClips(clipPaths, silentVideoAbs);
      await mixVideoVoiceBgmSafe({
        videoPath: silentVideoAbs,
        voicePath: audioAbs,
        bgmPath: bgmAbs,
        outputPath: videoAbs,
        durationSec: useDur,
      });
    } catch (slideErr) {
      console.warn('[matterReel] slideshow falhou, fallback 1 imagem:', slideErr.message);
      await singleImageWithAudio({
        imagePath: slides.paths[0],
        voicePath: audioAbs,
        bgmPath: bgmAbs,
        outputPath: videoAbs,
        durationSec: useDur,
      });
    }

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
      slides: usedPaths.length,
      voiceId: elevenLabsTts.voiceId(),
      estilo: 'suspense',
      bgm: true,
    };
  } finally {
    safeUnlink(audioAbs);
    safeUnlink(bgmAbs);
    safeUnlink(silentVideoAbs);
    for (const c of clipPaths) safeUnlink(c);
    for (const c of slides.cleanups) safeUnlink(c);
    if (!rendered) safeUnlink(videoAbs);
  }
}

module.exports = {
  gerarReelNarrado,
  prepararTextoNarracao,
  MAX_NARRATION_CHARS,
};
