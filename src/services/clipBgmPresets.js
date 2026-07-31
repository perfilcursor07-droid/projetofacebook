/**
 * Presets de música de fundo — toque sinfônico / cinematico.
 * Cada humor tem harmonia, ritmo e “orquestração” diferentes.
 * Loop curto em cache → apply no vídeo continua rápido.
 */

const fs = require('fs');
const path = require('path');
const { env } = require('../config/env');

const DEFAULT_BGM_PRESET = 'nenhuma';
const DEFAULT_BGM_VOLUME = 15;
const LOOP_SECONDS = 16;
const SAMPLE_RATE = 24000;
/** Bump invalida cache antigo. */
const BGM_CACHE_VERSION = 'v5syn';

const BGM_PRESETS = Object.freeze([
  Object.freeze({
    id: 'nenhuma',
    name: 'Sem música',
    description: 'Só o áudio original do vídeo.',
  }),
  Object.freeze({
    id: 'triste',
    name: 'Triste',
    description: 'Cordas menores lentas — luto, testemunho, emoção.',
  }),
  Object.freeze({
    id: 'alegre',
    name: 'Alegre',
    description: 'Fanfarra clara e ritmada — celebração, vitória.',
  }),
  Object.freeze({
    id: 'epico',
    name: 'Épico',
    description: 'Orquestra heroica com batida — revelação, impacto.',
  }),
  Object.freeze({
    id: 'suave',
    name: 'Suave',
    description: 'Coral/pad ethereal — oração, paz, ensino.',
  }),
  Object.freeze({
    id: 'suspense',
    name: 'Suspense',
    description: 'Drone tenso + ostinato — mistério, alerta, cliffhanger.',
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
 * Partitura por humor — bem diferentes entre si.
 * voice: strings | brass | choir | pulse | drone
 */
function moodScore(presetId) {
  switch (normalizeBgmPreset(presetId)) {
    case 'triste':
      // Adagio em Am — cordas legato, melodia descendente
      return {
        bpm: 52,
        gain: 0.4,
        feel: 'strings',
        bars: 4,
        // Am – Dm – Em – Am
        chords: [
          [57, 60, 64, 69],
          [50, 53, 57, 62],
          [52, 55, 59, 64],
          [45, 57, 60, 64],
        ],
        bass: [33, 38, 40, 33],
        melody: [76, 74, 72, 71, 69, 67, 69, 64, 67, 65, 64, 62, 60, 62, 64, 57],
        melodyEvery: 2, // colcheia longa
        pulse: false,
        drone: null,
        dissonance: false,
      };
    case 'alegre':
      // Allegro em C — brass/clarinete, arpejos rápidos
      return {
        bpm: 112,
        gain: 0.38,
        feel: 'brass',
        bars: 4,
        // C – G – Am – F
        chords: [
          [60, 64, 67],
          [55, 59, 62],
          [57, 60, 64],
          [53, 57, 60],
        ],
        bass: [36, 43, 45, 41],
        melody: [72, 76, 79, 84, 79, 76, 74, 72, 67, 71, 74, 79, 76, 74, 72, 67],
        melodyEvery: 1,
        pulse: true,
        drone: null,
        dissonance: false,
      };
    case 'epico':
      // Maestoso Em — baixo fortíssimo + arpejo heróico
      return {
        bpm: 84,
        gain: 0.44,
        feel: 'brass',
        bars: 4,
        // Em – C – G – D
        chords: [
          [52, 55, 59, 64],
          [48, 52, 55, 60],
          [55, 59, 62, 67],
          [50, 54, 57, 62],
        ],
        bass: [28, 24, 31, 26],
        melody: [71, 67, 64, 71, 74, 76, 74, 71, 67, 64, 67, 71, 74, 71, 67, 59],
        melodyEvery: 1,
        pulse: true,
        drone: null,
        dissonance: false,
      };
    case 'suave':
      // Largo coral — vozes abertas, sem batida
      return {
        bpm: 48,
        gain: 0.34,
        feel: 'choir',
        bars: 4,
        // Cadd9 – Am7 – Fmaj7 – Gsus
        chords: [
          [48, 60, 64, 67, 74],
          [45, 57, 60, 64, 67],
          [41, 53, 57, 60, 64],
          [43, 55, 60, 62, 67],
        ],
        bass: [36, 33, 29, 31],
        melody: [67, 69, 71, 72, 74, 72, 71, 69],
        melodyEvery: 4,
        pulse: false,
        drone: null,
        dissonance: false,
      };
    case 'suspense':
      // Ostinato tenso — drone baixo + 2ª menor / tritono
      return {
        bpm: 68,
        gain: 0.42,
        feel: 'drone',
        bars: 4,
        // Em(addb9) – B7alt – Cdim – Am(addb2)
        chords: [
          [52, 55, 59, 63], // Em + b9 (F)
          [47, 51, 54, 58], // B + dim flavor
          [48, 51, 54, 60], // Cdim-ish
          [45, 48, 52, 56], // Am + b2
        ],
        bass: [28, 28, 28, 28], // pedal E grave
        melody: [71, 70, 71, 67, 66, 67, 64, 63, 64, 59, 58, 59, 55, 54, 55, 52],
        melodyEvery: 1,
        pulse: true,
        drone: 28, // E1 contínuo
        dissonance: true,
      };
    default:
      return null;
  }
}

/** Timbre por “seção” orquestral. */
function voiceOsc(phase, feel, partial = 0) {
  const s1 = Math.sin(phase);
  const s2 = Math.sin(phase * 2);
  const s3 = Math.sin(phase * 3);
  const s4 = Math.sin(phase * 4);
  if (feel === 'strings') {
    // cordas: harmônicos ímpares suaves + vibrato externo
    return s1 * 0.55 + s2 * 0.28 + s3 * 0.12 + s4 * 0.05;
  }
  if (feel === 'brass') {
    return s1 * 0.45 + s2 * 0.3 + s3 * 0.18 + Math.sin(phase * 5) * 0.07;
  }
  if (feel === 'choir') {
    // quase senoidal, “aah”
    return s1 * 0.7 + s2 * 0.2 + s3 * 0.08 + (partial ? Math.sin(phase * 1.01) * 0.08 : 0);
  }
  // drone / suspense: mais áspero, pouca harmonia doce
  return s1 * 0.5 + s2 * 0.15 + Math.sin(phase * 1.5) * 0.12 + s3 * 0.1;
}

function adsr(t, dur, a, d, sLevel, r) {
  if (dur <= 0 || t < 0 || t > dur) return 0;
  const p = t / dur;
  const aN = Math.min(a, dur * 0.35) / dur;
  const dN = Math.min(d, dur * 0.25) / dur;
  const rN = Math.min(r, dur * 0.45) / dur;
  if (p < aN) return p / Math.max(1e-6, aN);
  if (p < aN + dN) return 1 - (1 - sLevel) * ((p - aN) / Math.max(1e-6, dN));
  if (p > 1 - rN) return sLevel * ((1 - p) / Math.max(1e-6, rN));
  return sLevel;
}

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

  const samples = new Float32Array(numSamples);
  const beatSec = 60 / score.bpm;
  const barSec = beatSec * 4;
  const feel = score.feel;

  function addNote(midi, startSec, durSec, amp, opts = {}) {
    const softAtk = opts.legato;
    const a = softAtk ? 0.12 : 0.03;
    const d = softAtk ? 0.2 : 0.08;
    const s = softAtk ? 0.7 : 0.55;
    const r = softAtk ? 0.45 : 0.2;
    const vibHz = opts.vibrato || 0;
    const vibDepth = opts.vibDepth || 0;
    const tremHz = opts.tremolo || 0;
    const f0 = midiToHz(midi);
    const start = Math.max(0, Math.floor(startSec * sampleRate));
    const len = Math.min(numSamples - start, Math.floor(durSec * sampleRate));
    if (len <= 0) return;

    for (let i = 0; i < len; i++) {
      const t = i / sampleRate;
      const env = adsr(t, durSec, a, d, s, r);
      const vib = vibHz ? 1 + vibDepth * Math.sin(2 * Math.PI * vibHz * t) : 1;
      const trem = tremHz ? 0.75 + 0.25 * Math.sin(2 * Math.PI * tremHz * t) : 1;
      const phase = 2 * Math.PI * f0 * vib * t;
      samples[start + i] += voiceOsc(phase, feel) * env * amp * trem;
    }
  }

  const totalBars = Math.ceil(Number(seconds) / barSec) + 1;

  // Drone contínuo (suspense)
  if (score.drone != null) {
    addNote(score.drone, 0, Number(seconds) + 0.5, 0.22, {
      legato: true,
      vibrato: 0.15,
      vibDepth: 0.004,
      tremolo: score.dissonance ? 3.2 : 0,
    });
    // 5ª acima bem baixinha = tensão
    if (score.dissonance) {
      addNote(score.drone + 7, 0, Number(seconds) + 0.5, 0.08, {
        legato: true,
        tremolo: 2.7,
      });
    }
  }

  for (let bar = 0; bar < totalBars; bar++) {
    const chord = score.chords[bar % score.chords.length];
    const bass = score.bass[bar % score.bass.length];
    const barStart = bar * barSec;

    // Contrabaixo / cello
    addNote(bass, barStart, barSec * 0.98, feel === 'choir' ? 0.16 : 0.26, {
      legato: true,
      vibrato: feel === 'strings' ? 4.8 : 0,
      vibDepth: 0.003,
    });

    // Pad de cordas / metal / coral no acorde inteiro
    const chordAmp = feel === 'choir' ? 0.13 : feel === 'strings' ? 0.12 : 0.09;
    for (let n = 0; n < chord.length; n++) {
      addNote(chord[n], barStart + 0.02 * n, barSec * 0.96, chordAmp, {
        legato: true,
        vibrato: feel === 'strings' || feel === 'choir' ? 5.2 : 0,
        vibDepth: 0.0025,
        tremolo: score.dissonance ? 4.5 : 0,
      });
    }

    // Arpejo / ostinato (dá movimento sinfônico)
    if (feel === 'brass' || feel === 'drone' || score.pulse) {
      const step = beatSec / (feel === 'brass' && score.bpm > 100 ? 2 : 1);
      for (let s = 0; s < 8; s++) {
        const note = chord[s % chord.length];
        const oct = feel === 'brass' && s % 4 === 0 ? 12 : 0;
        addNote(note + oct, barStart + s * step, step * 0.85, 0.09, {
          legato: false,
          tremolo: score.dissonance ? 6 : 0,
        });
      }
    } else if (feel === 'strings') {
      // arpejo lento ascendente
      for (let s = 0; s < chord.length; s++) {
        addNote(chord[s] + 12, barStart + s * (barSec / chord.length), barSec / chord.length, 0.1, {
          legato: true,
          vibrato: 5,
          vibDepth: 0.003,
        });
      }
    }

    // Batida suave (só épico/alegre) — click filtrado, não chiado
    if (score.pulse && (feel === 'brass' || feel === 'drone')) {
      for (let b = 0; b < 4; b++) {
        const t0 = barStart + b * beatSec;
        const start = Math.floor(t0 * sampleRate);
        const len = Math.min(numSamples - start, Math.floor(0.04 * sampleRate));
        for (let i = 0; i < len; i++) {
          const env = 1 - i / len;
          const click = Math.sin(2 * Math.PI * (feel === 'drone' ? 55 : 90) * (i / sampleRate));
          samples[start + i] += click * env * env * (feel === 'drone' ? 0.12 : 0.08);
        }
      }
    }

    // Melodia principal
    const step = score.melodyEvery;
    for (let s = 0; s < 8; s += step) {
      const idx = (bar * Math.ceil(8 / step) + s / step) % score.melody.length;
      const midi = score.melody[idx];
      const dur = beatSec * step * (feel === 'choir' ? 1.4 : 0.95);
      addNote(midi, barStart + s * (beatSec / 2), dur, feel === 'drone' ? 0.14 : 0.17, {
        legato: feel !== 'brass',
        vibrato: feel === 'strings' || feel === 'choir' ? 5.5 : feel === 'drone' ? 3 : 0,
        vibDepth: feel === 'drone' ? 0.006 : 0.003,
        tremolo: score.dissonance ? 5.5 : 0,
      });
    }
  }

  // Mix final: fade de loop + soft clip
  const fade = Math.min(sampleRate * 0.2, numSamples / 6);
  const master = score.gain;
  for (let i = 0; i < numSamples; i++) {
    let s = samples[i] * master;
    if (i < fade) s *= i / fade;
    if (i > numSamples - fade) s *= (numSamples - i) / fade;
    s = Math.tanh(s * 1.1);
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
