/**
 * ElevenLabs Text-to-Speech — voz humanizada para narração de Reels.
 * Docs: https://elevenlabs.io/docs/api-reference/text-to-speech
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { env } = require('../config/env');

function isConfigured() {
  return Boolean(env.elevenLabsApiKey);
}

function voiceId() {
  return String(env.elevenLabsVoiceId || '21m00Tcm4TlvDq8ikWAM').trim();
}

function modelId() {
  return String(env.elevenLabsModelId || 'eleven_multilingual_v2').trim();
}

/**
 * @param {{ texto: string, outputPath?: string }} opts
 * @returns {Promise<{ buffer: Buffer, outputPath: string|null, chars: number, voiceId: string }>}
 */
async function synthetizar({ texto, outputPath = null } = {}) {
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

  const vid = voiceId();
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(vid)}`;

  const response = await axios.post(
    url,
    {
      text,
      model_id: modelId(),
      voice_settings: {
        stability: 0.45,
        similarity_boost: 0.75,
        style: 0.35,
        use_speaker_boost: true,
      },
    },
    {
      headers: {
        'xi-api-key': env.elevenLabsApiKey,
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
    const err = new Error(`ElevenLabs TTS: ${message}`);
    err.status = response.status === 401 || response.status === 403 ? 503 : 502;
    throw err;
  }

  const buffer = Buffer.from(response.data);
  if (!buffer.length || buffer.length < 500) {
    const err = new Error('ElevenLabs retornou áudio vazio');
    err.status = 502;
    throw err;
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

module.exports = {
  isConfigured,
  synthetizar,
  voiceId,
  modelId,
};
