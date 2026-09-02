const axios = require('axios');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { env } = require('../config/env');
const { fetchImage } = require('./editorialCardService');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const GATEWAY_ROOT = path.resolve(
  process.env.TOKEN_FREE_GATEWAY_SOURCE_DIR || path.join(PROJECT_ROOT, '.tools/token-free-gateway')
);
const AUTH_FILE = process.env.TFG_STORE_PATH || path.join(os.homedir(), '.token-free-gateway', 'auth-profiles.json');
const PLAYWRIGHT_PATH = path.join(GATEWAY_ROOT, 'node_modules', 'playwright-core');
const CHATGPT_MODEL = String(process.env.CHATGPT_IMAGE_MODEL || 'gpt-5.6').trim();
const MAX_PROMPT = 1800;
let geracaoAtiva = null;

function erro(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function credenciaisChatgpt() {
  let store;
  try {
    store = JSON.parse(await fs.readFile(AUTH_FILE, 'utf8'));
  } catch {
    throw erro('A sessão do ChatGPT não está configurada. Entre no ChatGPT pela página /claude.', 409);
  }
  const credentials = store?.profiles?.['chatgpt-web']?.credentials;
  if (!credentials?.cookie && !credentials?.accessToken) {
    throw erro('A sessão do ChatGPT não está configurada. Entre no ChatGPT pela página /claude.', 409);
  }
  return credentials;
}

function cookiesDoHeader(raw) {
  return String(raw || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const idx = part.indexOf('=');
      if (idx < 1) return null;
      return {
        name: part.slice(0, idx).trim(),
        value: part.slice(idx + 1),
        // `url` cria um cookie host-only válido inclusive para os prefixos
        // __Host-* e __Secure-*. Combinar esses cookies com `domain` fazia o
        // Chrome rejeitar o lote inteiro com Storage.setCookies.
        url: 'https://chatgpt.com/',
        secure: true,
      };
    })
    .filter((cookie) =>
      Boolean(cookie?.name && cookie.value) && /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(cookie.name)
    );
}

async function sessaoChatgptAtiva(page) {
  return page.evaluate(async () => {
    try {
      const response = await fetch('/api/auth/session', { credentials: 'include' });
      if (!response.ok) return false;
      const data = await response.json();
      return Boolean(data?.accessToken || data?.user?.id || data?.user?.email);
    } catch {
      return false;
    }
  });
}

async function websocketCdp() {
  const configPath = path.join(os.homedir(), '.token-free-gateway', 'config.json');
  let cdpUrl = 'http://127.0.0.1:9222';
  try {
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    if (config?.cdpUrl) cdpUrl = String(config.cdpUrl).replace(/\/$/, '');
  } catch {
    // Usa a porta local padrão do gateway.
  }
  try {
    const { data } = await axios.get(`${cdpUrl}/json/version`, { timeout: 4000 });
    const ws = String(data?.webSocketDebuggerUrl || '').trim();
    if (!ws) throw new Error('CDP sem websocket');
    return ws.replace(/ws:\/\/(0\.0\.0\.0|::)/, 'ws://127.0.0.1');
  } catch {
    throw erro('O Chrome isolado está desligado. Inicie o gateway na página /claude.', 503);
  }
}

