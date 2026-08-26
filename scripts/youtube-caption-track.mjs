import { Innertube } from 'youtubei.js';

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
  const youtube = await Innertube.create({ retrieve_player: false });
  for (const client of ['ANDROID', 'ANDROID_VR']) {
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
