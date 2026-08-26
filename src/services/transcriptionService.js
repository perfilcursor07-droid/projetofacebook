const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const youtubedlExec = require('youtube-dl-exec');
const { runYtDlp, detectPlatformFromUrl } = require('./ytDlpAuth');
const { env } = require('../config/env');
const { extractAudioWav } = require('./ffmpegService');
const { storageAbsolutePath } = require('./downloadService');

const SCRIPT_PATH = path.resolve(__dirname, '../../scripts/transcribe.py');
const YOUTUBE_PO_TOKEN_SCRIPT = path.resolve(
  __dirname,
  '../../scripts/youtube-po-token.mjs'
);
const YOUTUBE_CAPTION_TRACK_SCRIPT = path.resolve(
  __dirname,
  '../../scripts/youtube-caption-track.mjs'
);
const MAX_URL_AUDIO_BYTES = 300 * 1024 * 1024;
const MAX_URL_DURATION_SECONDS = 45 * 60;
const LIMITES = env.transcricao;
const youtubePoTokenCache = new Map();
const youtubePoTokenPending = new Map();

function erroDeTempo(mensagem) {
  const err = new Error(mensagem);
  err.status = 504;
  err.timedOut = true;
  return err;
}

/** Corta qualquer etapa que passe do tempo, em vez de deixar o chat pendurado. */
function comLimiteDeTempo(promise, ms, mensagem) {
  if (!Number(ms) || Number(ms) <= 0) return promise;
  let timer = null;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(erroDeTempo(mensagem)), Number(ms));
    }),
  ]);
}

/**
 * Whisper "small" na CPU consome o servidor inteiro. Vários pedidos ao mesmo
 * tempo (o editor reenviando o link) faziam todos rastejarem sem nunca acabar.
 * A fila garante que só `concorrencia` transcrições rodem de fato.
 */
const filaWhisper = { ativos: 0, espera: [] };

function liberarVaga() {
  filaWhisper.ativos -= 1;
  const proximo = filaWhisper.espera.shift();
  if (proximo) {
    filaWhisper.ativos += 1;
    proximo.resolve();
  }
}

function pegarVaga() {
  if (filaWhisper.ativos < LIMITES.concorrencia) {
    filaWhisper.ativos += 1;
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const item = { resolve: null };
    const timer = setTimeout(() => {
      const i = filaWhisper.espera.indexOf(item);
      if (i >= 0) filaWhisper.espera.splice(i, 1);
      reject(
        erroDeTempo('A fila de transcrição está cheia. Tente de novo em alguns minutos.')
      );
    }, LIMITES.filaMs);

    item.resolve = () => {
      clearTimeout(timer);
      resolve();
    };
    filaWhisper.espera.push(item);
    console.info(
      `[transcricao] aguardando vaga no Whisper (ativos=${filaWhisper.ativos}, fila=${filaWhisper.espera.length})`
    );
  });
}

async function comVagaNoWhisper(tarefa) {
  await pegarVaga();
  try {
    return await tarefa();
  } finally {
    liberarVaga();
  }
}

function ytDlpExecutable() {
  const configured = String(process.env.YTDLP_PATH || '').trim();
  if (configured && fs.existsSync(configured)) return youtubedlExec.create(configured);

  for (const candidate of ['/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp']) {
    if (fs.existsSync(candidate)) return youtubedlExec.create(candidate);
  }
  return youtubedlExec;
}

function runYtDlpForUrl(url, flags, authOpts = {}) {
  return runYtDlp(ytDlpExecutable(), url, flags, authOpts).catch(async (error) => {
    if (authOpts.noCookies || !/instagram\.com/i.test(String(url || ''))) throw error;

    // Uma sessão expirada pode bloquear até posts públicos. Repete sem cookies
    // antes de concluir que o Instagram não disponibilizou a mídia.
    try {
      return await runYtDlp(ytDlpExecutable(), url, flags, {
        platform: 'instagram',
        noCookies: true,
        timeoutMs: authOpts.timeoutMs,
      });
    } catch (publicError) {
      throw publicError || error;
    }
  });
}