async function imagemParaUpload(sourceUrl) {
  const original = await fetchImage(sourceUrl);
  const buffer = await sharp(original, { failOn: 'error', limitInputPixels: 40_000_000 })
    .rotate()
    .resize(1536, 1536, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
  return { name: 'imagem-referencia.jpg', mimeType: 'image/jpeg', buffer };
}

function promptPadrao({ titulo = '', materia = '' } = {}) {
  const contexto = [String(titulo || '').trim(), String(materia || '').replace(/\s+/g, ' ').trim().slice(0, 650)]
    .filter(Boolean)
    .join('\n');
  return [
    'Crie uma NOVA imagem editorial fotorrealista inspirada na imagem de referência enviada.',
    'Mantenha o assunto, as pessoas e a atmosfera reconhecíveis, mas reconstrua a cena de forma original e natural.',
    'Não inclua texto, letras, legendas, placas legíveis, logotipos, marcas d’água, molduras ou elementos gráficos.',
    'Composição vertical 4:5, alta qualidade, adequada como imagem destacada de uma notícia no Facebook.',
    'Não altere a identidade de pessoas públicas presentes na referência e não invente acontecimentos.',
    contexto ? `Contexto da matéria:\n${contexto}` : null,
  ].filter(Boolean).join('\n\n');
}

async function baixarImagemDaPagina(page, src) {
  const dataUrl = await page.evaluate(async (url) => {
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) throw new Error(`download HTTP ${response.status}`);
    const blob = await response.blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('falha ao ler imagem'));
      reader.readAsDataURL(blob);
    });
  }, src);
  const match = String(dataUrl || '').match(/^data:([^;,]+);base64,(.+)$/s);
  if (!match) throw erro('O ChatGPT gerou a imagem, mas não foi possível baixá-la.', 502);
  return { mimeType: match[1], buffer: Buffer.from(match[2], 'base64') };
}

async function estadoDosAnexos(composer) {
  return composer.evaluate((root) => {
    const texto = String(root.innerText || root.textContent || '').toLowerCase();
    const imagens = [...root.querySelectorAll('img')].filter((img) => {
      const src = String(img.currentSrc || img.src || '');
      return /^(blob:|data:image\/)/i.test(src) || (img.naturalWidth >= 48 && img.naturalHeight >= 48);
    }).length;
    const controlesRemover = [...root.querySelectorAll('button, [role="button"]')].filter((node) => {
      const rotulo = `${node.getAttribute('aria-label') || ''} ${node.getAttribute('title') || ''}`;
      return /remove|remover|excluir|delete/i.test(rotulo);
    }).length;
    const marcadores = root.querySelectorAll([
      '[data-testid*="attachment"]',
      '[data-testid*="file-thumbnail"]',
      '[data-testid*="image-preview"]',
      '[class*="attachment"]',
      '[class*="file-thumbnail"]',
      '[class*="image-preview"]',
    ].join(',')).length;
    return {
      nomeDoArquivo: texto.includes('imagem-referencia.jpg'),
      imagens,
      controlesRemover,
      marcadores,
    };
  });
}

async function aguardarAnexo(composer, anterior, timeout = 35_000) {
  const limite = Date.now() + timeout;
  while (Date.now() < limite) {
    const atual = await estadoDosAnexos(composer).catch(() => null);
    if (atual && (
      atual.nomeDoArquivo
      || atual.imagens > anterior.imagens
      || atual.controlesRemover > anterior.controlesRemover
      || atual.marcadores > anterior.marcadores
    )) return true;
    await composer.page().waitForTimeout(500);
  }
  return false;
}

async function colarImagemNoComposer(input, upload) {
  await input.focus();
  return input.evaluate((target, arquivo) => {
    const binario = atob(arquivo.base64);
    const bytes = new Uint8Array(binario.length);
    for (let i = 0; i < binario.length; i += 1) bytes[i] = binario.charCodeAt(i);
    const file = new File([bytes], arquivo.name, { type: arquivo.mimeType });
    const transferencia = new DataTransfer();
    transferencia.items.add(file);

    let evento;
    try {
      evento = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: transferencia,
      });
    } catch {
      evento = new Event('paste', { bubbles: true, cancelable: true });
    }
    // Algumas versões do Chromium ignoram clipboardData no construtor, mas o
    // ChatGPT consulta essa propriedade no manipulador de paste.
    if (!evento.clipboardData) {
      Object.defineProperty(evento, 'clipboardData', { value: transferencia });
    }
    return target.dispatchEvent(evento);
  }, {
    name: upload.name,
    mimeType: upload.mimeType,
    base64: upload.buffer.toString('base64'),
  });
}

