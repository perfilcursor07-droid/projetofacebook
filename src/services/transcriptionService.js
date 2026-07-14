const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const youtubedl = require('youtube-dl-exec');
const { env } = require('../config/env');
const { extractAudioWav } = require('./ffmpegService');
const { storageAbsolutePath } = require('./downloadService');

const SCRIPT_PATH = path.resolve(__dirname, '../../scripts/transcribe.py');

function stripVtt(content) {
  return content
    .replace(/\ufeff/g, '')
    .replace(/^WEBVTT.*$/gim, '')
    .replace(/NOTE[\s\S]*?(?=\n\n|\n$)/g, '')
    .replace(/\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}.*$/gm, '')
    .replace(/^\d+\s*$/gm, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{2,}/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((line, i, arr) => line !== arr[i - 1])
    .join(' ')
    .trim();
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

    // Prefere pt / pt-BR
    files.sort((a, b) => {
      const score = (name) =>
        /pt-?br/i.test(name) ? 0 : /pt/i.test(name) ? 1 : /en/i.test(name) ? 2 : 3;
      return score(a) - score(b);
    });

    const raw = fs.readFileSync(path.join(tmpDir, files[0]), 'utf8');
    const text = stripVtt(raw);
    if (!text || text.length < 20) return null;
    return { text, source: 'yt-dlp-subtitles', language: files[0].includes('.en') ? 'en' : 'pt' };
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

function runPythonTranscribe(wavPath) {
  const attempts =
    process.platform === 'win32'
      ? [
          { cmd: 'py', args: ['-3.10', SCRIPT_PATH, wavPath, 'small'] },
          { cmd: 'python', args: [SCRIPT_PATH, wavPath, 'small'] },
          { cmd: 'py', args: [SCRIPT_PATH, wavPath, 'small'] },
          { cmd: 'python3', args: [SCRIPT_PATH, wavPath, 'small'] },
        ]
      : [
          { cmd: 'python3', args: [SCRIPT_PATH, wavPath, 'small'] },
          { cmd: 'python', args: [SCRIPT_PATH, wavPath, 'small'] },
        ];

  return new Promise((resolve, reject) => {
    let idx = 0;
    let lastErr;

    function attempt() {
      if (idx >= attempts.length) {
        return reject(
          lastErr ||
            new Error(
              'Python não encontrado no PATH. Instale Python 3.9+ e rode: pip install -r scripts/requirements.txt'
            )
        );
      }

      const { cmd, args } = attempts[idx];
      idx += 1;
      const child = spawn(cmd, args, { windowsHide: true, env: process.env });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => {
        stdout += d.toString();
      });
      child.stderr.on('data', (d) => {
        stderr += d.toString();
      });

      child.on('error', (err) => {
        lastErr = err;
        attempt();
      });

      child.on('close', (code) => {
        let parsed;
        try {
          parsed = JSON.parse(stdout.trim() || '{}');
        } catch {
          lastErr = new Error(stderr.slice(0, 400) || 'Saída inválida do Whisper');
          // Se o executável rodou mas a saída é inválida, não adianta mudar de python
          return reject(lastErr);
        }

        if (parsed.error && /não instalado|not installed|No module named/i.test(parsed.error)) {
          lastErr = new Error(parsed.error);
          return attempt();
        }

        if (code !== 0 || parsed.error) {
          return reject(new Error(parsed.error || stderr.slice(0, 400) || `Whisper falhou (code ${code})`));
        }
        if (!parsed.text) {
          return reject(new Error('Whisper não detectou fala no áudio'));
        }
        resolve({
          text: String(parsed.text).trim(),
          language: parsed.language || null,
          source: 'faster-whisper',
          segments: parsed.segments || [],
        });
      });
    }

    attempt();
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

module.exports = { transcribeClip, trySubtitlesFromUrl };
