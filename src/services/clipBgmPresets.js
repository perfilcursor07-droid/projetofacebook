/**
 * Música de fundo com toque suave / cinematográfico.
 * Preferência: arquivo real em assets/bgm/{preset}.mp3|.wav|.m4a
 * Fallback: piano + pad + reverb (bem mais musical que seno cru).
 */

const fs = require('fs');
const path = require('path');
const { env } = require('../config/env');

const DEFAULT_BGM_PRESET = 'nenhuma';
const DEFAULT_BGM_VOLUME = 14;
const LOOP_SECONDS = 20;
const SAMPLE_RATE = 44100;
const BGM_CACHE_VERSION = 'v6soft';

const BGM_PRESETS = Object.freeze([
  Object.freeze({
    id: 'nenhuma',
    name: 'Sem música',
    description: 'Só o áudio original do vídeo.',
  }),
  Object.freeze({
    id: 'triste',
    name: 'Triste',
    description: 'Piano menor suave — emoção, testemunho.',
  }),
  Object.freeze({
    id: 'alegre',
    name: 'Alegre',
    description: 'Piano maior claro — celebração leve.',
  }),
  Object.freeze({
    id: 'epico',
    name: 'Épico',
    description: 'Pad heroico + piano — revelação, impacto.',
  }),
  Object.freeze({
    id: 'suave',
    name: 'Suave',
    description: 'Ambient calmo — oração, paz, ensino.',
  }),
  Object.freeze({
    id: 'suspense',
    name: 'Suspense',
    description: 'Pad escuro cinematográfico — mistério.',
  }),
]);

const PRESET_IDS = new Set(BGM_PRESETS.map((p) => p.id));

function isBgmPreset(value) {
  return PRESET_IDS.has(String(value || ''));
}

function normalizeBgmPreset(value) {
  return isBgmPreset(value) ? String(value) : DEFAULT_BGM_PRESET;
}

function normalizeBgmVolume(value, fallback = DEFAULT_BGM_VOLUME) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(40, Math.max(5, Math.round(n)));
}

function midiToHz(midi) {
  return 440 * 2 ** ((Number(midi) - 69) / 12);
}

/** Progressões bonitas e distintas por humor. */
function moodScore(presetId) {
  switch (normalizeBgmPreset(presetId)) {
    case 'triste':
      return {
        bpm: 58,
        master: 0.55,
        // Am – F – C – G (emoção clássica)
        chords: [
          [57, 60, 64, 69],
          [53, 57, 60, 65],
          [48, 52, 55, 60],
          [55, 59, 62, 67],
        ],
        pianoMelody: [76, 74, 72, 69, 71, 69, 67, 64, 65, 64, 62, 60, 62, 64, 67, 69],
        padGain: 0.22,
        pianoGain: 0.32,
        brightness: 0.55,
        darkness: 0.15,
      };
    case 'alegre':
      return {
        bpm: 92,
        master: 0.52,
        // C – G – Am – F
        chords: [
          [60, 64, 67, 72],
          [55, 59, 62, 67],
          [57, 60, 64, 69],
          [53, 57, 60, 65],
        ],
        pianoMelody: [72, 76, 79, 76, 74, 72, 67, 72, 71, 74, 76, 79, 76, 74, 72, 67],
        padGain: 0.16,
        pianoGain: 0.36,
        brightness: 0.85,
        darkness: 0,
      };
    case 'epico':
      return {
        bpm: 72,
        master: 0.58,
        // Em – C – G – D
        chords: [
          [52, 55, 59, 64, 71],
          [48, 52, 55, 60, 67],
          [55, 59, 62, 67, 74],
          [50, 54, 57, 62, 69],
        ],
        pianoMelody: [71, 67, 64, 67, 71, 74, 76, 74, 71, 67, 64, 59, 62, 64, 67, 71],
        padGain: 0.28,
        pianoGain: 0.28,
        brightness: 0.7,
        darkness: 0.1,
      };
    case 'suave':
      return {
        bpm: 48,
        master: 0.48,
        // Cadd9 – Am7 – Fmaj7 – Gsus
        chords: [
          [48, 60, 64, 67, 74],
          [45, 57, 60, 64, 67],
          [41, 53, 57, 60, 64],
          [43, 55, 60, 62, 67],
        ],
        pianoMelody: [67, 69, 71, 72, 74, 72, 71, 69, 67, 64, 62, 60, 62, 64, 67, 69],
        padGain: 0.3,
        pianoGain: 0.18,
        brightness: 0.45,
        darkness: 0,
      };
    case 'suspense':
      return {
        bpm: 62,
        master: 0.5,
        // Em(add9) – Bm – C – Am (tensão suave, cinematográfico)
        chords: [
          [52, 55, 59, 66],
          [47, 50, 54, 59],
          [48, 52, 55, 60],
          [45, 48, 52, 59],
        ],
        pianoMelody: [71, 69, 67, 66, 64, 62, 64, 59, 62, 64, 66, 67, 66, 64, 62, 59],
        padGain: 0.34,
        pianoGain: 0.16,
        brightness: 0.35,
        darkness: 0.35,
      };
    default:
      return null;
  }
}

