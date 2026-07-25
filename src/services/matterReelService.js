/**
 * Reel narrado 9:16 — encode LEVE para VPS (evita SIGKILL/OOM).
 * Arte inteira (sem cortar título) + voz suspense + BGM.
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
/** 24fps + 1 thread = bem menos RAM que zoompan/blur em 2× */
const OUTPUT_FPS = 24;
/** ~12 chars/s em PT com voz suspense → ~650 chars ≈ 50–55s; hard cap 60s no encode */
const MAX_NARRATION_CHARS = 650;
const MIN_AUDIO_SECONDS = 3;
const MAX_AUDIO_SECONDS = 60;
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
 * Resume a matéria para narração de Reel (máx. ~60s).
 * Prioriza título + frases iniciais (lead), sem enrolação.
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
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Frases do lead (até 5), cabendo no limite de chars do Reel
  const budget = Math.max(80, MAX_NARRATION_CHARS - (titulo ? titulo.length + 2 : 0));
  const frases = corpo
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 12);

  const escolhidas = [];
  let used = 0;
  for (const frase of frases) {
    if (escolhidas.length >= 5) break;
    const extra = (escolhidas.length ? 1 : 0) + frase.length;
    if (used + extra > budget) {
      // tenta encaixar uma frase curta final
      if (frase.length <= 90 && used + extra <= budget + 40 && escolhidas.length < 4) {
        const corta = frase.slice(0, budget - used - 1).trim();
        if (corta.length > 20) {
          escolhidas.push(/[.!?…]$/.test(corta) ? corta : `${corta}…`);
        }
      }
      break;
    }
    escolhidas.push(frase);
    used += extra;
  }

  let texto = titulo
    ? `${titulo}. ${escolhidas.join(' ')}`.trim()
    : escolhidas.join(' ').trim();
  texto = texto.replace(/\s+/g, ' ').trim();

  if (texto.length > MAX_NARRATION_CHARS) {
    const slice = texto.slice(0, MAX_NARRATION_CHARS);
    const lastStop = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '));
    texto = (lastStop > MAX_NARRATION_CHARS * 0.5 ? slice.slice(0, lastStop + 1) : slice).trim();
    if (!/[.!?…]$/.test(texto)) texto += '.';
  }

  // Não troca "." por "…" — isso dessincronizava a legenda do que a voz fala
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

/** Só a arte/imagem da matéria — sem stock e sem vários clips (economia de RAM). */
async function montarSlides(matter) {
  const cleanups = [];
  const principal = await resolveImagemPrincipal(matter);
  if (principal.cleanup) cleanups.push(principal.cleanup);
  return { paths: [principal.absPath], cleanups };
}

/** BGM PCM 24k mono — arquivo menor. */
function writeSuspenseBgmWav(outputPath, seconds) {
  const sampleRate = 24000;
  const channels = 1;
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

  const freqs = [55, 82.5, 110, 165, 220, 330];
  const amps = [0.18, 0.16, 0.14, 0.12, 0.11, 0.08];

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const lfo = 0.62 + 0.38 * Math.sin(2 * Math.PI * 0.09 * t);
    const pulse = 0.8 + 0.2 * Math.sin(2 * Math.PI * 0.42 * t);
    const beat = 1 + 0.35 * Math.max(0, Math.sin(2 * Math.PI * 0.5 * t)) ** 8;
    let sample = 0;
    for (let f = 0; f < freqs.length; f++) {
      sample += amps[f] * Math.sin(2 * Math.PI * freqs[f] * t);
    }
    sample += (Math.random() * 2 - 1) * 0.015;
    sample *= lfo * pulse * beat * 0.55;
    buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 30000), 44 + i * blockAlign);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, buffer);
  return outputPath;
}

function fontsDir() {
  return path.resolve(__dirname, '../../assets/fonts');
}

function escapeFilterPath(p) {
  return String(p)
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'");
}

function assTime(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const whole = Math.floor(s % 60);
  const cs = Math.floor((s - Math.floor(s)) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(whole).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function wrapCaptionLines(text, maxPerLine = 24) {
  const words = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > maxPerLine && cur) {
      lines.push(cur);
      cur = w;
      if (lines.length >= 2) break;
    } else {
      cur = next;
    }
  }
  if (cur && lines.length < 2) lines.push(cur);
  return lines.join('\\N');
}

/**
 * Legendadas a partir do alignment real da ElevenLabs (mesmo texto + mesmos tempos da voz).
 */
