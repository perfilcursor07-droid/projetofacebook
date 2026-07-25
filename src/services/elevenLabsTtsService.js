/**
 * ElevenLabs Text-to-Speech — voz humanizada para narração de Reels.
 * Docs: https://elevenlabs.io/docs/api-reference/text-to-speech
 *
 * Plano Free: Voice Library NÃO funciona via API.
 * Use vozes de "My Voices" (premade da conta, clone ou Voice Design).
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { env } = require('../config/env');

/** Cache curto das vozes da conta (evita GET a cada reel). */
let voicesCache = { at: 0, list: null };
const VOICES_TTL_MS = 10 * 60 * 1000;

function isConfigured() {
  return Boolean(env.elevenLabsApiKey);
}

function modelId() {
  return String(env.elevenLabsModelId || 'eleven_multilingual_v2').trim();
}

function configuredVoiceId() {
  return String(env.elevenLabsVoiceId || '').trim();
}

function apiHeaders() {
  return {
    'xi-api-key': env.elevenLabsApiKey,
    Accept: 'application/json',
  };
}

/**
 * Lista vozes acessíveis pela API key (My Voices + defaults da conta).
 */
async function listarVozes({ force = false } = {}) {
  if (!isConfigured()) return [];
  if (!force && voicesCache.list && Date.now() - voicesCache.at < VOICES_TTL_MS) {
    return voicesCache.list;
  }

  const response = await axios.get('https://api.elevenlabs.io/v1/voices', {
    headers: apiHeaders(),
    timeout: 30000,
    validateStatus: () => true,
  });

  if (response.status >= 400) {
    const msg =
      response.data?.detail?.message ||
      response.data?.detail ||
      response.data?.message ||
      `HTTP ${response.status}`;
    const err = new Error(`ElevenLabs vozes: ${typeof msg === 'object' ? JSON.stringify(msg) : msg}`);
    err.status = response.status === 401 || response.status === 403 ? 503 : 502;
    throw err;
  }

  const list = Array.isArray(response.data?.voices) ? response.data.voices : [];
  voicesCache = { at: Date.now(), list };
  return list;
}

/**
 * Prioriza vozes usáveis no Free (não Voice Library compartilhada).
 * Ordem: PT-BR → multilingual → cloned/generated → premade → qualquer.
 */
function escolherVozLivre(voices) {
  if (!Array.isArray(voices) || !voices.length) return null;

  const score = (v) => {
    let s = 0;
    const cat = String(v.category || '').toLowerCase();
    const lang = String(v.labels?.language || v.labels?.accent || '').toLowerCase();
    const name = String(v.name || '').toLowerCase();
    const sharing = String(v.sharing?.status || '').toLowerCase();

    // Evita vozes claramente da library compartilhada
    if (sharing === 'copied' || sharing === 'copied_disabled') s -= 50;
    if (cat === 'cloned' || cat === 'generated' || cat === 'professional') s += 40;
    if (cat === 'premade') s += 25;
    if (/pt|brazil|portugu/.test(lang) || /brazil|portugu|br\b/.test(name)) s += 30;
    if (/suspense|dramatic|dark|deep|grave|narrat|news|radio|anchor|mister|thriller/.test(name)) {
      s += 35;
    }
    if (/multilingual|narrative/.test(name)) s += 10;
    return s;
  };

  const ranked = [...voices].sort((a, b) => score(b) - score(a));
  return ranked[0] || null;
}

/**
 * Resolve Voice ID: ELEVENLABS_VOICE_ID ou primeira voz usável da conta.
 */
async function resolverVoiceId({ preferId = null } = {}) {
  const preferred = String(preferId || configuredVoiceId() || '').trim();
  if (preferred) return preferred;

  const voices = await listarVozes();
  const pick = escolherVozLivre(voices);
  if (pick?.voice_id) return String(pick.voice_id);

  const err = new Error(
    'Nenhuma voz disponível na sua conta ElevenLabs. No plano Free, abra My Voices ' +
      '(https://elevenlabs.io/app/voice-lab), crie/use uma voz própria e defina ELEVENLABS_VOICE_ID no .env. ' +
      'Vozes da Voice Library não funcionam na API no Free.'
  );
  err.status = 503;
  throw err;
}

function isLibraryVoiceError(message) {
  const m = String(message || '').toLowerCase();
  return (
    m.includes('library voices') ||
    m.includes('voice library') ||
    m.includes('upgrade your subscription to use this voice') ||
    m.includes('not available for free users')
  );
}