/** Nota de piano: ataque rápido + decaimento exponencial (soa “bonito”). */
function addPiano(samples, sampleRate, midi, startSec, durSec, amp, brightness) {
  const f0 = midiToHz(midi);
  const start = Math.max(0, Math.floor(startSec * sampleRate));
  const len = Math.min(samples.length - start, Math.floor(durSec * sampleRate));
  if (len <= 0) return;

  // parciais leves (tom de piano aproximado)
  const partials = [
    [1, 1],
    [2, 0.42 * brightness],
    [3, 0.18 * brightness],
    [4, 0.08 * brightness],
    [5, 0.04 * brightness],
  ];

  for (let i = 0; i < len; i++) {
    const t = i / sampleRate;
    const env = Math.exp(-2.8 * t / Math.max(0.25, durSec)) * (1 - Math.exp(-90 * t));
    let v = 0;
    for (const [mul, a] of partials) {
      // levíssima desafinação nos harmônicos altos = mais natural
      const det = mul > 1 ? 1 + mul * 0.0004 : 1;
      v += a * Math.sin(2 * Math.PI * f0 * mul * det * t);
    }
    samples[start + i] += v * env * amp;
  }
}

/** Pad quente (cordas/ambient) com ataque lento. */
function addPad(samples, sampleRate, midis, startSec, durSec, amp, darkness) {
  const start = Math.max(0, Math.floor(startSec * sampleRate));
  const len = Math.min(samples.length - start, Math.floor(durSec * sampleRate));
  if (len <= 0) return;

  const voices = [];
  for (const midi of midis) {
    const f = midiToHz(midi);
    voices.push(f * 0.997, f, f * 1.003); // chorus
  }

  for (let i = 0; i < len; i++) {
    const t = i / sampleRate;
    const p = t / durSec;
    const atk = Math.min(1, t / 0.55);
    const rel = p > 0.82 ? (1 - p) / 0.18 : 1;
    const env = atk * rel;
    let v = 0;
    for (let vi = 0; vi < voices.length; vi++) {
      const f = voices[vi];
      const s = Math.sin(2 * Math.PI * f * t);
      const soft = Math.sin(2 * Math.PI * f * 2 * t) * (0.18 - darkness * 0.08);
      v += (s + soft) / voices.length;
    }
    // escurece um pouco no suspense
    if (darkness > 0) {
      v *= 0.85 + 0.15 * Math.sin(2 * Math.PI * 0.12 * t);
    }
    samples[start + i] += v * env * amp;
  }
}

/** Reverb barato (ecos) — dá espaço e “beleza”. */
function applySoftReverb(samples, sampleRate) {
  const delays = [
    Math.floor(0.029 * sampleRate),
    Math.floor(0.037 * sampleRate),
    Math.floor(0.053 * sampleRate),
    Math.floor(0.079 * sampleRate),
  ];
  const gains = [0.28, 0.22, 0.16, 0.12];
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    let s = samples[i];
    for (let d = 0; d < delays.length; d++) {
      const j = i - delays[d];
      if (j >= 0) s += out[j] * gains[d];
    }
    out[i] = s;
  }
  for (let i = 0; i < samples.length; i++) samples[i] = out[i];
}

