const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractCaptionTracksFromWatchHtml,
  chooseCaptionTrack,
  captionUrlNeedsPoToken,
  buildYouTubeCaptionUrl,
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

test('reconhece legenda do YouTube protegida por PO Token', () => {
  assert.equal(
    captionUrlNeedsPoToken('https://www.youtube.com/api/timedtext?v=abc123&exp=xpe&lang=pt'),
    true
  );
  assert.equal(
    captionUrlNeedsPoToken('https://www.youtube.com/api/timedtext?v=abc123&lang=pt'),
    false
  );
});

test('monta URL de legenda com todos os parâmetros exigidos pelo YouTube', () => {
  const result = new URL(
    buildYouTubeCaptionUrl(
      'https://www.youtube.com/api/timedtext?v=abc123&exp=xpe&lang=pt&xosf=1',
      { poToken: 'token_teste' }
    )
  );

  assert.equal(result.searchParams.get('fmt'), 'vtt');
  assert.equal(result.searchParams.get('pot'), 'token_teste');
  assert.equal(result.searchParams.get('potc'), '1');
  assert.equal(result.searchParams.get('c'), 'WEB');
  assert.equal(result.searchParams.has('xosf'), false);
});
