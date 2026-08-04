const fs = require('fs');
const path = require('path');

const arquivo = path.join(__dirname, 'src', 'services', 'materiaChatService.js');
let src = fs.readFileSync(arquivo, 'utf8');

const marcador = 'function interpretarResposta(conteudo) {';
const idx = src.indexOf(marcador);
if (idx < 0) { console.error('nao achou funcao'); process.exit(1); }

// Acha o fechamento: chave no nível 0
const depois = src.slice(idx);
let abriu = 0;
let fim = -1;
for (let i = 0; i < depois.length; i++) {
  if (depois[i] === '{') abriu++;
  if (depois[i] === '}') { abriu--; if (abriu === 0) { fim = i + 1; break; } }
}
if (fim < 0) { console.error('nao achou fim da funcao'); process.exit(1); }

const novaFuncao = [
  'function interpretarResposta(conteudo) {',
  "  const { extrairHashtagsDoTexto } = require('./editorialGuidelinesFb');",
  "  const bruto = String(conteudo || '').trim();",
  '  if (!bruto) return { ehMateria: false, titulo: null, corpo: \'\', hashtags: [] };',
  '',
  '  const { body, tags } = extrairHashtagsDoTexto(bruto);',
  '',
  '  // Remove preâmbulo conversacional antes da matéria (ex.: "A matéria é sobre..." + "---")',
  "  let textoUtil = String(body || '');",
  '  const separadorIdx = textoUtil.search(/\\n-{3,}\\s*\\n/);',
  '  if (separadorIdx > -1) {',
  '    const antesSep = textoUtil.slice(0, separadorIdx).trim();',
  '    const depoisSep = textoUtil.slice(separadorIdx).replace(/^[\\s\\-]+/, \'\').trim();',
  '    if (antesSep.length < 600 && depoisSep.length > 400) {',
  '      textoUtil = depoisSep;',
  '    }',
  '  }',
  '',
  "  const linhas = textoUtil.split('\\n').map((l) => l.trim());",
  "  const primeira = linhas.find((l) => l.length > 0) || '';",
  '  const restoTexto = textoUtil.slice(textoUtil.indexOf(primeira) + primeira.length).trim();',
  '  const paragrafos = restoTexto.split(/\\n\\s*\\n/).filter((p) => p.trim().length > 0);',
  '',
  '  const tituloLimpo = primeira',
  '    .replace(/^#{1,6}\\s*/, \'\')',
  '    .replace(/^\\*+|\\*+$/g, \'\')',
  '    .replace(/^[\\u201c\\u201d\\u201e\\u2018\\u2019"\\']+|[\\u201c\\u201d\\u201e\\u2018\\u2019"\\']+$/g, \'\')',
  '    .trim();',
  '',
  '  // Recado da checagem nunca é matéria (não pode virar rascunho)',
  "  const ehRecadoDeChecagem = /^n[ãa]o achei confirma/i.test(tituloLimpo);",
  '',
  '  const ehMateria =',
  '    !ehRecadoDeChecagem &&',
  '    restoTexto.length >= 400 &&',
  '    paragrafos.length >= 2 &&',
  '    tituloLimpo.length >= 15 &&',
  '    tituloLimpo.length <= 200;',
  '',
  '  return {',
  '    ehMateria,',
  '    titulo: ehMateria ? tituloLimpo.slice(0, 180) : null,',
  '    corpo: ehMateria ? restoTexto : body,',
  '    hashtags: tags.slice(0, 6),',
  '  };',
  '}',
].join('\n');

src = src.slice(0, idx) + novaFuncao + src.slice(idx + fim);
fs.writeFileSync(arquivo, src, 'utf8');

// Verifica
const check = fs.readFileSync(arquivo, 'utf8');
const temSeparador = check.includes('separadorIdx');
const temPreambulo = check.includes('preâmbulo conversacional');
console.log('substituicao ok:', temSeparador && temPreambulo);