function mensagemErroAmigavel(raw) {
  const message = String(raw || '');
  if (isLibraryVoiceError(message)) {
    return (
      'Plano Free da ElevenLabs não usa vozes da Voice Library na API. ' +
      'Em https://elevenlabs.io/app/voice-lab escolha uma voz em My Voices, copie o Voice ID e coloque ' +
      'ELEVENLABS_VOICE_ID=... no .env (ou deixe em branco para o app escolher uma da conta).'
    );
  }
  return message;
}

/** Config de voz: suspense = mais variação / estilo dramático (Reels gospel/notícia). */
const VOICE_PRESETS = {
  suspense: {
    stability: 0.28,
    similarity_boost: 0.82,
    style: 0.72,
    use_speaker_boost: true,
  },
  natural: {
    stability: 0.45,
    similarity_boost: 0.75,
    style: 0.35,
    use_speaker_boost: true,
  },
};

async function ttsRequest(vid, text, { estilo = 'suspense' } = {}) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(vid)}`;
  const voice_settings = VOICE_PRESETS[estilo] || VOICE_PRESETS.suspense;
  const response = await axios.post(
    url,
    {
      text,
      model_id: modelId(),
      voice_settings,
    },
    {
      headers: {
        ...apiHeaders(),
        Accept: 'audio/mpeg',
        'Content-Type': 'application/json',
      },
      responseType: 'arraybuffer',
      timeout: 120000,
      validateStatus: () => true,
    }
  );

  if (response.status >= 400) {
    let message = `HTTP ${response.status}`;
    try {
      const json = JSON.parse(Buffer.from(response.data).toString('utf8'));
      message = json?.detail?.message || json?.message || json?.detail || message;
      if (typeof message === 'object') message = JSON.stringify(message);
    } catch {
      /* binary error body */
    }
    const err = new Error(String(message));
    err.status = response.status;
    err.httpStatus = response.status;
    throw err;
  }

  const buffer = Buffer.from(response.data);
  if (!buffer.length || buffer.length < 500) {
    const err = new Error('ElevenLabs retornou áudio vazio');
    err.status = 502;
    throw err;
  }
  return buffer;
}

/**
 * @param {{ texto: string, outputPath?: string }} opts
 * @returns {Promise<{ buffer: Buffer, outputPath: string|null, chars: number, voiceId: string }>}
 */
async function synthetizar({ texto, outputPath = null, estilo = 'suspense' } = {}) {
  if (!isConfigured()) {
    const err = new Error(
      'ELEVENLABS_API_KEY não configurada. Crie em https://elevenlabs.io e adicione no .env'
    );
    err.status = 503;
    throw err;
  }

  const text = String(texto || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length < 20) {
    const err = new Error('Texto muito curto para narrar (mín. ~20 caracteres)');
    err.status = 400;
    throw err;
  }
  if (text.length > 4000) {
    const err = new Error('Texto muito longo para narrar (máx. 4000 caracteres nesta etapa)');
    err.status = 400;
    throw err;
  }

  let vid = await resolverVoiceId();
  let buffer;

  try {
    buffer = await ttsRequest(vid, text, { estilo });
  } catch (firstErr) {
    // Free + Voice Library: tenta outra voz da conta automaticamente
    if (isLibraryVoiceError(firstErr.message)) {
      const voices = await listarVozes({ force: true });
      const alternativas = voices
        .map((v) => v.voice_id)
        .filter((id) => id && id !== vid);
      const pick = escolherVozLivre(voices.filter((v) => v.voice_id !== vid));
      const tryIds = [pick?.voice_id, ...alternativas].filter(Boolean);
      const unique = [...new Set(tryIds)];

      let last = firstErr;
      for (const alt of unique.slice(0, 5)) {
        try {
          buffer = await ttsRequest(alt, text, { estilo });
          vid = alt;
          last = null;
          break;
        } catch (err) {
          last = err;
          if (!isLibraryVoiceError(err.message)) break;
        }
      }
      if (last) {
        const err = new Error(`ElevenLabs TTS: ${mensagemErroAmigavel(last.message)}`);
        err.status = last.httpStatus === 401 || last.httpStatus === 403 ? 503 : 402;
        throw err;
      }
    } else {
      const err = new Error(`ElevenLabs TTS: ${mensagemErroAmigavel(firstErr.message)}`);
      err.status =
        firstErr.httpStatus === 401 || firstErr.httpStatus === 403
          ? 503
          : firstErr.httpStatus === 402
            ? 402
            : 502;
      throw err;
    }
  }

  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, buffer);
  }

  return {
    buffer,
    outputPath: outputPath || null,
    chars: text.length,
    voiceId: vid,
  };
}

/** Compat: ID configurado ou string vazia (resolução lazy em synthetizar). */
function voiceId() {
  return configuredVoiceId() || '(auto My Voices)';
}

module.exports = {
  isConfigured,
  synthetizar,
  voiceId,
  modelId,
  listarVozes,
  resolverVoiceId,
};
