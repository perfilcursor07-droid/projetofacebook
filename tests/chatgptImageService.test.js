const assert = require('node:assert/strict');
const test = require('node:test');

const {
  promptPadrao,
  promptSimbolicoPadrao,
  recusaDeSeguranca,
  promptComFormatoFacebook,
  cookiesDoHeader,
  verificarSessaoChatgpt,
  garantirSessaoChatgpt,
} = require('../src/services/chatgptImageService');

test('ilustração simbólica não inclui referência, pessoas nem contexto da matéria', () => {
  const prompt = promptComFormatoFacebook(promptSimbolicoPadrao(), {}, { semReferencia: true });
  assert.match(prompt, /fé e esperança/);
  assert.match(prompt, /Não represente pessoas/);
  assert.doesNotMatch(prompt, /imagem de referência|Contexto da matéria|Menina de 4 anos/i);
  assert.doesNotMatch(prompt, /presente na referência/i);
});

test('recusa de segurança de imagens é reconhecida sem tratar como falha de login', () => {
  assert.equal(recusaDeSeguranca('We’re so sorry, but the image we created may violate our guardrails around acceptable depictions of teens and children.'), true);
  assert.equal(recusaDeSeguranca('A sessão do ChatGPT expirou.'), false);
});

test('prompt de imagem pede reconstrução baseada na referência e sem texto', () => {
  const prompt = promptPadrao({
    titulo: 'Liderança comenta decisão durante encontro público',
    materia: 'A matéria descreve uma reunião e registra a reação dos participantes.',
  });

  assert.match(prompt, /imagem de referência/i);
  assert.match(prompt, /nova imagem editorial fotorrealista/i);
  assert.match(prompt, /não inclua texto/i);
  assert.match(prompt, /logotipos, marcas d’água/i);
  assert.match(prompt, /vertical.*4:5/i);
  assert.match(prompt, /1080 × 1350/i);
  assert.match(prompt, /Liderança comenta decisão/i);
});

test('formato do feed do Facebook é obrigatório mesmo em prompt personalizado', () => {
  const prompt = promptComFormatoFacebook('Deixe a pessoa com expressão triste.');

  assert.match(prompt, /Deixe a pessoa com expressão triste/);
  assert.match(prompt, /REGRA OBRIGATÓRIA DE FORMATO/);
  assert.match(prompt, /proporção EXATA 4:5/);
  assert.match(prompt, /1080 × 1350 pixels/);
  assert.match(prompt, /Não entregue imagem quadrada nem horizontal/);
  assert.match(prompt, /imagem final deve ficar totalmente sem texto/i);
  assert.match(prompt, /Remova qualquer palavra, letra, número/i);
  assert.match(prompt, /Não recrie nem substitua esses elementos por outros textos/i);
});

test('cookies do ChatGPT usam URL host-only aceita pelo Chrome', () => {
  const cookies = cookiesDoHeader(
    '__Host-next-auth.csrf-token=abc123; __Secure-next-auth.session-token.0=parteA; oai-did=device'
  );

  assert.equal(cookies.length, 3);
  for (const cookie of cookies) {
    assert.equal(cookie.url, 'https://chatgpt.com/');
    assert.equal(cookie.secure, true);
    assert.equal('domain' in cookie, false);
    assert.equal('path' in cookie, false);
  }
});

function paginaComSessao({ status = 200, data = {}, url = 'https://chatgpt.com/', editor = false } = {}) {
  return {
    url: () => url,
    evaluate: async (callback) => {
      const anterior = global.fetch;
      global.fetch = async () => ({
        status,
        ok: status >= 200 && status < 300,
        json: async () => data,
      });
      try {
        return await callback();
      } finally {
        global.fetch = anterior;
      }
    },
    locator: () => ({
      first: () => ({
        waitFor: editor ? async () => {} : async () => { throw new Error('editor ausente'); },
      }),
    }),
  };
}

test('erro temporário na API de sessão não é confundido com login expirado', async () => {
  const page = paginaComSessao({ status: 503, editor: true });
  const sessao = await verificarSessaoChatgpt(page);
  assert.equal(sessao.estado, 'indefinida');
  await assert.doesNotReject(garantirSessaoChatgpt(page, {}, null));
});

test('sem sessão e sem editor mostra erro técnico, não falso logout', async () => {
  const page = paginaComSessao({ status: 429 });
  await assert.rejects(garantirSessaoChatgpt(page, {}, null), (err) => {
    assert.equal(err.status, 503);
    assert.match(err.message, /sessão HTTP 429/);
    return true;
  });
});

test('HTTP 401 do ChatGPT confirma que é necessário novo login', async () => {
  const page = paginaComSessao({ status: 401 });
  await assert.rejects(garantirSessaoChatgpt(page, {}, null), (err) => {
    assert.equal(err.status, 401);
    assert.match(err.message, /sessão do ChatGPT expirou/i);
    return true;
  });
});

test('sessão vazia (ChatGPT deslogado) exige novo login mesmo com editor visível', async () => {
  const page = paginaComSessao({ status: 200, data: {}, editor: true });
  const sessao = await verificarSessaoChatgpt(page);
  assert.equal(sessao.estado, 'expirada');
  await assert.rejects(garantirSessaoChatgpt(page, {}, null), (err) => {
    assert.equal(err.status, 401);
    return true;
  });
});

test('formato desconhecido da sessão não impede editor autenticado', async () => {
  const page = paginaComSessao({ status: 200, data: { novoFormato: true }, editor: true });
  await assert.doesNotReject(garantirSessaoChatgpt(page, {}, null));
});