function cuesFromAlignment(alignment, { durationSec = 60 } = {}) {
  const dur = Math.max(MIN_AUDIO_SECONDS, Number(durationSec) || 60);
  const chars = alignment?.characters || alignment?.chars || [];
  const starts =
    alignment?.character_start_times_seconds ||
    alignment?.characterStartTimesSeconds ||
    [];
  const ends =
    alignment?.character_end_times_seconds ||
    alignment?.characterEndTimesSeconds ||
    [];

  if (!chars.length || chars.length !== starts.length || chars.length !== ends.length) {
    return null;
  }

  const cues = [];
  let buf = '';
  let cueStart = null;
  let lastEnd = 0;

  const flush = () => {
    const raw = buf.replace(/\s+/g, ' ').trim();
    if (!raw || cueStart == null) {
      buf = '';
      cueStart = null;
      return;
    }
    // Pequeno atraso (80ms) para a legenda não “adiantar” a boca/voz
    const start = Math.max(0, cueStart + 0.08);
    const end = Math.min(dur, Math.max(start + 0.7, lastEnd + 0.12));
    cues.push({
      start,
      end,
      text: wrapCaptionLines(raw, 24),
      style: cues.length === 0 ? 'Hook' : 'Default',
    });
    buf = '';
    cueStart = null;
  };

  for (let i = 0; i < chars.length; i++) {
    const ch = String(chars[i] ?? '');
    const st = Number(starts[i]);
    const en = Number(ends[i]);
    if (!Number.isFinite(st) || !Number.isFinite(en)) continue;

    if (cueStart == null) cueStart = st;
    buf += ch;
    lastEnd = en;

    const trimmed = buf.trim();
    const durCue = en - cueStart;
    const breakPunct = /[.!?]/.test(ch);
    const breakLen = trimmed.length >= 40 && /\s/.test(ch);
    const breakTime = durCue >= 3.8 && /\s/.test(ch);

    if ((breakPunct || breakLen || breakTime) && trimmed.length >= 8) {
      flush();
    }
  }
  flush();

  return cues.length ? cues : null;
}

/**
 * Fallback sem timestamps: mesmas frases do texto narrado, tempo proporcional.
 * Sem gancho separado (evita legenda de um texto e voz de outro).
 */
function montarCuesLegenda(textoNarracao, durationSec) {
  const dur = Math.max(MIN_AUDIO_SECONDS, Number(durationSec) || 30);
  const body = String(textoNarracao || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!body) return [];

  const parts = body
    .split(/(?<=[.!?])\s+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 2);

  const chunks = [];
  for (const part of parts) {
    if (part.length <= 48) {
      chunks.push(part);
    } else {
      const words = part.split(/\s+/);
      let cur = '';
      for (const w of words) {
        if ((cur + ' ' + w).trim().length > 44 && cur) {
          chunks.push(cur.trim());
          cur = w;
        } else {
          cur = (cur + ' ' + w).trim();
        }
      }
      if (cur) chunks.push(cur);
    }
  }

  const usable = chunks.slice(0, 24);
  const totalChars = usable.reduce((s, c) => s + c.length, 0) || 1;
  // Atraso inicial: proporção costuma “adiantar” a legenda
  let t = 0.12;
  const bodyDur = Math.max(0.5, dur - 0.2);
  const cues = [];

  for (let i = 0; i < usable.length; i++) {
    const share = usable[i].length / totalChars;
    let len = Math.max(1.3, bodyDur * share);
    if (i === usable.length - 1) len = Math.max(1.0, dur - t - 0.05);
    const end = Math.min(dur, t + len);
    if (end <= t + 0.25) break;
    cues.push({
      start: t,
      end,
      text: wrapCaptionLines(usable[i], 24),
      style: i === 0 ? 'Hook' : 'Default',
    });
    t = end;
  }

  return cues;
}

function montarCuesSincronizadas({ texto, durationSec, alignment }) {
  const fromAlign = cuesFromAlignment(alignment, { durationSec });
  if (fromAlign?.length) return { cues: fromAlign, sync: 'elevenlabs-timestamps' };
  return { cues: montarCuesLegenda(texto, durationSec), sync: 'proporcional' };
}

function writeAssLegenda(outputPath, cues) {
  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1080',
    'PlayResY: 1920',
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // Alignment 5 = centro da tela (meio). Bebas Neue = fonte display limpa p/ Reel.
    // BorderStyle 3 = caixa atrás do texto; Outline = padding da caixa.
    'Style: Default,Bebas Neue,68,&H00FFFFFF,&H000000FF,&H00000000,&HC0000000,-1,0,0,0,100,100,1,0,3,8,0,5,60,60,0,1',
    'Style: Hook,Bebas Neue,78,&H0000F0FF,&H000000FF,&H00000000,&HD0000000,-1,0,0,0,100,100,1.5,0,3,10,0,5,50,50,0,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  for (const c of cues) {
    const style = c.style === 'Hook' ? 'Hook' : 'Default';
    const text = String(c.text || '')
      .replace(/\r?\n/g, '\\N')
      .replace(/[{}]/g, '');
    lines.push(
      `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},${style},,0,0,0,,${text}`
    );
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, lines.join('\n'), 'utf8');
  return outputPath;
}