function cleanVttText(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseVttTimestamp(value) {
  const parts = String(value || '').trim().replace(',', '.').split(':');
  if (parts.length < 2 || parts.length > 3) return NaN;
  const seconds = Number(parts.pop());
  const minutes = Number(parts.pop());
  const hours = parts.length ? Number(parts.pop()) : 0;
  if (![hours, minutes, seconds].every(Number.isFinite)) return NaN;
  return hours * 3600 + minutes * 60 + seconds;
}

function normalizeCaptionWord(value) {
  return String(value || '')
    .toLocaleLowerCase('pt-BR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function captionWords(value) {
  return String(value || '')
    .split(/\s+/)
    .map((word) => ({ raw: word, norm: normalizeCaptionWord(word) }))
    .filter((word) => word.norm);
}

/**
 * YouTube auto-captions often emit sliding windows:
 * "A B C", then "A B C D E", then "D E".
 * Build a readable transcript by appending only the non-overlapping suffix.
 */
function mergeCaptionSegments(segments) {
  const words = [];

  for (const segment of segments || []) {
    const next = captionWords(segment.text);
    if (!next.length) continue;

    const maxOverlap = Math.min(words.length, next.length, 40);
    let overlap = 0;
    for (let size = maxOverlap; size > 0; size -= 1) {
      let ok = true;
      for (let i = 0; i < size; i += 1) {
        if (words[words.length - size + i].norm !== next[i].norm) {
          ok = false;
          break;
        }
      }
      if (ok) {
        overlap = size;
        break;
      }
    }

    // If the whole caption is already the current suffix, skip it.
    if (overlap === next.length) continue;
    words.push(...next.slice(overlap));
  }

  return words
    .map((word) => word.raw)
    .join(' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseVtt(content) {
  const normalized = String(content || '')
    .replace(/\ufeff/g, '')
    .replace(/\r\n?/g, '\n');
  const segments = [];

  for (const block of normalized.split(/\n{2,}/)) {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex < 0) continue;

    const [startRaw, endPart] = lines[timingIndex].split('-->');
    const start = parseVttTimestamp(startRaw);
    const end = parseVttTimestamp(String(endPart || '').trim().split(/\s+/)[0]);
    const text = cleanVttText(lines.slice(timingIndex + 1).join(' '));
    if (!text || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;

    const previous = segments[segments.length - 1];
    if (previous && previous.text === text) {
      previous.end = Math.max(previous.end, end);
      continue;
    }
    segments.push({ start, end, text });
  }

  const text = mergeCaptionSegments(segments);

  return { text, segments };
}

/**
 * Tenta obter a transcrição manual/automática do link via yt-dlp (sem baixar vídeo).
 */
async function trySubtitlesFromUrl(url) {
  if (!url || !/^https?:\/\//i.test(url)) return null;

  // mkdtemp em vez de Date.now(): dois pedidos no mesmo milissegundo dividiam a
  // mesma pasta e um apagava os .vtt do outro no finally.
  const tmpRoot = path.resolve(env.storagePath, 'tmp');
  fs.mkdirSync(tmpRoot, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'subs_'));
  const outTemplate = path.join(tmpDir, 'subs');
  const isYouTube = /(?:youtube\.com|youtu\.be)/i.test(url);
  const commonFlags = {
    skipDownload: true,
    writeSub: true,
    writeAutoSub: true,
    // pt-orig é a transcrição automática no idioma original.
    subLangs: 'pt-orig,pt-BR,pt,pt-PT,en-orig,en',
    subFormat: 'vtt',
    output: outTemplate,
    noWarnings: true,
    noPlaylist: true,
  };
  const attempts = isYouTube
    ? [
        {
          // O cliente público android_vr expõe a mesma faixa de “Mostrar
          // transcrição” mesmo quando o cliente padrão retorna
          // automatic_captions vazio no servidor.
          source: 'youtube-public-transcript',
          flags: {
            ...commonFlags,
            writeSub: false,
            // Primeiro peça somente a faixa original. Misturar pt-orig com
            // traduções faz o YouTube abortar a operação inteira em alguns
            // vídeos, apesar de a transcrição original estar disponível.
            subLangs: 'pt-orig',
            extractorArgs: 'youtube:player_client=android_vr;skip=translated_subs',
          },
          auth: {
            platform: 'youtube',
            noCookies: true,
            timeoutMs: LIMITES.legendasMs,
          },
        },
        {
          // Vídeos restritos ainda podem precisar dos cookies configurados.
          source: 'yt-dlp-subtitles',
          flags: commonFlags,
          auth: { platform: 'youtube', timeoutMs: LIMITES.legendasMs },
        },
      ]
    : [
        {
          source: 'yt-dlp-subtitles',
          flags: commonFlags,
          auth: { timeoutMs: LIMITES.legendasMs },
        },
      ];

  try {
    for (const attempt of attempts) {
      for (const oldFile of fs.readdirSync(tmpDir)) {
        try {
          fs.rmSync(path.join(tmpDir, oldFile), { force: true });
        } catch {
          // ignore
        }
      }

      try {
        await runYtDlpForUrl(url, attempt.flags, attempt.auth);
      } catch {
        // O yt-dlp pode salvar pt-orig e depois falhar em outra língua (429).
        // O arquivo já obtido continua válido e deve ser aproveitado.
      }

      const files = fs.readdirSync(tmpDir).filter((file) => file.endsWith('.vtt'));
      if (!files.length) continue;

      files.sort((a, b) => {
        const score = (name) =>
          /pt-?br/i.test(name) ? 0 : /pt/i.test(name) ? 1 : /en/i.test(name) ? 2 : 3;
        return score(a) - score(b);
      });

      const raw = fs.readFileSync(path.join(tmpDir, files[0]), 'utf8');
      const parsed = parseVtt(raw);
      if (!parsed.text || parsed.text.length < 20) continue;
      return {
        ...parsed,
        source: attempt.source,
        language: files[0].includes('.en') ? 'en' : 'pt',
      };
    }

    return null;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

async function inspectUrlMedia(url, authOpts = {}) {
  try {
    return await runYtDlpForUrl(url, {
      dumpSingleJson: true,
      skipDownload: true,
      noPlaylist: true,
      noWarnings: true,
    }, { timeoutMs: LIMITES.inspecaoMs, ...authOpts });
  } catch {
    return null;
  }
}

function captionTrackFromInfo(info) {
  const sources = [
    { tracks: info?.subtitles, source: 'youtube-subtitles-url' },
    { tracks: info?.automatic_captions, source: 'youtube-auto-captions-url' },
  ];
  const languages = ['pt-orig', 'pt-BR', 'pt', 'pt-PT', 'en-orig', 'en'];

  for (const language of languages) {
    for (const source of sources) {
      const entries = Array.isArray(source.tracks?.[language])
        ? source.tracks[language]
        : [];
      const entry = entries.find((item) => item?.ext === 'vtt' && item?.url);
      if (entry) return { ...entry, language, source: source.source };
    }
  }
  return null;
}

function parseDirectSubtitlePayload(payload) {
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload || '');
  const timed = parseVtt(raw);
  if (timed.text && timed.text.length >= 20) return timed;

  const candidates = [];
  const visit = (value, depth = 0) => {
    if (!value || depth > 6) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value !== 'object') return;
    const text = cleanVttText(value.text || value.caption || value.utf8 || value.content || '');
    if (text) {
      const start = Number(value.start ?? value.start_time ?? value.startTime ?? value.tStartMs ?? 0);
      const end = Number(value.end ?? value.end_time ?? value.endTime ?? value.dDurationMs ?? start + 1);
      candidates.push({ start, end, text });
    }
    for (const child of Object.values(value)) visit(child, depth + 1);
  };
  try {
    visit(typeof payload === 'string' ? JSON.parse(payload) : payload);
  } catch {
    return { text: '', segments: [] };
  }
  const text = mergeCaptionSegments(candidates);
  return { text, segments: candidates };
}

async function tryDirectPlatformSubtitles(subtitleUrl, platform = '') {
  if (!/^https?:\/\//i.test(String(subtitleUrl || ''))) return null;
  let parsedUrl;
  try {
    parsedUrl = new URL(subtitleUrl);
  } catch {
    return null;
  }
  const host = parsedUrl.hostname.toLowerCase();
  if (
    platform === 'instagram' &&
    !/(?:instagram\.com|cdninstagram\.com|fbcdn\.net|fbsbx\.com|facebook\.com)$/i.test(host)
  ) {
    return null;
  }
  try {
    const response = await axios.get(parsedUrl.toString(), {
      timeout: Math.min(LIMITES.legendasMs, 25_000),
      responseType: 'text',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/131 Mobile Safari/537.36',
        Accept: 'text/vtt,text/plain,application/json,application/xml;q=0.9,*/*;q=0.5',
      },
    });
    const parsed = parseDirectSubtitlePayload(response.data);
    if (!parsed.text || parsed.text.length < 20) return null;
    return { ...parsed, source: `${platform || 'social'}-platform-subtitles` };
  } catch (error) {
    console.warn(
      `[transcricao] legenda direta do ${platform || 'vídeo'} falhou:`,
      error.response?.status || error.message
    );
    return null;
  }
}

/**
 * Lê `captionTracks` do ytInitialPlayerResponse presente no HTML da página.
 * É mais rápido que executar yt-dlp e funciona como uma terceira rota para
 * vídeos cuja transcrição aparece no player, mas não nos metadados do servidor.
 */
function extractCaptionTracksFromWatchHtml(html) {
  const source = String(html || '');
  const marker = '"captionTracks":';
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) return [];
  const start = source.indexOf('[', markerIndex + marker.length);
  if (start < 0) return [];

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '[') depth += 1;
    if (char !== ']') continue;
    depth -= 1;
    if (depth !== 0) continue;
    try {
      const tracks = JSON.parse(source.slice(start, index + 1));
      return Array.isArray(tracks) ? tracks : [];
    } catch {
      return [];
    }
  }
  return [];
}