function writeBgmWav(outputPath, seconds, presetId) {
  const score = moodScore(presetId);
  if (!score) throw new Error('Preset de música inválido');

  const sampleRate = SAMPLE_RATE;
  const numSamples = Math.max(1, Math.ceil(Number(seconds) * sampleRate));
  const samples = new Float32Array(numSamples);
  const beatSec = 60 / score.bpm;
  const barSec = beatSec * 4;
  const totalBars = Math.ceil(Number(seconds) / barSec) + 1;

  for (let bar = 0; bar < totalBars; bar++) {
    const chord = score.chords[bar % score.chords.length];
    const barStart = bar * barSec;

    // Pad cobrindo o compasso
    addPad(
      samples,
      sampleRate,
      chord,
      barStart,
      barSec * 1.05,
      score.padGain,
      score.darkness
    );

    // Acorde de piano no tempo 1 (arpejo suave)
    for (let n = 0; n < chord.length; n++) {
      addPiano(
        samples,
        sampleRate,
        chord[n],
        barStart + n * 0.07,
        barSec * 0.95,
        score.pianoGain * (0.55 + 0.08 * (chord.length - n)),
        score.brightness
      );
    }

    // Melodia esparsa (notas longas, não bip-bip)
    for (let s = 0; s < 4; s++) {
      const midi = score.pianoMelody[(bar * 4 + s) % score.pianoMelody.length];
      const t0 = barStart + s * beatSec + 0.02;
      addPiano(
        samples,
        sampleRate,
        midi,
        t0,
        beatSec * 1.35,
        score.pianoGain * 0.72,
        score.brightness
      );
    }

    // Baixo suave (oitava abaixo da fundamental)
    addPiano(
      samples,
      sampleRate,
      chord[0] - 12,
      barStart,
      barSec * 0.98,
      score.pianoGain * 0.45,
      Math.min(0.5, score.brightness)
    );
  }

  applySoftReverb(samples, sampleRate);

  const dataSize = numSamples * 2;
  const buffer = Buffer.allocUnsafe(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  const fade = Math.min(sampleRate * 0.35, numSamples / 5);
  const master = score.master;
  for (let i = 0; i < numSamples; i++) {
    let s = samples[i] * master;
    if (i < fade) s *= i / fade;
    if (i > numSamples - fade) s *= (numSamples - i) / fade;
    // soft clip
    s = Math.tanh(s * 0.95);
    buffer.writeInt16LE((Math.max(-1, Math.min(1, s)) * 28000) | 0, 44 + i * 2);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, buffer);
  return outputPath;
}

function assetsBgmDir() {
  return path.resolve(__dirname, '../../assets/bgm');
}

function bgmCacheDir() {
  const dir = path.resolve(env.storagePath, 'bgm');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Se existir MP3/WAV real em assets/bgm, usa — senão gera o soft synth. */
function findAssetTrack(presetId) {
  const id = normalizeBgmPreset(presetId);
  if (id === 'nenhuma') return null;
  const dir = assetsBgmDir();
  const candidates = [
    path.join(dir, `${id}.mp3`),
    path.join(dir, `${id}.wav`),
    path.join(dir, `${id}.m4a`),
    path.join(dir, `${id}.ogg`),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p) && fs.statSync(p).size > 2000) return p;
  }
  return null;
}

function ensureBgmPresetFile(presetId) {
  const id = normalizeBgmPreset(presetId);
  if (id === 'nenhuma') return null;

  const asset = findAssetTrack(id);
  if (asset) return asset;

  const filePath = path.join(bgmCacheDir(), `${id}_${BGM_CACHE_VERSION}_loop.wav`);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size < 2000) {
    writeBgmWav(filePath, LOOP_SECONDS, id);
  }
  return filePath;
}

function bgmPresetMeta(value) {
  const id = normalizeBgmPreset(value);
  return BGM_PRESETS.find((p) => p.id === id) || BGM_PRESETS[0];
}

module.exports = {
  BGM_PRESETS,
  DEFAULT_BGM_PRESET,
  DEFAULT_BGM_VOLUME,
  LOOP_SECONDS,
  isBgmPreset,
  normalizeBgmPreset,
  normalizeBgmVolume,
  writeBgmWav,
  ensureBgmPresetFile,
  bgmPresetMeta,
  moodScore,
  findAssetTrack,
  assetsBgmDir,
};
