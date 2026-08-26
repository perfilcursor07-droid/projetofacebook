const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractCaptionTracksFromWatchHtml,
  chooseCaptionTrack,
} = require('../src/services/transcriptionService');

test('extrai faixas de legenda diretamente do HTML do player do YouTube', () => {
  const tracks = [
    {
      baseUrl: 'https://www.youtube.com/api/timedtext?v=abc&lang=en',
      languageCode: 'en',
    },
    {
      baseUrl: 'https://www.youtube.com/api/timedtext?v=abc&lang=pt',
      languageCode: 'pt',
      kind: 'asr',
    },
  ];
  const html = `<script>var ytInitialPlayerResponse={"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":${JSON.stringify(tracks)},"audioTracks":[]}}};</script>`;

  const extraidas = extractCaptionTracksFromWatchHtml(html);
  const escolhida = chooseCaptionTrack(extraidas);

  assert.equal(extraidas.length, 2);
  assert.equal(escolhida.languageCode, 'pt');
  assert.equal(escolhida.kind, 'asr');
});

test('vídeo sem captionTracks não inventa uma transcrição', () => {
  assert.deepEqual(extractCaptionTracksFromWatchHtml('<html>sem legendas</html>'), []);
  assert.equal(chooseCaptionTrack([]), null);
});
