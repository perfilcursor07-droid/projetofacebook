import { Innertube } from 'youtubei.js';
import fs from 'node:fs';

function fail(message) {
  process.stderr.write(`${String(message || 'Faixa de legenda não encontrada')}\n`);
  process.exit(1);
}

function chooseTrack(tracks) {
  const list = (Array.isArray(tracks) ? tracks : []).filter(
    (track) => track?.baseUrl && track?.languageCode
  );
  for (const language of ['pt-BR', 'pt', 'pt-PT', 'en-US', 'en']) {
    const found = list.find((track) => String(track.languageCode) === language);
    if (found) return found;
  }
  return list[0] || null;
}

const videoId = String(process.argv[2] || '').trim();
if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) fail('ID de vídeo inválido');

try {
  // O cabeçalho chega pelo stdin para nunca aparecer em argumentos, ps ou logs.
  const cookie = String(fs.readFileSync(0, 'utf8') || '').trim();
  const youtube = await Innertube.create({
    retrieve_player: false,
    cookie: cookie || undefined,
  });
  // Android costuma entregar as legendas sem PO Token. Com uma sessão salva,
  // WEB/MWEB também entram como alternativas para IPs de datacenter.
  const clients = [
    'ANDROID',
    'ANDROID_VR',
    ...(cookie ? ['WEB', 'MWEB'] : []),
  ];
  for (const client of clients) {
    const response = await youtube.actions.execute('/player', {
      videoId,
      racyCheckOk: true,
      contentCheckOk: true,
      client,
    });
    const player = response?.data || {};
    const tracks =
      player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    const track = chooseTrack(tracks);
    if (!track) continue;

    process.stdout.write(
      JSON.stringify({
        baseUrl: track.baseUrl,
        languageCode: track.languageCode,
        kind: track.kind || null,
        name: track.name || null,
        client,
      })
    );
    process.exit(0);
  }
  fail('O InnerTube não disponibilizou faixas de legenda para este vídeo');
} catch (error) {
  fail(error?.message || error);
}
