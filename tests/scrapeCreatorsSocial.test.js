const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizarInstagram } = require('../src/services/scrapeCreatorsSocial');
const { parseNetscapeLine } = require('../src/services/instagramCookies');

test('preserva legenda escrita, vídeo e faixa de legendas do Reel', () => {
  const result = normalizarInstagram(
    {
      shortcode: 'Db5_4z1x4Pa',
      caption: { text: 'Legenda original com o nome da pessoa e o assunto do vídeo.' },
      video_url: 'https://scontent.cdninstagram.com/video.mp4',
      video_subtitles: [
        { url: 'https://scontent.cdninstagram.com/legenda.vtt', locale: 'pt_BR' },
      ],
      owner: { username: 'perfil_teste' },
      is_video: true,
    },
    'https://www.instagram.com/reel/Db5_4z1x4Pa/'
  );

  assert.equal(result.texto, 'Legenda original com o nome da pessoa e o assunto do vídeo.');
  assert.equal(result.videoUrl, 'https://scontent.cdninstagram.com/video.mp4');
  assert.equal(result.subtitleUrl, 'https://scontent.cdninstagram.com/legenda.vtt');
  assert.equal(result.isVideo, true);
});

test('cookies HttpOnly do Instagram continuam disponíveis para a sessão', () => {
  const parsed = parseNetscapeLine(
    '#HttpOnly_.instagram.com\tTRUE\t/\tTRUE\t1999999999\tsessionid\tsessao-teste'
  );

  assert.equal(parsed.domain, '.instagram.com');
  assert.equal(parsed.name, 'sessionid');
  assert.equal(parsed.value, 'sessao-teste');
});
