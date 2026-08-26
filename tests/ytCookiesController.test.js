const test = require('node:test');
const assert = require('node:assert/strict');

const { filterYoutubeCookies } = require('../src/controllers/ytCookiesController');

test('preserva cookies HttpOnly do YouTube no formato Netscape', () => {
  const input = [
    '# Netscape HTTP Cookie File',
    '#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t1999999999\t__Secure-3PSID\tsegredo',
    '.youtube.com\tTRUE\t/\tTRUE\t1999999999\tPREF\thl=pt-BR',
    '.google.com\tTRUE\t/\tTRUE\t1999999999\tSAPISID\tnao-deve-entrar',
    '# comentário comum',
  ].join('\n');

  const result = filterYoutubeCookies(input);

  assert.equal(result.cookieCount, 2);
  assert.equal(result.authCount, 1);
  assert.match(result.content, /#HttpOnly_\.youtube\.com.*__Secure-3PSID.*segredo/);
  assert.match(result.content, /\.youtube\.com.*PREF.*hl=pt-BR/);
  assert.doesNotMatch(result.content, /google\.com/);
});