function chooseCaptionTrack(tracks) {
  const lista = (Array.isArray(tracks) ? tracks : []).filter(
    (track) => track?.baseUrl && track?.languageCode
  );
  const prioridades = ['pt-BR', 'pt', 'pt-PT', 'en-US', 'en'];
  for (const language of prioridades) {
    const track = lista.find((item) => String(item.languageCode) === language);
    if (track) return track;
  }
  return lista[0] || null;
}

function captionUrlNeedsPoToken(value) {
  try {
    const parsed = value instanceof URL ? value : new URL(value);
    return parsed.searchParams
      .getAll('exp')
      .some((entry) => /(?:^|,)(?:xpe|xpv)(?:,|$)/i.test(String(entry)));
  } catch {
    return false;
  }
}

function buildYouTubeCaptionUrl(baseUrl, { poToken = null, client = 'WEB' } = {}) {
  const parsed = baseUrl instanceof URL ? new URL(baseUrl.toString()) : new URL(baseUrl);
  if (!/(^|\.)youtube\.com$/i.test(parsed.hostname)) {
    throw new Error('A URL da legenda não pertence ao YouTube');
  }
  parsed.searchParams.set('fmt', 'vtt');
  parsed.searchParams.delete('xosf');
  if (poToken) {
    // Desde 2026 as faixas com exp=xpe/xpv exigem os três parâmetros.
    // Enviar apenas `pot` responde HTTP 200 com corpo vazio.
    parsed.searchParams.set('pot', poToken);
    parsed.searchParams.set('potc', '1');
    parsed.searchParams.set('c', client);
  }
  return parsed.toString();
}

