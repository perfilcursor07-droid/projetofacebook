const sharp = require('sharp');
const { createWorker, OEM, PSM } = require('tesseract.js');
const idiomaPortugues = require('@tesseract.js-data/por');

const MAX_TEXTO_OCR = 12000;
const MAX_PIXELS = 28_000_000;

let workerPromise = null;
let filaOcr = Promise.resolve();

function limparTextoOcr(valor) {
  return String(valor || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[|]{2,}/g, '|')
    .trim()
    .slice(0, MAX_TEXTO_OCR);
}

function contarPalavras(texto) {
  return (String(texto || '').match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu) || []).filter(
    (palavra) => palavra.replace(/[^\p{L}\p{N}]/gu, '').length >= 2
  ).length;
}

async function obterWorker() {
  if (!workerPromise) {
    workerPromise = createWorker(idiomaPortugues.code, OEM.LSTM_ONLY, {
      langPath: idiomaPortugues.langPath,
      gzip: idiomaPortugues.gzip,
      cacheMethod: 'none',
      errorHandler: (err) => console.warn('[ocr-imagem] worker:', err?.message || err),
    })
      .then(async (worker) => {
        await worker.setParameters({
          tessedit_pageseg_mode: PSM.AUTO,
          preserve_interword_spaces: '1',
        });
        return worker;
      })
      .catch((err) => {
        workerPromise = null;
        throw err;
      });
  }
  return workerPromise;
}

async function prepararImagem(buffer) {
  const base = sharp(buffer, { failOn: 'error', limitInputPixels: MAX_PIXELS }).rotate();
  const meta = await base.metadata();
  const largura = Number(meta.width || 0);
  const altura = Number(meta.height || 0);
  if (!largura || !altura) {
    const err = new Error('Não consegui identificar as dimensões da imagem.');
    err.status = 422;
    throw err;
  }

  // OCR melhora quando prints pequenos são ampliados e fotos muito grandes são
  // reduzidas. Normalização dá contraste sem destruir cards coloridos.
  const alvo = largura < 1200 ? Math.min(2200, largura * 2) : Math.min(2400, largura);
  const processada = await base
    .resize({ width: alvo, withoutEnlargement: false, fit: 'inside' })
    .grayscale()
    .normalize()
    .sharpen({ sigma: 0.8 })
    .png({ compressionLevel: 6 })
    .toBuffer();

  return { processada, largura, altura, formato: meta.format || null };
}

async function executarOcr(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    const err = new Error('Escolha uma imagem para analisar.');
    err.status = 400;
    throw err;
  }

  const imagem = await prepararImagem(buffer);
  let worker;
  try {
    worker = await obterWorker();
    const resultado = await worker.recognize(imagem.processada);
    const texto = limparTextoOcr(resultado?.data?.text);
    const confianca = Math.max(0, Math.min(100, Math.round(Number(resultado?.data?.confidence) || 0)));
    const palavras = contarPalavras(texto);
    const caracteresUteis = (texto.match(/[\p{L}\p{N}]/gu) || []).length;
    const temTexto =
      palavras >= 5 &&
      caracteresUteis >= 24 &&
      (confianca >= 25 || (palavras >= 12 && caracteresUteis >= 70));

    return {
      temTexto,
      texto,
      confianca,
      palavras,
      largura: imagem.largura,
      altura: imagem.altura,
      formato: imagem.formato,
      truncado: texto.length >= MAX_TEXTO_OCR,
    };
  } catch (err) {
    // Um worker que falhou não deve contaminar os próximos uploads.
    if (worker) {
      try {
        await worker.terminate();
      } catch {
        /* ignore */
      }
    }
    workerPromise = null;
    throw err;
  }
}

/** Serializa OCRs: um único worker não deve receber recognize concorrente. */
function analisarTextoDaImagem(buffer) {
  const tarefa = filaOcr.then(() => executarOcr(buffer), () => executarOcr(buffer));
  filaOcr = tarefa.catch(() => undefined);
  return tarefa;
}

module.exports = {
  analisarTextoDaImagem,
  limparTextoOcr,
};
