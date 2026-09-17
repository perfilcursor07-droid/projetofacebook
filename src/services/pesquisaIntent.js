/** Intenção compartilhada entre a pesquisa do app e a chamada ao Claude. */
function pedidoSolicitaPesquisa(texto) {
  const normal = String(texto || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (/\b(?:nao\s+(?:pesquis|busc|busqu|procur)|sem\s+(?:pesquis|busca|internet))/i.test(normal)) return false;
  return /\b(?:pesquis\w*|busc\w*|busqu\w*|procur\w*|recent\w*|hoje|agora|atual\w*|ultim\w*)\b/i.test(normal);
}
module.exports = { pedidoSolicitaPesquisa };