function buildVideoFilter({ captionsAssPath = null } = {}) {
  const w = even(REEL_W);
  const h = even(REEL_H);
  const parts = [
    `scale=${w}:${h}:force_original_aspect_ratio=decrease`,
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black`,
    `setsar=1`,
    `fps=${OUTPUT_FPS}`,
  ];

  if (captionsAssPath && fs.existsSync(captionsAssPath)) {
    const ass = escapeFilterPath(captionsAssPath);
    const fonts = escapeFilterPath(fontsDir());
    parts.push(`subtitles='${ass}':fontsdir='${fonts}'`);
  }

  parts.push('format=yuv420p');
  return parts.join(',');
}

/**
 * Um único encode leve: arte + voz + BGM (sem legenda queimada).
 */
function renderReelLeve({ imagePath, voicePath, bgmPath, outputPath, durationSec, captionsAssPath }) {
  const dur = Math.min(MAX_AUDIO_SECONDS, Math.max(MIN_AUDIO_SECONDS, Number(durationSec) || 30));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const vf = buildVideoFilter({ captionsAssPath });

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(imagePath)
      .inputOptions(['-loop', '1', '-framerate', String(OUTPUT_FPS)])
      .input(voicePath)
      .input(bgmPath)
      .complexFilter([
        `[0:v]${vf}[vout]`,
        `[1:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${VOICE_VOLUME}[voice]`,
        `[2:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${BGM_VOLUME}[bgm]`,
        `[voice][bgm]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`,
      ])
      .outputOptions([
        '-map',
        '[vout]',
        '-map',
        '[aout]',
        '-t',
        String(dur),
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-tune',
        'stillimage',
        '-crf',
        '26',
        '-threads',
        '1',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-ar',
        '48000',
        '-ac',
        '2',
        '-shortest',
        '-movflags',
        '+faststart',
      ])
      .on('error', reject)
      .on('end', () => resolve(outputPath))
      .save(outputPath);
  });
}

function renderReelLeveSimples({ imagePath, voicePath, bgmPath, outputPath, durationSec, captionsAssPath }) {
  const dur = Math.min(MAX_AUDIO_SECONDS, Math.max(MIN_AUDIO_SECONDS, Number(durationSec) || 30));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const vf = buildVideoFilter({ captionsAssPath });
  const silent = tempPath(`reel_silent_${crypto.randomBytes(4).toString('hex')}.mp4`);

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(imagePath)
      .inputOptions(['-loop', '1', '-framerate', String(OUTPUT_FPS)])
      .outputOptions([
        '-t',
        String(dur),
        '-vf',
        vf,
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-tune',
        'stillimage',
        '-crf',
        '26',
        '-threads',
        '1',
        '-an',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
      ])
      .on('error', reject)
      .on('end', () => {
        ffmpeg()
          .input(silent)
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
            '128k',
            '-t',
            String(dur),
            '-shortest',
            '-movflags',
            '+faststart',
          ])
          .on('error', (err) => {
            safeUnlink(silent);
            reject(err);
          })
          .on('end', () => {
            safeUnlink(silent);
            resolve(outputPath);
          })
          .save(outputPath);
      })
      .save(silent);
  });
}

async function renderReelSafe(opts) {
  try {
    return await renderReelLeve(opts);
  } catch (err) {
    const msg = String(err.message || '');
    // Sem libass: tenta de novo sem legendas
    if (opts.captionsAssPath && /subtitle|ass|font|libass/i.test(msg)) {
      console.warn('[matterReel] legendas falharam (libass?), gerando sem ASS:', msg);
      const sem = { ...opts, captionsAssPath: null };
      try {
        return await renderReelLeve(sem);
      } catch (err2) {
        console.warn('[matterReel] encode leve falhou, tentando simples:', err2.message);
        return renderReelLeveSimples(sem);
      }
    }
    console.warn('[matterReel] encode leve falhou, tentando simples:', msg);
    try {
      return await renderReelLeveSimples(opts);
    } catch (err3) {
      if (opts.captionsAssPath) {
        console.warn('[matterReel] simples com legenda falhou, sem legenda:', err3.message);
        return renderReelLeveSimples({ ...opts, captionsAssPath: null });
      }
      throw err3;
    }
  }
}

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
  const videoRel = path.join('reels', `matter_${matter.id}`, `narrado_${stamp}.mp4`).replace(/\\/g, '/');
  const videoAbs = storageAbs(videoRel);
  fs.mkdirSync(path.dirname(videoAbs), { recursive: true });

  const slides = await montarSlides(matter);
  let rendered = false;

  try {
    await elevenLabsTts.synthetizar({
      texto,
      outputPath: audioAbs,
      estilo: 'suspense',
      withTimestamps: false,
    });

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

    await renderReelSafe({
      imagePath: slides.paths[0],
      voicePath: audioAbs,
      bgmPath: bgmAbs,
      outputPath: videoAbs,
      durationSec: useDur,
      captionsAssPath: null,
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
      slides: 1,
      voiceId: elevenLabsTts.voiceId(),
      estilo: 'suspense',
      bgm: true,
      legendas: false,
      legendasSync: false,
      encode: 'leve',
    };
  } finally {
    safeUnlink(audioAbs);
    safeUnlink(bgmAbs);
    for (const c of slides.cleanups) safeUnlink(c);
    if (!rendered) safeUnlink(videoAbs);
  }
}

module.exports = {
  gerarReelNarrado,
  prepararTextoNarracao,
  MAX_NARRATION_CHARS,
};
