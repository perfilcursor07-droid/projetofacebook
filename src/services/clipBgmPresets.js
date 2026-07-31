/**
 * Presets de música de fundo para cortes / Reels.
 * Geram WAV procedural (sem dependência de arquivos externos / direitos autorais).
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_BGM_PRESET = 'nenhuma';
const DEFAULT_BGM_VOLUME = 18; // % do áudio de fundo (fala fica por cima)

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

/** Configuração harmônica / ritmo por humor. */
function moodConfig(presetId) {
  switch (normalizeBgmPreset(presetId)) {
    case 'triste':
      return {
        freqs: [65.4, 98, 130.8, 196, 261.6],
        amps: [0.22, 0.18, 0.14, 0.1, 0.07],
        lfoHz: 0.05,
        pulseHz: 0.18,
        beatHz: 0.22,
        beatPow: 10,
        noise: 0.008,
        gain: 0.48,
      };
    case 'alegre':
      return {
        freqs: [261.6, 329.6, 392, 523.3, 659.3, 784],
        amps: [0.14, 0.13, 0.12, 0.1, 0.08, 0.06],
        lfoHz: 0.14,
        pulseHz: 0.7,
        beatHz: 1.4,
        beatPow: 6,
        noise: 0.012,
        gain: 0.5,
      };
    case 'epico':
      return {
        freqs: [55, 82.5, 110, 165, 220, 330, 440],
        amps: [0.22, 0.18, 0.15, 0.12, 0.1, 0.08, 0.05],
        lfoHz: 0.08,
        pulseHz: 0.5,
        beatHz: 0.85,
        beatPow: 8,
        noise: 0.02,
        gain: 0.55,
      };
    case 'suave':
      return {
        freqs: [130.8, 164.8, 196, 246.9, 311.1],
        amps: [0.16, 0.14, 0.12, 0.1, 0.08],
        lfoHz: 0.06,
        pulseHz: 0.25,
        beatHz: 0.35,
        beatPow: 12,
        noise: 0.006,
        gain: 0.42,
      };
    case 'suspense':
      return {
        freqs: [55, 82.5, 110, 165, 220, 330],
        amps: [0.18, 0.16, 0.14, 0.12, 0.11, 0.08],
        lfoHz: 0.09,
        pulseHz: 0.42,
        beatHz: 0.5,
        beatPow: 8,
        noise: 0.015,
        gain: 0.55,
      };
    default:
      return null;
  }
}

/**
 * Gera WAV mono 24kHz do preset (loopável pelo ffmpeg com -stream_loop).
 * @returns {string} caminho absoluto
 */
function writeBgmWav(outputPath, seconds, presetId) {
  const cfg = moodConfig(presetId);
  if (!cfg) {
    throw new Error('Preset de música inválido');
  }

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

  const { freqs, amps, lfoHz, pulseHz, beatHz, beatPow, noise, gain } = cfg;

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const lfo = 0.62 + 0.38 * Math.sin(2 * Math.PI * lfoHz * t);
    const pulse = 0.8 + 0.2 * Math.sin(2 * Math.PI * pulseHz * t);
    const beat = 1 + 0.35 * Math.max(0, Math.sin(2 * Math.PI * beatHz * t)) ** beatPow;
    let sample = 0;
    for (let f = 0; f < freqs.length; f++) {
      sample += amps[f] * Math.sin(2 * Math.PI * freqs[f] * t);
    }
    sample += (Math.random() * 2 - 1) * noise;
    sample *= lfo * pulse * beat * gain;
    buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 30000), 44 + i * blockAlign);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, buffer);
  return outputPath;
}

function bgmPresetMeta(value) {
  const id = normalizeBgmPreset(value);
  return BGM_PRESETS.find((p) => p.id === id) || BGM_PRESETS[0];
}

module.exports = {
  BGM_PRESETS,
  DEFAULT_BGM_PRESET,
  DEFAULT_BGM_VOLUME,
  isBgmPreset,
  normalizeBgmPreset,
  normalizeBgmVolume,
  writeBgmWav,
  bgmPresetMeta,
  moodConfig,
};