function childProcessNetworkEnv() {
  const allowed = [
    'PATH',
    'Path',
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'NODE_EXTRA_CA_CERTS',
  ];
  const clean = { NODE_ENV: 'production' };
  for (const key of allowed) {
    if (process.env[key]) clean[key] = process.env[key];
  }
  return clean;
}

function getYouTubeCookieHeader() {
  try {
    const { getYtDlpAuthFlags } = require('./ytDlpAuth');
    const file = getYtDlpAuthFlags({ platform: 'youtube' })?.cookies;
    if (!file || !fs.existsSync(file)) return '';
    const now = Math.floor(Date.now() / 1000);
    const values = new Map();
    for (const rawLine of fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n')) {
      let line = rawLine;
      if (line.startsWith('#HttpOnly_')) line = line.slice('#HttpOnly_'.length);
      else if (!line.trim() || line.trimStart().startsWith('#')) continue;
      const parts = line.split('\t');
      if (parts.length < 7) continue;
      const domain = String(parts[0] || '').toLowerCase();
      const expires = Number(parts[4]) || 0;
      const name = String(parts[5] || '').trim();
      const value = String(parts.slice(6).join('\t') || '').trim();
      if (!domain.includes('youtube.com') || !name || !value) continue;
      if (expires > 0 && expires < now) continue;
      values.set(name, value);
    }
    return [...values].map(([name, value]) => `${name}=${value}`).join('; ');
  } catch (error) {
    console.warn('[transcricao] cookies do YouTube indisponíveis:', error.message);
    return '';
  }
}

function generateYouTubePoToken(videoId, cookieHeader = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [YOUTUBE_PO_TOKEN_SCRIPT, videoId], {
      windowsHide: true,
      env: childProcessNetworkEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end(String(cookieHeader || ''));
    let stdout = '';
    let stderr = '';
    let finished = false;
    const done = (fn, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      done(reject, erroDeTempo('O YouTube demorou para autorizar a leitura da legenda.'));
    }, Math.min(Math.max(Number(LIMITES.legendasMs) || 20_000, 15_000), 30_000));

    child.stdout.on('data', (chunk) => {
      if (stdout.length < 100_000) stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 4_000) stderr += chunk.toString();
    });
    child.on('error', (error) => done(reject, error));
    child.on('close', (code) => {
      if (finished) return;
      try {
        const parsed = JSON.parse(stdout.trim() || '{}');
        if (code !== 0 || !parsed.poToken) {
          throw new Error(stderr.trim() || `Gerador de PO Token terminou com código ${code}`);
        }
        done(resolve, parsed);
      } catch (error) {
        done(reject, error);
      }
    });
  });
}

async function getYouTubePoToken(videoId, cookieHeader = '') {
  const id = String(videoId || '').trim();
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(id)) {
    throw new Error('Não foi possível identificar o vídeo para autorizar a legenda.');
  }
  const sessionKey = cookieHeader
    ? crypto.createHash('sha256').update(cookieHeader).digest('hex').slice(0, 16)
    : 'anon';
  const cacheKey = `${id}:${sessionKey}`;
  const cached = youtubePoTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.poToken;
  if (youtubePoTokenPending.has(cacheKey)) return youtubePoTokenPending.get(cacheKey);

  const pending = generateYouTubePoToken(id, cookieHeader)
    .then((result) => {
      // Tokens de legenda são vinculados ao ID do vídeo. Mantemos um cache
      // curto para pedidos repetidos da mesma conversa.
      const ttlMs = Math.min(
        Math.max(Number(result.expiresIn) || 3600, 300) * 1000,
        6 * 60 * 60 * 1000
      );
      youtubePoTokenCache.set(cacheKey, {
        poToken: result.poToken,
        expiresAt: Date.now() + ttlMs,
      });
      return result.poToken;
    })
    .finally(() => youtubePoTokenPending.delete(cacheKey));
  youtubePoTokenPending.set(cacheKey, pending);
  return pending;
}