async function anexarImagemNoComposer(page, input, upload) {
  let composer = input.locator('xpath=ancestor::form[1]');
  if (!(await composer.count())) {
    composer = page.locator('#composer-background, [data-testid="composer"]').filter({ visible: true }).first();
  }
  if (!(await composer.count())) {
    throw erro('Não foi possível localizar o compositor ativo do ChatGPT.', 502);
  }

  // A miniatura que o ChatGPT cria pode ficar em um portal fora do <form>.
  // Por isso a confirmação observa a página toda, embora o arquivo continue
  // sendo colocado exclusivamente no input do compositor ativo.
  const areaDeConfirmacao = page.locator('body');
  const anterior = await estadoDosAnexos(areaDeConfirmacao);

  // Colar uma imagem no editor usa o mesmo fluxo suportado pelo ChatGPT para
  // capturas de tela e independe do idioma ou da estrutura do menu de anexos.
  await colarImagemNoComposer(input, upload);
  if (await aguardarAnexo(areaDeConfirmacao, anterior, 20_000)) return;

  // Aciona o fluxo real da interface. Preencher diretamente o primeiro input
  // oculto pode selecionar um campo interno que o React não usa no compositor.
  const botaoAnexar = page.locator([
    '[data-testid="composer-plus-btn"]:visible',
    'button[aria-label*="Attach" i]:visible',
    'button[aria-label*="Anex" i]:visible',
    'button[aria-label*="Adicionar" i]:visible',
  ].join(',')).last();
  if (!(await botaoAnexar.count())) {
    throw erro('O botão de anexar imagem não foi encontrado no ChatGPT.', 502);
  }

  let escolhaPromise = page.waitForEvent('filechooser', { timeout: 2500 }).catch(() => null);
  await botaoAnexar.click();
  let escolha = await escolhaPromise;

  if (!escolha) {
    let opcaoUpload = page.locator([
      '[role="menuitem"]:has-text("Adicionar fotos e arquivos"):visible',
      '[role="menuitem"]:has-text("Add photos & files"):visible',
      '[role="menuitem"]:has-text("Carregar do computador"):visible',
      '[role="menuitem"]:has-text("Upload from computer"):visible',
      '[role="menuitem"]:has-text("Enviar arquivo"):visible',
      '[role="menuitem"]:has-text("Upload file"):visible',
      'button:has-text("Adicionar fotos e arquivos"):visible',
      'button:has-text("Add photos & files"):visible',
      'button:has-text("Carregar do computador"):visible',
      'button:has-text("Upload from computer"):visible',
    ].join(',')).first();

    try {
      await opcaoUpload.waitFor({ state: 'visible', timeout: 5000 });
    } catch {
      const opcaoGenerica = page.locator('[role="menuitem"]:visible, [role="option"]:visible')
        .filter({ hasText: /foto|photo|arquivo|file|upload|carregar/i })
        .first();
      if (await opcaoGenerica.count()) {
        opcaoUpload = opcaoGenerica;
      } else {
        throw erro('O ChatGPT não aceitou a imagem colada e não exibiu a opção de anexar arquivos.', 502);
      }
    }
    if (!escolha) {
      escolhaPromise = page.waitForEvent('filechooser', { timeout: 8000 }).catch(() => null);
      await opcaoUpload.click();
      escolha = await escolhaPromise;
    }
  }

  if (escolha) {
    await escolha.setFiles(upload);
  } else {
    // Compatibilidade com versões que não disparam filechooser, mas criam o
    // input correto somente depois de clicar na opção da interface.
    const inputAberto = composer.locator('input[type="file"][accept*="image" i], input[type="file"]').last();
    if (!(await inputAberto.count())) throw erro('O seletor de arquivos do ChatGPT não abriu.', 502);
    await inputAberto.setInputFiles(upload);
  }

  if (!(await aguardarAnexo(areaDeConfirmacao, anterior))) {
    const diagnostico = await page.evaluate(() => ({
      url: location.href,
      inputs: [...document.querySelectorAll('input[type="file"]')].map((node) => ({
        accept: node.getAttribute('accept') || '',
        files: [...(node.files || [])].map((file) => file.name),
        noFormulario: Boolean(node.closest('form')),
      })),
    })).catch(() => null);
    console.warn('[chatgpt-imagem] anexo não confirmado', diagnostico);
    throw erro(
      'A imagem de referência não foi anexada ao ChatGPT. O prompt não foi enviado; tente novamente.',
      502
    );
  }
}

