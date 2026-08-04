/**
 * Leitura de documentos enviados no chat de matérias.
 * Hoje só PDF: o texto extraído entra como fonte factual para a IA escrever.
 */

/** Texto devolvido ao navegador (ele reenvia junto da mensagem). */
const MAX_CARACTERES = 20000;

function erro(mensagem, status = 400) {
  const err = new Error(mensagem);
  err.status = status;
  return err;
}

/** PDF real começa com "%PDF-" — barra arquivo renomeado. */
function pareceIntegridadePdf(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 4 && buffer.subarray(0, 5).toString('latin1') === '%PDF-';
}

/**
 * Normaliza o texto do PDF: tira caracteres de controle que o MySQL recusa,
 * junta espaços de sobra e preserva a quebra de parágrafo.
 */
function limparTextoDocumento(bruto) {
  return String(bruto || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function extrairTextoDePdf(buffer, { maxCaracteres = MAX_CARACTERES } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw erro('Arquivo vazio. Envie o PDF novamente.');
  }
  if (!pareceIntegridadePdf(buffer)) {
    throw erro('Este arquivo não é um PDF válido.');
  }

  const pdfParse = require('pdf-parse');
  let dados;
  try {
    dados = await pdfParse(buffer);
  } catch (err) {
    // PDF protegido por senha, corrompido ou com estrutura que a lib não abre.
    console.warn('[documentText] falha ao ler PDF:', err.message);
    throw erro('Não consegui abrir este PDF. Se ele tem senha, remova a proteção e envie de novo.');
  }

  const textoCompleto = limparTextoDocumento(dados?.text);
  if (textoCompleto.length < 40) {
    throw erro(
      'Este PDF não tem texto selecionável (parece digitalizado como imagem). Envie um PDF com texto ou cole o conteúdo no chat.'
    );
  }

  const limite = Math.max(1000, Number(maxCaracteres) || MAX_CARACTERES);
  return {
    texto: textoCompleto.slice(0, limite),
    caracteres: Math.min(textoCompleto.length, limite),
    caracteresOriginais: textoCompleto.length,
    truncado: textoCompleto.length > limite,
    paginas: Number(dados?.numpages) || null,
  };
}

module.exports = {
  extrairTextoDePdf,
  limparTextoDocumento,
  MAX_CARACTERES,
};
