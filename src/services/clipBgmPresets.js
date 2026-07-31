/**
 * Presets de música de fundo para cortes / Reels.
 * Gera WAV curto (loop) uma vez e reutiliza — mix rápido no ffmpeg.
 */

const fs = require('fs');
const path = require('path');
const { env } = require('../config/env');

const DEFAULT_BGM_PRESET = 'nenhuma';
const DEFAULT_BGM_VOLUME = 18; // % do áudio de fundo
/** Loop curto em cache — o ffmpeg repete até o fim do vídeo. */
const LOOP_SECONDS = 8;
const SAMPLE_RATE = 22050;

const BGM_PRESETS = Object.freeze([
  Object.freeze({
    id: 'nenhuma',
    name: 'Sem música',
    description: 'Só o áudio original do vídeo.',
  }),
  Object.freeze({
    id: 'triste',
    name: 'Triste',
    description: 'Pads lentos e graves — reflexão, luto, testemunho.',
  }),
  Object.freeze({
    id: 'alegre',
    name: 'Alegre',
    description: 'Notas claras e ritmo leve — celebração, vitória.',
  }),
  Object.freeze({
    id: 'epico',
    name: 'Épico',
    description: 'Baixo forte e batida — impacto, revelação.',
  }),
  Object.freeze({
    id: 'suave',
    name: 'Suave',
    description: 'Ambiente calmo — oração, ensino, paz.',
  }),
  Object.freeze({
    id: 'suspense',
    name: 'Suspense',
    description: 'Pulsação tensa — mistério, alerta, cliffhanger.',
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

function moodConfig(presetId) {
  switch (normalizeBgmPreset(presetId)) {
    case 'triste':
      return {
        freqs: [65.4, 98, 130.8, 196],
        amps: [0.24, 0.18, 0.12, 0.08],
        lfoHz: 0.05,
        pulseHz: 0.18,
        beatHz: 0.22,
        beatPow: 10,
        noise: 0.006,
        gain: 0.48,
      };
    case 'alegre':
      return {
        freqs: [261.6, 329.6, 392, 523.3, 659.3],
        amps: [0.14, 0.12, 0.1, 0.08, 0.06],
        lfoHz: 0.14,
        pulseHz: 0.7,
        beatHz: 1.4,
        beatPow: 6,
        noise: 0.01,
        gain: 0.48,
      };
    case 'epico':
      return {
        freqs: [55, 82.5, 110, 165, 220, 330],
        amps: [0.22, 0.16, 0.14, 0.1, 0.08, 0.05],
        lfoHz: 0.08,
        pulseHz: 0.5,
        beatHz: 0.85,
        beatPow: 8,
        noise: 0.015,
        gain: 0.52,
      };
    case 'suave':
      return {
        freqs: [130.8, 164.8, 196, 246.9],
        amps: [0.16, 0.14, 0.1, 0.08],
        lfoHz: 0.06,
        pulseHz: 0.25,
        beatHz: 0.35,
        beatPow: 12,
        noise: 0.005,
        gain: 0.4,
      };
    case 'suspense':
      return {
        freqs: [55, 82.5, 110, 165, 220],
        amps: [0.2, 0.16, 0.12, 0.1, 0.08],
        lfoHz: 0.09,
        pulseHz: 0.42,
        beatHz: 0.5,
        beatPow: 8,
        noise: 0.012,
        gain: 0.52,
      };
    default:
      return null;
  }
}

function bgmCacheDir() {
  const dir = path.resolve(env.storagePath, 'bgm');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Gera WAV curto (loop) — bem rápido (~8s @ 22kHz).
 */
function writeBgmWav(outputPath, seconds, presetId) {
  const cfg = moodConfig(presetId);
  if (!cfg) throw new Error('Preset de música inválido');

  const sampleRate = SAMPLE_RATE;
  const channels = 1;
  const bitsPerSample = 16;
  const numSamples = Math.max(1, Math.ceil(Number(seconds) * sampleRate));
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = numSamples * blockAlign;
  const buffer = Buffer.allocUnsafe(44 + dataSize);

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

  const { freqs, amps, lfoHz, pulseHz, beatHz, beatPow, noise, gain } = cfg;
  const nFreq = freqs.length;
  // Fade curto nas pontas para o loop não estalar.
  const fade = Math.min(sampleRate * 0.08, numSamples / 4);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const lfo = 0.65 + 0.35 * Math.sin(2 * Math.PI * lfoHz * t);
    const pulse = 0.82 + 0.18 * Math.sin(2 * Math.PI * pulseHz * t);
    const beat = 1 + 0.3 * Math.max(0, Math.sin(2 * Math.PI * beatHz * t)) ** beatPow;
    let sample = 0;
    for (let f = 0; f < nFreq; f++) {
      sample += amps[f] * Math.sin(2 * Math.PI * freqs[f] * t);
    }
    sample += (Math.random() * 2 - 1) * noise;
    sample *= lfo * pulse * beat * gain;
    if (i < fade) sample *= i / fade;
    if (i > numSamples - fade) sample *= (numSamples - i) / fade;
    buffer.writeInt16LE((Math.max(-1, Math.min(1, sample)) * 30000) | 0, 44 + i * 2);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, buffer);
  return outputPath;
}

/**
 * Caminho absoluto do WAV em cache do preset (cria na 1ª vez).
 */
function ensureBgmPresetFile(presetId) {
  const id = normalizeBgmPreset(presetId);
  if (id === 'nenhuma') return null;
  const filePath = path.join(bgmCacheDir(), `${id}_loop.wav`);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size < 1000) {
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
  moodConfig,
};
