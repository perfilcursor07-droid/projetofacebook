/* Usa os resultados reais que voltaram errados e verifica se agora sao barrados. */
const nr = require('./src/services/newsResearch');

let ok = true;
const diz = (cond, nome) => {
  if (!cond) ok = false;
  console.log((cond ? 'OK   ' : 'FALHA') + ' ' + nome);
};

console.log('--- data extraida do texto do post (antes: 0) ---');
const casos = [
  ['6:40 PM · Jul 28, 2025 · · · 54.8K Views', 2025],
  ['3:22 PM · May 18, 2017 · 21 · 87 · 207', 2017],
  ['Publicado em 28 de julho de 2025', 2025],
  ['há 3 horas', new Date().getFullYear()],
  ['2 days ago', new Date().getFullYear()],
];
for (const [texto, anoEsperado] of casos) {
  const ts = nr.extrairDataDeTexto(texto);
  const ano = ts ? new Date(ts).getFullYear() : 0;
  diz(ano === anoEsperado, `"${texto.slice(0, 32)}…" -> ${ano}`);
}

console.log('\n--- post real x perfil/login ---');
const urls = [
  ['https://x.com/PastorMalafaia/status/1234567890', true],
  ['https://www.instagram.com/p/Cabc123/', true],
  ['https://www.instagram.com/silasmalafaia', false],
  ['https://www.instagram.com/', false],
  ['https://www.facebook.com', false],
  ['https://www.facebook.com/SilasMalafaia/posts/123', true],
  ['https://www.tiktok.com/@user/video/123', true],
  ['https://www.youtube.com/watch?v=abc', true],
];
for (const [u, esperado] of urls) {
  diz(nr.ehPostSocial(u) === esperado, `${esperado ? 'aceita' : 'barra '} ${u}`);
}

console.log('\n--- texto sem conteudo ---');
const textos = [
  ['We cannot provide a description for this page right now', true],
  ['Explore the things you love · Log in to Facebook · English (UK)', true],
  ['4M followers, 140 following, 12K posts – Pastor Silas Malafaia', false],
  ['ACORDA, BRASIL! A VERDADE DOI! Depois nao diga que nao avisei. Minha paciencia tem limite.', false],
];
for (const [t, inutil] of textos) {
  diz(nr.textoDeBuscaInutil(t) === inutil, `${inutil ? 'barra ' : 'aceita'} "${t.slice(0, 40)}…"`);
}

console.log('\nRESULTADO:', ok ? 'OK' : 'FALHOU');
process.exitCode = ok ? 0 : 1;
