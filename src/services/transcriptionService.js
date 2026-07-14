const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const youtubedl = require('youtube-dl-exec');
const { env } = require('../config/env');
const { extractAudioWav } = require('./ffmpegService');
const { storageAbsolutePath } = require('./downloadService');

const SCRIPT_PATH = path.resolve(__dirname, '../../scripts/transcribe.py');

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

  const text = segments
    .map((segment) => segment.text)
    .filter((line, index, all) => line !== all[index - 1])
    .join(' ')
    .trim();

  return { text, segments };
}

/**
 * Tenta obter legendas manuais/automáticas do link via yt-dlp (sem baixar vídeo).
 */
async function trySubtitlesFromUrl(url) {
  if (!url || !/^https?:\/\//i.test(url)) return null;

  const tmpDir = path.resolve(env.storagePath, 'tmp', `subs_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const outTemplate = path.join(tmpDir, 'subs');

  try {
    await youtubedl(url, {
      skipDownload: true,
      writeSub: true,
      writeAutoSub: true,
      subLangs: 'pt,pt-BR,en',
      subFormat: 'vtt',
      output: outTemplate,
      noWarnings: true,
      noPlaylist: true,
    });

    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.vtt'));
    if (!files.length) return null;

    files.sort((a, b) => {
      const score = (name) =>
        /pt-?br/i.test(name) ? 0 : /pt/i.test(name) ? 1 : /en/i.test(name) ? 2 : 3;
      return score(a) - score(b);
    });

    const raw = fs.readFileSync(path.join(tmpDir, files[0]), 'utf8');
    const parsed = parseVtt(raw);
    if (!parsed.text || parsed.text.length < 20) return null;
    return {
      ...parsed,
      source: 'yt-dlp-subtitles',
      language: files[0].includes('.en') ? 'en' : 'pt',
    };
  } catch {
    return null;
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
 * Preferência: PYTHON_PATH > python > py -3 > python3
 * Evita forçar py -3.10 (quebra se só houver 3.11/3.12/3.13).
 */
function resolvePythonCommand() {
  const configured = (env.pythonPath || '').trim();
  if (configured && canRunPython(configured, ['--version'])) {
    return { cmd: configured, prefixArgs: [] };
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

function runPythonTranscribe(wavPath) {
  const python = resolvePythonCommand();
  if (!python) {
    return Promise.reject(
      new Error(
        'Python não encontrado. Instale Python 3.9+ e rode: pip install -r scripts/requirements.txt (ou defina PYTHON_PATH no .env)'
      )
    );
  }

  const args = [...python.prefixArgs, SCRIPT_PATH, wavPath, 'small'];

  return new Promise((resolve, reject) => {
    const child = spawn(python.cmd, args, { windowsHide: true, env: process.env });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    child.on('error', (err) => {
      reject(
        new Error(
          `Falha ao iniciar Python (${python.cmd}): ${err.message}. Defina PYTHON_PATH no .env ou rode: pip install -r scripts/requirements.txt`
        )
      );
    });

    child.on('close', (code) => {
      let parsed;
      try {
        parsed = JSON.parse(stdout.trim() || '{}');
      } catch {
        const launcherHint = /No suitable Python runtime|PYLAUNCHER/i.test(stderr)
          ? ' O launcher `py` não achou a versão pedida — use `python` no PATH ou PYTHON_PATH=C:\\\\Python313\\\\python.exe'
          : '';
        return reject(
          new Error((stderr.slice(0, 400) || 'Saída inválida do Whisper') + launcherHint)
        );
      }

      if (code !== 0 || parsed.error) {
        return reject(
          new Error(
            parsed.error ||
              stderr.slice(0, 400) ||
              `Whisper falhou (code ${code})`
          )
        );
      }
      const text = String(parsed.text || '').trim();
      // Áudio sem fala: não é erro fatal — deixa o chamador decidir (análise IA usa título)
      resolve({
        text,
        language: parsed.language || null,
        source: 'faster-whisper',
        segments: parsed.segments || [],
        empty: !text || parsed.empty === true,
      });
    });
  });
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
    await extractAudioWav(absClip, wavAbs);
    return await runPythonTranscribe(wavAbs);
  } finally {
    try {
      if (fs.existsSync(wavAbs)) fs.unlinkSync(wavAbs);
    } catch {
      // ignore
    }
  }
}

module.exports = { transcribeClip, trySubtitlesFromUrl, resolvePythonCommand, parseVtt };
