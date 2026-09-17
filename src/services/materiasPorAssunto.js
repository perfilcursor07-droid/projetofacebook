/** Planeja pautas com evidência literal e escreve cada matéria separadamente. */
async function gerarPorAssunto({ material, limite, planejar, escrever, onPasso = () => {} }) {
  const raw = await planejar(material, limite);
  let plano;
  try {
    plano = JSON.parse(String(raw).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim());
  } catch {
    throw new Error('Não foi possível organizar os assuntos do vídeo. Tente novamente.');
  }
  const normalizar = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const base = normalizar(material);
  const vistos = new Set();
  const assuntos = (Array.isArray(plano.assuntos) ? plano.assuntos : []).filter((a) => {
    const tema = normalizar(a?.tema);
    const evidencia = normalizar(a?.evidencia);
    if (!tema || vistos.has(tema) || evidencia.length < 30 || !base.includes(evidencia)) return false;
    vistos.add(tema);
    return true;
  }).slice(0, Math.min(5, Math.max(1, limite)));
  if (!assuntos.length) throw new Error('Não encontrei assuntos com trechos verificáveis no conteúdo extraído. Tente outro vídeo ou forneça a transcrição.');
  onPasso(`${assuntos.length} assunto(s) identificado(s) no conteúdo disponível.`);
  const partes = [];
  for (const [i, assunto] of assuntos.entries()) {
    onPasso(`Escrevendo matéria ${i + 1} de ${assuntos.length}: ${assunto.tema}`);
    const texto = await escrever(assunto, assuntos, i);
    if (!String(texto || '').trim()) throw new Error(`A matéria ${i + 1} não foi gerada. Tente novamente.`);
    partes.push(`${assuntos.length > 1 ? `### MATÉRIA ${i + 1}\n` : ''}${texto}`);
  }
  return partes.join('\n\n');
}
module.exports = { gerarPorAssunto };
