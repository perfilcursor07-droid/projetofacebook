/**
 * Presets de música de fundo para cortes / Reels.
 * Sequenciador simples (acordes + melodia + envelope) — soa como trilha, não chiado.
 * Loop curto em cache; o ffmpeg só remixa o áudio (rápido).
 */

const fs = require('fs');
const path = require('path');
const { env } = require('../config/env');

const DEFAULT_BGM_PRESET = 'nenhuma';
const DEFAULT_BGM_VOLUME = 16;
/** Loop em cache — o ffmpeg repete até o fim do vídeo. */
const LOOP_SECONDS = 12;
const SAMPLE_RATE = 22050;
/** Bump quando mudar o gerador — invalida cache antigo. */
const BGM_CACHE_VERSION = 'v3';

const BGM_PRESETS = Object.freeze([
  Object.freeze({
    id: 'nenhuma',
    name: 'Sem música',
    description: 'Só o áudio original do vídeo.',
  }),
  Object.freeze({
    id: 'triste',
    name: 'Triste',
    description: 'Piano menor lento — reflexão, luto, testemunho.',
  }),
  Object.freeze({
    id: 'alegre',
    name: 'Alegre',
    description: 'Acordes maiores claros — celebração, vitória.',
  }),
  Object.freeze({
    id: 'epico',
    name: 'Épico',
    description: 'Baixo + arpejo forte — impacto, revelação.',
  }),
  Object.freeze({
    id: 'suave',
    name: 'Suave',
    description: 'Pads calmos — oração, ensino, paz.',
  }),
  Object.freeze({
    id: 'suspense',
    name: 'Suspense',
    description: 'Intervalos tensos — mistério, alerta.',
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

/**
 * Progressão + melodia por humor (MIDI).
 * bpm baixo = triste/suave; mais alto = alegre/épico.
 */
function moodScore(presetId) {
  switch (normalizeBgmPreset(presetId)) {
    case 'triste':
      // Am – F – C – G (menor lento)
      return {
        bpm: 58,
        gain: 0.42,
        chords: [
          [57, 60, 64], // Am
          [53, 57, 60], // F
          [48, 52, 55], // C
          [55, 59, 62], // G
        ],
        melody: [76, 74, 72, 71, 69, 71, 72, 69],
        bassRoot: [45, 41, 36, 43],
        padSoft: true,
      };
    case 'alegre':
      // C – G – Am – F
      return {
        bpm: 104,
        gain: 0.4,
        chords: [
          [60, 64, 67],
          [55, 59, 62],
          [57, 60, 64],
          [53, 57, 60],
        ],
        melody: [72, 74, 76, 79, 76, 74, 72, 67],
        bassRoot: [36, 43, 45, 41],
        padSoft: false,
      };
    case 'epico':
      // Em – C – G – D
      return {
        bpm: 88,
        gain: 0.44,
        chords: [
          [52, 55, 59],
          [48, 52, 55],
          [55, 59, 62],
          [50, 54, 57],
        ],
        melody: [71, 67, 64, 67, 71, 74, 71, 67],
        bassRoot: [40, 36, 43, 38],
        padSoft: false,
      };
    case 'suave':
      // C – Am – F – G (mais aberto)
      return {
        bpm: 66,
        gain: 0.36,
        chords: [
          [60, 64, 67],
          [57, 60, 64],
          [53, 57, 60],
          [55, 59, 62],
        ],
        melody: [67, 69, 71, 72, 71, 69, 67, 64],
        bassRoot: [36, 33, 29, 31],
        padSoft: true,
      };
    case 'suspense':
      // Em – B – C – Am (tensão)
      return {
        bpm: 72,
        gain: 0.4,
        chords: [
          [52, 55, 59],
          [47, 51, 54],
          [48, 52, 55],
          [45, 48, 52],
        ],
        melody: [71, 70, 71, 67, 66, 67, 64, 59],
        bassRoot: [40, 35, 36, 33],
        padSoft: true,
      };
    default:
      return null;
  }
}

function softOsc(phase, soft) {
  // seno + leve 2ª harmônica (mais “piano/pad”, sem ser chiado)
  const s = Math.sin(phase);
  if (soft) return s * 0.85 + Math.sin(phase * 2) * 0.12;
  return s * 0.75 + Math.sin(phase * 2) * 0.18 + Math.sin(phase * 3) * 0.05;
}

function adsr(pos, dur, a = 0.04, d = 0.12, sLevel = 0.65, r = 0.22) {
  if (dur <= 0) return 0;
  const t = pos / dur;
  if (t < 0 || t > 1) return 0;
  const aN = Math.min(a, dur * 0.3) / dur;
  const dN = Math.min(d, dur * 0.3) / dur;
  const rN = Math.min(r, dur * 0.4) / dur;
  if (t < aN) return t / aN;
  if (t < aN + dN) return 1 - (1 - sLevel) * ((t - aN) / dN);
  if (t > 1 - rN) return sLevel * ((1 - t) / rN);
  return sLevel;
}

/**
 * Renderiza loop musical (acordes arpejados + baixo + melodia).
 */
function writeBgmWav(outputPath, seconds, presetId) {
  const score = moodScore(presetId);
  if (!score) throw new Error('Preset de música inválido');

  const sampleRate = SAMPLE_RATE;
  const numSamples = Math.max(1, Math.ceil(Number(seconds) * sampleRate));
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

  const beatSec = 60 / score.bpm;
  const barSec = beatSec * 4; // 4/4
  const samples = new Float32Array(numSamples);

  // Preenche amostras somando eventos (mais limpo que seno contínuo).
  function addNote(midi, startSec, durSec, amp, soft) {
    const f = midiToHz(midi);
    const start = Math.max(0, Math.floor(startSec * sampleRate));
    const len = Math.min(numSamples - start, Math.floor(durSec * sampleRate));
    if (len <= 0) return;
    for (let i = 0; i < len; i++) {
      const env = adsr(i / sampleRate, durSec, soft ? 0.08 : 0.03, soft ? 0.18 : 0.1, soft ? 0.55 : 0.7, soft ? 0.35 : 0.18);
      const phase = 2 * Math.PI * f * (i / sampleRate);
      samples[start + i] += softOsc(phase, soft) * env * amp;
    }
  }

  const totalBars = Math.ceil(Number(seconds) / barSec) + 1;
  for (let bar = 0; bar < totalBars; bar++) {
    const chord = score.chords[bar % score.chords.length];
    const bass = score.bassRoot[bar % score.bassRoot.length];
    const barStart = bar * barSec;

    // Baixo (semibreve suave)
    addNote(bass, barStart, barSec * 0.95, 0.28, true);

    // Acorde: notas longas (pad) + arpejo leve
    for (let n = 0; n < chord.length; n++) {
      addNote(chord[n], barStart, barSec * 0.92, score.padSoft ? 0.14 : 0.11, true);
      addNote(chord[n], barStart + n * (beatSec * 0.5), beatSec * 0.85, 0.1, score.padSoft);
    }

    // Melodia: 2 notas por compasso (ou 4 se mais rápido)
    const melStep = score.bpm >= 90 ? 2 : 4;
    for (let s = 0; s < 8; s += melStep) {
      const midi = score.melody[(bar * 2 + s / melStep) % score.melody.length];
      addNote(midi, barStart + s * (beatSec / 2), beatSec * (melStep === 2 ? 0.7 : 1.2), 0.16, score.padSoft);
    }
  }

  // Fade de loop + ganho master (sem noise = sem chiado)
  const fade = Math.min(sampleRate * 0.12, numSamples / 5);
  const master = score.gain;
  for (let i = 0; i < numSamples; i++) {
    let s = samples[i] * master;
    if (i < fade) s *= i / fade;
    if (i > numSamples - fade) s *= (numSamples - i) / fade;
    // soft clip
    s = Math.tanh(s * 1.15);
    buffer.writeInt16LE((Math.max(-1, Math.min(1, s)) * 30000) | 0, 44 + i * 2);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, buffer);
  return outputPath;
}

function bgmCacheDir() {
  const dir = path.resolve(env.storagePath, 'bgm');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Caminho absoluto do WAV em cache do preset (cria na 1ª vez).
 */
function ensureBgmPresetFile(presetId) {
  const id = normalizeBgmPreset(presetId);
  if (id === 'nenhuma') return null;
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
};
