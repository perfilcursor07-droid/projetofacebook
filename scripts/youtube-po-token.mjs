import { Innertube } from 'youtubei.js';
import { BotGuardClient } from 'bgutils-js/botguard';
import { WebPoMinter } from 'bgutils-js/webpo';
import { JSDOM } from 'jsdom';

const REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo';
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131 Safari/537.36';

function fail(message) {
  process.stderr.write(`${String(message || 'Falha ao gerar PO Token')}\n`);
  process.exit(1);
}

const videoId = String(process.argv[2] || '').trim();
if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) fail('ID de vídeo inválido');

try {
  const youtube = await Innertube.create({ retrieve_player: false });
  const challenge = await youtube.getAttestationChallenge('ENGAGEMENT_TYPE_UNBOUND');
  const bg = challenge?.bg_challenge;
  const globalName = bg?.global_name || bg?.globalName;
  const interpreterUrl =
    bg?.interpreter_url?.private_do_not_access_or_else_trusted_resource_url_wrapped_value ||
    bg?.interpreterUrl?.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue;
  if (!bg?.program || !globalName || !interpreterUrl) {
    throw new Error('Desafio BotGuard incompleto');
  }

  const scriptResponse = await fetch(
    interpreterUrl.startsWith('//') ? `https:${interpreterUrl}` : interpreterUrl
  );
  if (!scriptResponse.ok) throw new Error(`BotGuard HTTP ${scriptResponse.status}`);
  const interpreter = await scriptResponse.text();

  // O interpretador oficial espera APIs reais de navegador. O processo é
  // separado do servidor para que esses globais e o JS do BotGuard fiquem
  // isolados da aplicação principal.
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'https://www.youtube.com/',
    referrer: 'https://www.youtube.com/',
    userAgent: USER_AGENT,
  });
  // Esta espera também deixa o JSDOM concluir DOMContentLoaded antes de o
  // interpretador BotGuard registrar listeners temporários nesse evento.
  const pageResponse = await fetch('https://www.youtube.com', {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!pageResponse.ok) throw new Error(`YouTube HTTP ${pageResponse.status}`);
  const pageHtml = await pageResponse.text();
  const ytConfig = pageHtml.match(/ytcfg\.set\(({.+?})\);/s)?.[1];
  if (!ytConfig) throw new Error('Configuração do YouTube não encontrada');
  dom.window.yt = { config_: JSON.parse(ytConfig) };
  Object.assign(globalThis, {
    yt: dom.window.yt,
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    origin: dom.window.origin,
  });
  if (!('navigator' in globalThis)) {
    Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator });
  }
  new Function(interpreter)();

  const client = await BotGuardClient.create({
    program: bg.program,
    globalName,
    globalObject: globalThis,
  });
  const webPoSignalOutput = [];
  const botguardResponse = await client.snapshot({ webPoSignalOutput });
  const integrityResponse = await fetch(
    'https://jnn-pa.googleapis.com/$rpc/google.internal.waa.v1.Waa/GenerateIT',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json+protobuf',
        'x-goog-api-key': 'AIzaSyDyT5W0Jh49F30Pqqtyfdf7pDLFKLJoAnw',
        'x-user-agent': 'grpc-web-javascript/0.1',
      },
      body: JSON.stringify([REQUEST_KEY, botguardResponse]),
    }
  );
  if (!integrityResponse.ok) {
    throw new Error(`Integridade do BotGuard HTTP ${integrityResponse.status}`);
  }
  const [integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken] =
    await integrityResponse.json();
  const minter = await WebPoMinter.create(
    { integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken },
    webPoSignalOutput
  );
  const poToken = await minter.mintAsWebsafeString(videoId);
  if (!poToken) throw new Error('PO Token vazio');

  process.stdout.write(
    JSON.stringify({
      poToken,
      videoId,
      expiresIn: Math.max(300, Number(estimatedTtlSecs) || 21600),
    })
  );
} catch (error) {
  fail(error?.message || error);
}
