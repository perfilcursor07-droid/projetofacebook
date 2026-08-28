const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

const {
  apiErrorMessage,
  prepareTwitterImage,
  truncateForTwitter,
  twitterWeightedLength,
} = require('../src/services/ayrshareService');

test('erros BYO do X explicam permissao e credenciais', () => {
  assert.match(
    apiErrorMessage({ response: { data: { code: 417, message: 'oauth1 app permissions' } } }),
    /Read and write/
  );
  assert.match(
    apiErrorMessage({ response: { data: { code: 419, action: 'x_credentials_required' } } }),
    /AYRSHARE_X_API_KEY/
  );
});

test('legenda do X nunca ultrapassa o peso 280', () => {
  const input = 'A'.repeat(400);
  const output = truncateForTwitter(input);

  assert.equal(output.endsWith('...'), true);
  assert.equal(twitterWeightedLength(output), 280);
});

test('reticencias Unicode pesam 2 e nao causam mais o overage de 1', () => {
  const formatoAntigo = `${'A'.repeat(279)}…`;
  const output = truncateForTwitter(formatoAntigo);

  assert.equal(twitterWeightedLength(formatoAntigo), 281);
  assert.ok(twitterWeightedLength(output) <= 280);
});

test('emoji tem peso 2 e URL inteira usa o peso encurtado do X', () => {
  assert.equal(twitterWeightedLength('Notícia 🔥'), 10);
  assert.equal(
    twitterWeightedLength('Leia https://www.viralizeai.online/materia/123456789'),
    28
  );
});

test('corte nao parte URL', () => {
  const url = 'https://www.viralizeai.online/materia/uma-url-muito-grande';
  const output = truncateForTwitter(`${'A'.repeat(260)} ${url}`);

  assert.equal(output.includes('https://'), false);
  assert.ok(twitterWeightedLength(output) <= 280);
});

test('imagem exclusiva do X vira JPEG de ate 1200 px e menos de 5 MB', async () => {
  const source = path.join(os.tmpdir(), `viralizeai-x-source-${process.pid}-${Date.now()}.png`);
  let prepared = null;
  try {
    await sharp({
      create: {
        width: 2200,
        height: 1600,
        channels: 4,
        background: { r: 24, g: 84, b: 160, alpha: 0.7 },
      },
    })
      .png()
      .toFile(source);

    prepared = await prepareTwitterImage(source);
    assert.ok(prepared?.filePath);
    const metadata = await sharp(prepared.filePath).metadata();
    assert.equal(metadata.format, 'jpeg');
    assert.equal(metadata.isProgressive, false);
    assert.equal(metadata.space, 'srgb');
    assert.ok(metadata.width <= 1200);
    assert.ok(metadata.height <= 1200);
    assert.ok(prepared.bytes < 5 * 1024 * 1024);
  } finally {
    prepared?.remove();
    if (fs.existsSync(source)) fs.unlinkSync(source);
  }
});