function getYouTubeCaptionTrackFromInnerTube(videoId, cookieHeader = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [YOUTUBE_CAPTION_TRACK_SCRIPT, videoId], {
      windowsHide: true,
      env: childProcessNetworkEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end(String(cookieHeader || ''));
    let stdout = '';
    let stderr = '';
    let finished = false;
    const done = (fn, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      done(reject, erroDeTempo('O InnerTube demorou para localizar a legenda.'));
    }, Math.min(Math.max(Number(LIMITES.legendasMs) || 20_000, 12_000), 25_000));

    child.stdout.on('data', (chunk) => {
      if (stdout.length < 100_000) stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 4_000) stderr += chunk.toString();
    });
    child.on('error', (error) => done(reject, error));
    child.on('close', (code) => {
      if (finished) return;
      try {
        const parsed = JSON.parse(stdout.trim() || '{}');
        if (code !== 0 || !parsed.baseUrl) {
          throw new Error(stderr.trim() || `InnerTube terminou com código ${code}`);
        }
        done(resolve, parsed);
      } catch (error) {
        done(reject, error);
      }
    });
  });
}

async function downloadYouTubeCaption(baseUrl, videoId, cookieHeader = '') {
  const needsToken = captionUrlNeedsPoToken(baseUrl);
  let poToken = null;
  if (needsToken) poToken = await getYouTubePoToken(videoId, cookieHeader);

  const request = async () => {
    const response = await axios.get(buildYouTubeCaptionUrl(baseUrl, { poToken }), {
      responseType: 'text',
      timeout: Math.min(LIMITES.legendasMs, 25_000),
      headers: {
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.7',
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
    });
    return parseVtt(response.data);
  };

  let parsed = await request();
  // Algumas contas recebem a exigência antes de `exp=xpe` aparecer na URL.
  if ((!parsed.text || parsed.text.length < 20) && !poToken) {
    poToken = await getYouTubePoToken(videoId);
    parsed = await request();
  }
  return parsed;
}

function extractYouTubeVideoId(value) {
  try {
    const parsed = new URL(value);
    if (/youtu\.be$/i.test(parsed.hostname)) {
      return parsed.pathname.split('/').filter(Boolean)[0] || null;
    }
    return (
      parsed.searchParams.get('v') ||
      parsed.pathname.match(/\/(?:shorts|embed|live)\/([^/?#]+)/i)?.[1] ||
      null
    );
  } catch {
    return null;
  }
}

async function tryYouTubeCaptionsFromInnerTube(url) {
  const videoId = extractYouTubeVideoId(url);
  if (!videoId) return null;

  try {
    const cookieHeader = getYouTubeCookieHeader();
    const track = await getYouTubeCaptionTrackFromInnerTube(videoId, cookieHeader);
    const parsed = await downloadYouTubeCaption(track.baseUrl, videoId, cookieHeader);
    if (!parsed.text || parsed.text.length < 20) return null;
    return {
      ...parsed,
      source:
        track.kind === 'asr'
          ? 'youtube-innertube-auto-captions'
          : 'youtube-innertube-subtitles',
      language: track.languageCode,
    };
  } catch (error) {
    console.warn(
      '[transcricao] fallback InnerTube da legenda falhou:',
      error.response?.status || error.message
    );
    return null;
  }
}

async function tryYouTubeCaptionsFromPage(url) {
  const videoId = extractYouTubeVideoId(url);
  if (!videoId) return null;

  try {
    const cookieHeader = getYouTubeCookieHeader();
    const response = await axios.get('https://www.youtube.com/watch', {
      params: { v: videoId, hl: 'pt-BR', persist_hl: 1 },
      responseType: 'text',
      timeout: Math.min(LIMITES.legendasMs, 20_000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.7',
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
    });
    const track = chooseCaptionTrack(extractCaptionTracksFromWatchHtml(response.data));
    if (!track) {
      console.info(`[transcricao] página web sem captionTracks: ${videoId}`);
      return null;
    }
    const captionUrl = new URL(track.baseUrl);
    if (!/(^|\.)youtube\.com$/i.test(captionUrl.hostname)) return null;
    const parsed = await downloadYouTubeCaption(captionUrl, videoId, cookieHeader);
    if (!parsed.text || parsed.text.length < 20) return null;
    return {
      ...parsed,
      source: track.kind === 'asr' ? 'youtube-page-auto-captions' : 'youtube-page-subtitles',
      language: track.languageCode,
    };
  } catch (err) {
    console.warn('[transcricao] leitura da transcrição na página falhou:', err.response?.status || err.message);
    return null;
  }
}

/**
 * Fallback para quando `--write-auto-subs` falha silenciosamente. O JSON do
 * próprio yt-dlp já traz a URL temporária da transcrição pública do YouTube.
 */
async function tryYouTubeCaptionsFromInfo(info) {
  const track = captionTrackFromInfo(info);
  if (!track) return null;

  let parsedUrl;
  try {
    parsedUrl = new URL(track.url);
  } catch {
    return null;
  }
  if (!/(^|\.)youtube\.com$/i.test(parsedUrl.hostname)) return null;

  try {
    const videoId = String(info?.id || parsedUrl.searchParams.get('v') || '').trim();
    const parsed = await downloadYouTubeCaption(
      parsedUrl,
      videoId,
      getYouTubeCookieHeader()
    );
    if (!parsed.text || parsed.text.length < 20) return null;
    return {
      ...parsed,
      source: track.source,
      language: track.language,
    };
  } catch (err) {
    console.warn(
      '[transcricao] fallback da transcrição do YouTube falhou:',
      err.response?.status || err.message
    );
    return null;
  }
}

function assertUrlMediaLimits(info) {
  const duration = Number(info?.duration) || 0;
  if (duration > MAX_URL_DURATION_SECONDS) {
    const err = new Error('O vídeo passa de 45 minutos. Envie um vídeo menor para transcrever o áudio.');
    err.status = 422;
    throw err;
  }

  const estimatedBytes = Number(info?.filesize || info?.filesize_approx) || 0;
  if (estimatedBytes > MAX_URL_AUDIO_BYTES) {
    const err = new Error('O áudio deste vídeo é grande demais para transcrição automática.');
    err.status = 422;
    throw err;
  }
}

/**
 * Obtém a fala de um link social. Usa a transcrição disponibilizada primeiro e, quando
 * necessário, baixa somente o áudio para transcrição local com Whisper.
 */
async function transcribeUrl({
  sourceUrl,
  mediaUrl = null,
  subtitleUrl = null,
  preferSubtitles = true,
  mediaInfo = null,
  allowAudioFallback = true,
  onFallbackToAudio = null,
  contextText = '',
  preferAccuracy = false,
} = {}) {
  const original = String(sourceUrl || '').trim();
  const directMedia = String(mediaUrl || '').trim();
  if (!/^https?:\/\//i.test(original)) {
    const err = new Error('Link de vídeo inválido para transcrição');
    err.status = 400;
    throw err;
  }

  if (preferSubtitles) {
    const platform = detectPlatformFromUrl(original);
    const directSubtitles = await tryDirectPlatformSubtitles(subtitleUrl, platform);
    if (directSubtitles?.text) {
      console.info(`[transcricao] legenda da plataforma encontrada: ${original}`);
      return directSubtitles;
    }
    if (mediaInfo && /(?:youtube\.com|youtu\.be)/i.test(original)) {
      const captions = await tryYouTubeCaptionsFromInfo(mediaInfo);
      if (captions?.text) {
        console.info(`[transcricao] transcrição do YouTube obtida dos metadados: ${original}`);
        return captions;
      }
    }
    if (/(?:youtube\.com|youtu\.be)/i.test(original)) {
      const pageCaptions = await tryYouTubeCaptionsFromPage(original);
      if (pageCaptions?.text) {
        console.info(`[transcricao] transcrição obtida diretamente da página: ${original}`);
        return pageCaptions;
      }
      const innerTubeCaptions = await tryYouTubeCaptionsFromInnerTube(original);
      if (innerTubeCaptions?.text) {
        console.info(`[transcricao] transcrição obtida pelo InnerTube: ${original}`);
        return innerTubeCaptions;
      }
    }
    const subtitles = await trySubtitlesFromUrl(original);
    if (subtitles?.text && String(subtitles.text).trim().length >= 20) {
      console.info(`[transcricao] transcrição disponibilizada encontrada: ${original}`);
      return subtitles;
    }
    console.info(`[transcricao] transcrição não obtida na primeira tentativa: ${original}`);
  }

  const usingDirectMedia = /^https?:\/\//i.test(directMedia);
  const downloadUrl = usingDirectMedia ? directMedia : original;
  const directAuth = usingDirectMedia
    ? { platform: detectPlatformFromUrl(original), noCookies: true }
    : {};
  const info = mediaInfo || await inspectUrlMedia(downloadUrl, directAuth);
  if (preferSubtitles && /(?:youtube\.com|youtu\.be)/i.test(original)) {
    const captions = await tryYouTubeCaptionsFromInfo(info);
    if (captions?.text) {
      console.info(`[transcricao] transcrição do YouTube obtida pelo fallback: ${original}`);
      return captions;
    }
  }

  if (!allowAudioFallback) {
    console.info(`[transcricao] sem transcrição; fallback de áudio desativado: ${original}`);
    return null;
  }
  console.info(`[transcricao] sem transcrição; vai transcrever somente o áudio: ${original}`);
  if (typeof onFallbackToAudio === 'function') onFallbackToAudio();

  assertWhisperAvailable();
  assertUrlMediaLimits(info);

  const tmpRoot = path.resolve(env.storagePath, 'tmp');
  fs.mkdirSync(tmpRoot, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'url_audio_'));
  const output = path.join(tmpDir, 'source.%(ext)s');

  try {
    console.info(`[transcricao] baixando áudio: ${downloadUrl}`);
    const isYouTube = /(?:youtube\.com|youtu\.be)/i.test(original);
    await runYtDlpForUrl(
      downloadUrl,
      {
        // Voz não precisa de áudio em alta taxa. Em YouTube, 48–80 kbps reduz
        // drasticamente download e conversão sem prejudicar o Whisper.
        format: isYouTube
          ? 'bestaudio[abr<=80]/worstaudio/bestaudio/best'
          : 'bestaudio/best',
        output,
        noPlaylist: true,
        noWarnings: true,
        maxFilesize: '300M',
      },
      { timeoutMs: LIMITES.downloadMs, ...directAuth }
    );

    const downloaded = fs
      .readdirSync(tmpDir)
      .map((name) => path.join(tmpDir, name))
      .find((file) => !/\.(?:part|ytdl)$/i.test(file) && fs.statSync(file).isFile());
    if (!downloaded) throw new Error('Não foi possível baixar o áudio deste vídeo.');
    if (fs.statSync(downloaded).size > MAX_URL_AUDIO_BYTES) {
      throw new Error('O áudio deste vídeo é grande demais para transcrição automática.');
    }

    const result = await comVagaNoWhisper(() => {
      console.info(`[transcricao] Whisper iniciado: ${original}`);
      const inicio = Date.now();
      // faster-whisper/PyAV decodifica m4a/webm diretamente. Evita criar um WAV
      // enorme antes da transcrição e economiza dezenas de segundos por vídeo.
      return runPythonTranscribe(downloaded, {
        initialPrompt: contextText,
        preferAccuracy,
      }).then((r) => {
        console.info(
          `[transcricao] Whisper terminou em ${Math.round((Date.now() - inicio) / 1000)}s: ${original}`
        );
        return r;
      });
    });
    if (!result?.text || String(result.text).trim().length < 20) {
      throw new Error('Não encontrei fala suficiente no áudio deste vídeo.');
    }
    return { ...result, source: 'faster-whisper-url' };
  } catch (err) {
    // URLs diretas do CDN do Instagram expiram. Se isso aconteceu, deixa o
    // yt-dlp resolver novamente a mídia a partir do permalink original.
    // Repetir depois de um estouro de tempo só dobraria a espera do editor.
    if (usingDirectMedia && !err?.timedOut) {
      return transcribeUrl({
        sourceUrl: original,
        mediaUrl: null,
        preferSubtitles: false,
        allowAudioFallback,
        onFallbackToAudio,
        contextText,
        preferAccuracy,
      });
    }
    throw err;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

function canRunPython(cmd, args = ['--version']) {
  try {
    const result = spawnSync(cmd, args, {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 8000,
      env: process.env,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Resolve o interpretador Python disponível.
 * Preferência: PYTHON_PATH > .venv do projeto > python > py -3 > python3
 * Evita forçar py -3.10 (quebra se só houver 3.11/3.12/3.13).
 */
function resolvePythonCommand() {
  const configured = (env.pythonPath || '').trim();
  if (configured && canRunPython(configured, ['--version'])) {
    return { cmd: configured, prefixArgs: [] };
  }

  const projectRoot = path.resolve(__dirname, '../..');
  const virtualEnvPython =
    process.platform === 'win32'
      ? path.join(projectRoot, '.venv', 'Scripts', 'python.exe')
      : path.join(projectRoot, '.venv', 'bin', 'python');
  if (fs.existsSync(virtualEnvPython) && canRunPython(virtualEnvPython, ['--version'])) {
    return { cmd: virtualEnvPython, prefixArgs: [] };
  }

  const candidates =
    process.platform === 'win32'
      ? [
          { cmd: 'python', prefixArgs: [] },
          { cmd: 'py', prefixArgs: ['-3'] },
          { cmd: 'python3', prefixArgs: [] },
        ]
      : [
          { cmd: 'python3', prefixArgs: [] },
          { cmd: 'python', prefixArgs: [] },
        ];

  for (const candidate of candidates) {
    const probeArgs =
      candidate.prefixArgs.length > 0
        ? [...candidate.prefixArgs, '--version']
        : ['--version'];
    if (canRunPython(candidate.cmd, probeArgs)) {
      return candidate;
    }
  }

  return null;
}

function runPythonTranscribe(mediaPath, { initialPrompt = '', preferAccuracy = false } = {}) {
  const python = resolvePythonCommand();
  if (!python) {
    return Promise.reject(
      new Error(
        'Python não encontrado. Crie o ambiente com: python3 -m venv .venv && ./.venv/bin/python -m pip install -r scripts/requirements.txt'
      )
    );
  }

  const selectedModel = preferAccuracy
    ? LIMITES.whisperAccurateModel
    : LIMITES.whisperModel;
  const model = /^(?:tiny|base|small|medium|large-v3|turbo)$/i.test(selectedModel)
    ? selectedModel
    : 'base';
  const beamSize = preferAccuracy
    ? LIMITES.whisperAccurateBeamSize
    : LIMITES.whisperBeamSize;
  const args = [
    ...python.prefixArgs,
    SCRIPT_PATH,
    mediaPath,
    model,
    String(beamSize || 1),
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(python.cmd, args, { windowsHide: true, env: process.env });
    child.stdin.end(String(initialPrompt || '').slice(0, 1200));

    let stdout = '';
    let stderr = '';
    let encerrado = false;

    const finalizar = (fn, valor) => {
      if (encerrado) return;
      encerrado = true;
      clearTimeout(timer);
      fn(valor);
    };

    // Sem isto, um Whisper preso (download do modelo, memória no limite) nunca
    // fechava o processo e a resposta do chat ficava pendurada para sempre.
    const timer = setTimeout(() => {
      if (encerrado) return;
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      finalizar(
        reject,
        erroDeTempo(
          `A transcrição passou de ${Math.round(
            LIMITES.whisperMs / 60000
          )} min e foi interrompida. Tente um vídeo mais curto.`
        )
      );
    }, LIMITES.whisperMs);

    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    child.on('error', (err) => {
      finalizar(
        reject,
        new Error(
          `Falha ao iniciar Python (${python.cmd}): ${err.message}. Recrie o ambiente .venv e instale scripts/requirements.txt.`
        )
      );
    });

    child.on('close', (code) => {
      if (encerrado) return;
      let parsed;
      try {
        parsed = JSON.parse(stdout.trim() || '{}');
      } catch {
        const launcherHint = /No suitable Python runtime|PYLAUNCHER/i.test(stderr)
          ? ' O launcher `py` não achou a versão pedida — use `python` no PATH ou PYTHON_PATH=C:\\\\Python313\\\\python.exe'
          : '';
        return finalizar(
          reject,
          new Error((stderr.slice(0, 400) || 'Saída inválida do Whisper') + launcherHint)
        );
      }

      if (code !== 0 || parsed.error) {
        return finalizar(
          reject,
          new Error(
            parsed.error ||
              stderr.slice(0, 400) ||
              `Whisper falhou (code ${code})`
          )
        );
      }
      const text = String(parsed.text || '').trim();
      // Áudio sem fala: não é erro fatal — deixa o chamador decidir (análise IA usa título)
      return finalizar(resolve, {
        text,
        language: parsed.language || null,
        source: 'faster-whisper',
        segments: parsed.segments || [],
        empty: !text || parsed.empty === true,
      });
    });
  });
}

// spawnSync trava o event loop inteiro. Como a resposta não muda enquanto o
// processo vive, o teste roda uma vez só.
let whisperDisponivel = null;

function assertWhisperAvailable() {
  if (whisperDisponivel === true) return;

  const python = resolvePythonCommand();
  if (!python) {
    const err = new Error(
      'Whisper não está instalado no servidor. Rode: python3 -m venv .venv && ./.venv/bin/python -m pip install -r scripts/requirements.txt'
    );
    err.status = 503;
    throw err;
  }

  const probe = spawnSync(
    python.cmd,
    [...python.prefixArgs, '-c', 'import faster_whisper'],
    { windowsHide: true, encoding: 'utf8', timeout: 15_000, env: process.env }
  );
  if (probe.status !== 0) {
    const err = new Error(
      'faster-whisper não está instalado no servidor. Rode: ./.venv/bin/python -m pip install -r scripts/requirements.txt'
    );
    err.status = 503;
    throw err;
  }

  whisperDisponivel = true;
}

/**
 * Extrai fala de um clipe pronto.
 * 1) legendas do link de origem (se houver)
 * 2) faster-whisper local sobre o áudio do clipe
 *
 * @param {{ clipPath: string, sourceUrl?: string|null }} opts
 */
async function transcribeClip({ clipPath, sourceUrl }) {
  if (sourceUrl) {
    const fromSubs = await trySubtitlesFromUrl(sourceUrl);
    if (fromSubs?.text) return fromSubs;
  }

  const absClip = path.isAbsolute(clipPath) ? clipPath : storageAbsolutePath(clipPath);
  if (!fs.existsSync(absClip)) {
    const err = new Error('Arquivo do clipe não encontrado');
    err.status = 422;
    throw err;
  }

  const wavRel = `tmp/clip_audio_${Date.now()}.wav`;
  const wavAbs = storageAbsolutePath(wavRel);
  try {
    await extractAudioWav(absClip, wavAbs, { timeoutMs: LIMITES.audioMs });
    return await comVagaNoWhisper(() => runPythonTranscribe(wavAbs));
  } finally {
    try {
      if (fs.existsSync(wavAbs)) fs.unlinkSync(wavAbs);
    } catch {
      // ignore
    }
  }
}

module.exports = {
  transcribeClip,
  transcribeUrl,
  extractCaptionTracksFromWatchHtml,
  chooseCaptionTrack,
  captionUrlNeedsPoToken,
  buildYouTubeCaptionUrl,
  tryYouTubeCaptionsFromPage,
  tryYouTubeCaptionsFromInnerTube,
  parseDirectSubtitlePayload,
  tryDirectPlatformSubtitles,
  trySubtitlesFromUrl,
  resolvePythonCommand,
  parseVtt,
  comLimiteDeTempo,
};
