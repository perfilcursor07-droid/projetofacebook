/**
 * Circuit breaker simples para provedores externos.
 *
 * Quando um provedor responde "sem créditos", "quota esgotada" ou 403 em
 * sequência, continuar chamando só queima tempo: cada tentativa custa DNS +
 * conexão + timeout. Isso é o que fazia a busca de pautas rodar por minutos.
 * Aqui o provedor fica marcado como fora do ar por um tempo e as chamadas
 * seguintes nem saem.
 */
const PAUSA_PADRAO_MS = 10 * 60 * 1000;
const PAUSA_LONGA_MS = 60 * 60 * 1000;
const FALHAS_PARA_PAUSAR = 3;
const JANELA_FALHAS_MS = 2 * 60 * 1000;

const estado = new Map();

function agora() {
  return Date.now();
}

function registro(provedor) {
  const chave = String(provedor || '').trim().toLowerCase();
  if (!estado.has(chave)) {
    estado.set(chave, { falhas: 0, primeiraFalhaEm: 0, pausadoAte: 0, motivo: null });
  }
  return estado.get(chave);
}

/** O provedor está pausado agora? */
function estaFora(provedor) {
  const r = registro(provedor);
  if (!r.pausadoAte) return false;
  if (agora() >= r.pausadoAte) {
    r.pausadoAte = 0;
    r.falhas = 0;
    r.motivo = null;
    return false;
  }
  return true;
}

/** Motivo e quando volta — para explicar na tela em vez de só falhar. */
function status(provedor) {
  const r = registro(provedor);
  return {
    fora: estaFora(provedor),
    motivo: r.motivo,
    voltaEm: r.pausadoAte ? new Date(r.pausadoAte).toISOString() : null,
  };
}

/** Texto de erro que indica provedor esgotado (pausa longa, não adianta insistir). */
function pareceSemCredito(mensagem) {
  const t = String(mensagem || '').toLowerCase();
  return (
    t.includes('not enough credits') ||
    t.includes('out of credits') ||
    t.includes('run out of searches') ||
    t.includes('sem créditos') ||
    t.includes('sem creditos') ||
    t.includes('quota') ||
    t.includes('insufficient')
  );
}

/**
 * Registra falha. Sem crédito pausa na hora; erros comuns só pausam depois de
 * algumas falhas seguidas, para não desligar o provedor por um 403 isolado.
 */
function registrarFalha(provedor, motivo, { pausaMs = null } = {}) {
  const r = registro(provedor);
  const texto = String(motivo || '').slice(0, 200);

  if (pareceSemCredito(texto)) {
    r.pausadoAte = agora() + (pausaMs || PAUSA_LONGA_MS);
    r.motivo = texto || 'sem créditos';
    r.falhas = 0;
    console.warn(`[provider-health] ${provedor} pausado por 60min: ${r.motivo}`);
    return true;
  }

  if (!r.primeiraFalhaEm || agora() - r.primeiraFalhaEm > JANELA_FALHAS_MS) {
    r.primeiraFalhaEm = agora();
    r.falhas = 0;
  }
  r.falhas += 1;
  if (r.falhas >= FALHAS_PARA_PAUSAR) {
    r.pausadoAte = agora() + (pausaMs || PAUSA_PADRAO_MS);
    r.motivo = texto || 'falhas seguidas';
    r.falhas = 0;
    console.warn(`[provider-health] ${provedor} pausado por 10min: ${r.motivo}`);
    return true;
  }
  return false;
}

/** Chamada bem-sucedida zera o contador. */
function registrarSucesso(provedor) {
  const r = registro(provedor);
  r.falhas = 0;
  r.primeiraFalhaEm = 0;
}

/** Libera manualmente (usado em testes e ao trocar chave no .env). */
function liberar(provedor) {
  if (provedor) estado.delete(String(provedor).trim().toLowerCase());
  else estado.clear();
}

/** Lista o que está pausado — entra nos avisos da tela. */
function pausados() {
  const saida = [];
  for (const [nome] of estado) {
    if (estaFora(nome)) saida.push({ provedor: nome, ...status(nome) });
  }
  return saida;
}

module.exports = {
  estaFora,
  status,
  registrarFalha,
  registrarSucesso,
  liberar,
  pausados,
  pareceSemCredito,
};