async function executarGeracao({ sourceUrl, prompt, titulo, materia }) {
  const credentials = await credenciaisChatgpt();
  const upload = await imagemParaUpload(sourceUrl);
  let chromium;
  try {
    ({ chromium } = require(PLAYWRIGHT_PATH));
  } catch {
    throw erro('O módulo de navegador do gateway não está instalado.', 503);
  }

  const browser = await chromium.connectOverCDP(await websocketCdp());
  const context = browser.contexts()[0];
  if (!context) throw erro('O Chrome isolado não disponibilizou um perfil de navegação.', 503);

  const page = await context.newPage();
  try {
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    // O login feito em /claude vive no mesmo perfil do Chrome, então em geral
    // não há nada para reinjetar. Só usa a cópia salva como recuperação.
    if (!(await sessaoChatgptAtiva(page))) {
      const cookies = cookiesDoHeader(credentials.cookie);
      if (cookies.length) {
        await context.addCookies(cookies);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 });
      }
    }
    if (!(await sessaoChatgptAtiva(page)) || /auth\/login|log-in/i.test(page.url())) {
      throw erro('A sessão do ChatGPT expirou. Entre novamente pela página /claude.', 401);
    }

    const input = page.locator('#prompt-textarea:visible, textarea:visible, [contenteditable="true"]:visible').first();
    await input.waitFor({ state: 'visible', timeout: 20_000 });
    await anexarImagemNoComposer(page, input, upload);

    const pedido = String(prompt || '').trim().slice(0, MAX_PROMPT) || promptPadrao({ titulo, materia });
    await input.fill(pedido);
    const sendButton = page.locator(
      '[data-testid="send-button"]:not([disabled]), button[aria-label*="Send prompt" i]:not([disabled]), button[aria-label*="Enviar" i]:not([disabled])'
    ).first();
    try {
      await sendButton.waitFor({ state: 'visible', timeout: 30_000 });
      await sendButton.click();
    } catch {
      // A interface pode trocar o seletor; Enter mantém compatibilidade com
      // versões em que o botão não possui data-testid/aria-label estável.
      await page.waitForTimeout(1800);
      await input.press('Enter');
    }

    const assistant = page.locator('[data-message-author-role="assistant"]').last();
    await assistant.waitFor({ state: 'visible', timeout: 90_000 });
    const limite = Date.now() + 210_000;
    let src = '';
    while (Date.now() < limite && !src) {
      const imagens = assistant.locator('img');
      const total = await imagens.count();
      for (let i = total - 1; i >= 0; i -= 1) {
        const candidata = imagens.nth(i);
        const dados = await candidata.evaluate((img) => ({
          src: img.currentSrc || img.src || '',
          width: img.naturalWidth || 0,
          height: img.naturalHeight || 0,
        })).catch(() => null);
        if (dados?.src && dados.width >= 256 && dados.height >= 256) {
          src = dados.src;
          break;
        }
      }
      if (!src) await page.waitForTimeout(2000);
    }
    if (!src) {
      const resposta = String(await assistant.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      throw erro(
        resposta
          ? `O ChatGPT não devolveu uma imagem: ${resposta.slice(0, 240)}`
          : 'O ChatGPT não concluiu a imagem dentro do tempo esperado.',
        502
      );
    }
    const result = await baixarImagemDaPagina(page, src);
    return { ...result, prompt: pedido, model: CHATGPT_MODEL };
  } finally {
    await page.close().catch(() => {});
  }
}

async function gerarImagem(args) {
  if (geracaoAtiva) throw erro('Já existe uma imagem sendo gerada no ChatGPT. Aguarde a conclusão.', 409);
  geracaoAtiva = executarGeracao(args);
  try {
    return await geracaoAtiva;
  } finally {
    geracaoAtiva = null;
  }
}

module.exports = {
  gerarImagem,
  promptPadrao,
  // Exposto somente para validar a compatibilidade dos cookies do Chrome.
  cookiesDoHeader,
};
