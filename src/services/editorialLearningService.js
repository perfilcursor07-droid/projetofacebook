const EditorialAprendizados = require('../models/EditorialAprendizados');
const EditorialEstiloUsuario = require('../models/EditorialEstiloUsuario');
const axios = require('axios');
const { env } = require('../config/env');

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || env.deepseekModel || 'deepseek-v4-flash';

const MAX_TRECHO = 4000;
const DISTILL_EVERY = 3;
const MAX_MEMORIAS_CHAT = 20;

const PADRAO_FEEDBACK_CHAT =
  /\b(aprend[ae]|lembre|memorize|sempre|nunca|prefir|eu gosto|eu n[aã]o gosto|n[aã]o quero|quero que (?:sempre|nunca|n[aã]o|use|mantenha|evite)|quando eu|quando for|da pr[oó]xima|pare de|evite|n[aã]o invent|use a legenda|use o [aá]udio|use a transcri[cç][aã]o|mantenha a fonte|n[aã]o apague a fonte|ficou errado|nada a ver|n[aã]o foi isso)\b/i;

function normText(s) {
  return String(s || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sliceSafe(s, max = MAX_TRECHO) {
  const t = normText(s);
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1).trim()}…`;
}

function diffSignificativo(antes, depois) {
  const a = normText(antes);
  const b = normText(depois);
  if (a === b) return false;
  if (!a && b.length >= 40) return true;
  if (!b) return false;
  const len = Math.max(a.length, b.length, 1);
  let same = 0;
  const minLen = Math.min(a.length, b.length);
  for (let i = 0; i < minLen; i += 1) {
    if (a[i] === b[i]) same += 1;
  }
  const changedRatio = 1 - same / len;
  const absChange = Math.abs(a.length - b.length) + (a === b ? 0 : Math.max(40, Math.floor(len * 0.05)));
  // Heurística do plano: >8% ou >80 chars de mudança efetiva
  if (Math.abs(a.length - b.length) >= 80) return true;
  if (changedRatio >= 0.08) return true;
  // Comparação simples por palavras
  const wa = new Set(a.toLowerCase().split(/\s+/).filter((w) => w.length > 3));
  const wb = b.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  if (!wb.length) return false;
  let hit = 0;
  for (const w of wb) if (wa.has(w)) hit += 1;
  const overlap = hit / wb.length;
  return overlap < 0.92 || absChange >= 80;
}

function resumoDiff(antes, depois) {
  const a = normText(antes);
  const b = normText(depois);
  if (!a && b) return 'Texto criado/editado a partir do vazio';
  if (a && !b) return 'Texto removido';
  const delta = b.length - a.length;
  if (delta > 40) return `Expandiu (+${delta} chars)`;
  if (delta < -40) return `Enxugou (${delta} chars)`;
  return 'Reescreveu trechos mantendo tamanho parecido';
}

function cortarExemplo(texto, max = 420) {
  const t = normText(texto);
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1).trim()}…`;
}

/**
 * Registra aprendizado quando o humano altera título/matéria gerados pela IA.
 * @returns {Promise<{ registered: boolean, estilo?: object|null }>}
 */
async function registrarAprendizado({
  userId,
  matterId = null,
  tituloAntes = null,
  tituloDepois = null,
  materiaAntes = null,
  materiaDepois = null,
}) {
  const tituloMudou =
    tituloAntes != null &&
    tituloDepois != null &&
    normText(tituloAntes) !== normText(tituloDepois);
  const materiaMudou = diffSignificativo(materiaAntes, materiaDepois);

  if (!tituloMudou && !materiaMudou) {
    return { registered: false };
  }

  // Matéria precisa de mudança real; título sozinho só conta se também houver corpo alterado
  // ou título bem diferente (>15 chars delta / texto diferente)
  if (!materiaMudou && tituloMudou) {
    const ta = normText(tituloAntes);
    const td = normText(tituloDepois);
    if (Math.abs(ta.length - td.length) < 8 && ta.length > 0) {
      const wordsA = new Set(ta.toLowerCase().split(/\s+/));
      const wordsB = td.toLowerCase().split(/\s+/);
      let hit = 0;
      for (const w of wordsB) if (wordsA.has(w)) hit += 1;
      if (wordsB.length && hit / wordsB.length >= 0.7) {
        return { registered: false };
      }
    }
  }

  await EditorialAprendizados.create({
    user_id: userId,
    matter_id: matterId || null,
    titulo_antes: tituloMudou ? String(tituloAntes || '').slice(0, 300) : null,
    titulo_depois: tituloMudou ? String(tituloDepois || '').slice(0, 300) : null,
    materia_antes: materiaMudou ? sliceSafe(materiaAntes) : null,
    materia_depois: materiaMudou ? sliceSafe(materiaDepois) : null,
    diff_resumo: materiaMudou
      ? resumoDiff(materiaAntes, materiaDepois)
      : 'Ajustou o título',
  });

  const estilo = await EditorialEstiloUsuario.findByUser(userId);
  const total = Number(estilo?.total_edicoes || 0) + 1;
  const precisaDestilar = !estilo?.regras_estilo || total % DISTILL_EVERY === 0;

  await EditorialEstiloUsuario.upsert(userId, {
    total_edicoes: total,
    atualizado_em: new Date(),
    regras_estilo: estilo?.regras_estilo || null,
  });

  if (precisaDestilar && env.deepseekApiKey) {
    try {
      await atualizarRegrasEstilo(userId);
    } catch (err) {
      console.warn('[editorial-learning] destilar:', err.message);
    }
  }

  return { registered: true };
}

async function atualizarRegrasEstilo(userId) {
  if (!env.deepseekApiKey) return EditorialEstiloUsuario.findByUser(userId);
  const exemplos = await EditorialAprendizados.findRecentByUser(userId, 8);
  if (!exemplos.length) return EditorialEstiloUsuario.findByUser(userId);

  const blocos = exemplos
    .map((ex, i) => {
      const parts = [`Exemplo ${i + 1}:`];
      if (ex.titulo_antes || ex.titulo_depois) {
        parts.push(`Título IA: ${ex.titulo_antes || '—'}`);
        parts.push(`Título editado: ${ex.titulo_depois || '—'}`);
      }
      if (ex.materia_antes || ex.materia_depois) {
        parts.push(`Texto IA: ${cortarExemplo(ex.materia_antes, 500)}`);
        parts.push(`Texto editado: ${cortarExemplo(ex.materia_depois, 500)}`);
      }
      if (ex.diff_resumo) parts.push(`Nota: ${ex.diff_resumo}`);
      return parts.join('\n');
    })
    .join('\n\n');

  const body = {
    model: DEEPSEEK_MODEL,
    temperature: 0.35,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'Você analisa correções de um editor humano em matérias gospel para Facebook. Extraia padrões de ESTILO (não fatos das matérias). Responda JSON: {"regras":["bullet1",...]} com 8 a 12 bullets curtos em português sobre tom, tamanho, fechamento de fé, como citar cargos/pessoas, o que evitar, preferências de título.',
      },
      {
        role: 'user',
        content: `Com base nestas correções (IA → versão editada), liste as regras de estilo do editor:\n\n${blocos}`,
      },
    ],
  };
  if (String(DEEPSEEK_MODEL).includes('v4')) {
    body.thinking = { type: 'disabled' };
  }

  const { data } = await axios.post(DEEPSEEK_URL, body, {
    headers: {
      Authorization: `Bearer ${env.deepseekApiKey}`,
      'Content-Type': 'application/json',
    },
    timeout: 90_000,
  });

  const raw = data?.choices?.[0]?.message?.content || '';
  let regras = [];
  try {
    const parsed = JSON.parse(raw);
    regras = Array.isArray(parsed.regras) ? parsed.regras : [];
  } catch {
    regras = [];
  }

  const bullets = regras
    .map((r) => String(r || '').trim())
    .filter(Boolean)
    .slice(0, 12)
    .map((r) => (r.startsWith('-') || r.startsWith('•') ? r : `- ${r}`));

  const regrasTxt = bullets.length
    ? bullets.join('\n')
    : String(raw || '')
        .trim()
        .slice(0, 2000);

  const estilo = await EditorialEstiloUsuario.findByUser(userId);
  return EditorialEstiloUsuario.upsert(userId, {
    regras_estilo: regrasTxt || null,
    total_edicoes: Number(estilo?.total_edicoes || exemplos.length),
    atualizado_em: new Date(),
  });
}

function memoriasComoLista(valor) {
  return String(valor || '')
    .split(/\r?\n/)
    .map((linha) => linha.replace(/^\s*[-•*]\s*/, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, MAX_MEMORIAS_CHAT);
}

/**
 * Aprende preferências declaradas no chat e as mantém entre conversas.
 * Não guarda fatos, nomes da pauta nem instruções que servem só para uma matéria.
 */
async function registrarFeedbackDoChat({ userId, pedido, respostaAnterior = null }) {
  const texto = normText(pedido);
  if (!userId || texto.length < 8 || !PADRAO_FEEDBACK_CHAT.test(texto)) {
    return { registered: false };
  }
  if (!env.deepseekApiKey) return { registered: false, reason: 'sem_api' };

  const estilo = await EditorialEstiloUsuario.findByUser(userId);
  const atuais = memoriasComoLista(estilo?.preferencias_chat);
  const body = {
    model: DEEPSEEK_MODEL,
    temperature: 0.1,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `Você mantém a memória editorial de um usuário que produz matérias jornalísticas para Facebook e Instagram.
Retorne APENAS JSON: {"persistir":true|false,"memorias":["regra 1","regra 2"]}.

Objetivo: descobrir se a mensagem contém uma preferência duradoura sobre como a IA deve trabalhar e, se contiver, atualizar a memória existente.

Pode memorizar:
- tom, tamanho, estrutura, títulos e forma de citar fontes;
- regras de fidelidade a links, legendas, áudio, transcrição e imagens;
- erros que o usuário pede para nunca repetir;
- preferências de fluxo que devam valer em futuras matérias.

Não memorize:
- fatos, nomes, números ou opiniões relativos somente à pauta atual;
- pedidos isolados como "troque este título" ou "acrescente este parágrafo";
- conteúdo inventado pela resposta anterior;
- senhas, chaves, dados pessoais ou URLs.

Escreva cada memória como instrução curta, objetiva e reutilizável. Remova duplicatas. Se a nova preferência contrariar uma antiga, mantenha somente a mais recente. Máximo de ${MAX_MEMORIAS_CHAT} memórias.`,
      },
      {
        role: 'user',
        content: [
          `MEMÓRIA ATUAL:\n${atuais.length ? atuais.map((m) => `- ${m}`).join('\n') : '(vazia)'}`,
          respostaAnterior
            ? `RESPOSTA ANTERIOR DA IA (somente para entender a correção; não memorize fatos):\n${sliceSafe(respostaAnterior, 2500)}`
            : null,
          `NOVA MENSAGEM DO USUÁRIO:\n${texto.slice(0, 2500)}`,
          'Atualize a memória apenas se houver preferência duradoura.',
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
    ],
  };
  if (String(DEEPSEEK_MODEL).includes('v4')) body.thinking = { type: 'disabled' };

  const { data } = await axios.post(DEEPSEEK_URL, body, {
    headers: {
      Authorization: `Bearer ${env.deepseekApiKey}`,
      'Content-Type': 'application/json',
    },
    timeout: 90_000,
  });

  let parsed = {};
  try {
    parsed = JSON.parse(data?.choices?.[0]?.message?.content || '{}');
  } catch {
    return { registered: false, reason: 'resposta_invalida' };
  }
  if (parsed.persistir !== true) return { registered: false };

  const memorias = (Array.isArray(parsed.memorias) ? parsed.memorias : [])
    .map((regra) => String(regra || '').replace(/^\s*[-•*]\s*/, '').replace(/\s+/g, ' ').trim())
    .filter((regra) => regra.length >= 12)
    .slice(0, MAX_MEMORIAS_CHAT);
  if (!memorias.length) return { registered: false };

  const preferenciasChat = memorias.map((regra) => `- ${regra}`).join('\n');
  const atualizado = await EditorialEstiloUsuario.upsert(userId, {
    preferencias_chat: preferenciasChat,
    total_feedback_chat: Number(estilo?.total_feedback_chat || 0) + 1,
    ultima_memoria_chat_em: new Date(),
  });
  return { registered: true, memorias, estilo: atualizado };
}

/**
 * Contexto para injetar no prompt de geração.
 */
async function obterContextoAprendizado(userId) {
  if (!userId) return null;
  const [estilo, exemplos] = await Promise.all([
    EditorialEstiloUsuario.findByUser(userId),
    EditorialAprendizados.findRecentByUser(userId, 3),
  ]);

  if (!estilo?.regras_estilo && !estilo?.preferencias_chat && !exemplos.length) return null;

  return {
    regrasEstilo: estilo?.regras_estilo || null,
    preferenciasChat: estilo?.preferencias_chat || null,
    totalEdicoes: Number(estilo?.total_edicoes || 0),
    totalFeedbackChat: Number(estilo?.total_feedback_chat || 0),
    exemplos: (exemplos || []).map((ex) => ({
      tituloAntes: ex.titulo_antes,
      tituloDepois: ex.titulo_depois,
      materiaAntes: cortarExemplo(ex.materia_antes, 380),
      materiaDepois: cortarExemplo(ex.materia_depois, 380),
      diffResumo: ex.diff_resumo,
    })),
  };
}

function formatarContextoAprendizadoParaPrompt(ctx) {
  if (!ctx) return null;
  const parts = [
    'PADRÕES APRENDIDOS COM O EDITOR DESTE USUÁRIO (obrigatório seguir o estilo; NÃO copie o conteúdo dos exemplos):',
  ];
  if (ctx.regrasEstilo) {
    parts.push(String(ctx.regrasEstilo).slice(0, 2500));
  }
  if (ctx.preferenciasChat) {
    parts.push(
      [
        'MEMÓRIA EXPLÍCITA DAS CONVERSAS (seguir em todas as novas matérias):',
        String(ctx.preferenciasChat).slice(0, 3500),
        'Estas preferências nunca autorizam inventar fatos nem ignorar a fonte atual.',
      ].join('\n')
    );
  }
  if (Array.isArray(ctx.exemplos) && ctx.exemplos.length) {
    parts.push('EXEMPLOS DE CORREÇÃO (IA → versão editada pelo humano):');
    ctx.exemplos.forEach((ex, i) => {
      const linhas = [`${i + 1})`];
      if (ex.tituloAntes || ex.tituloDepois) {
        linhas.push(`Título antes: ${ex.tituloAntes || '—'}`);
        linhas.push(`Título depois: ${ex.tituloDepois || '—'}`);
      }
      if (ex.materiaAntes || ex.materiaDepois) {
        linhas.push(`Texto antes: ${ex.materiaAntes || '—'}`);
        linhas.push(`Texto depois: ${ex.materiaDepois || '—'}`);
      }
      parts.push(linhas.join('\n'));
    });
    parts.push('Use o estilo do DEPOIS (tom, ritmo, fechamento). Não copie fatos dos exemplos.');
  }
  return parts.join('\n\n');
}

module.exports = {
  registrarAprendizado,
  registrarFeedbackDoChat,
  atualizarRegrasEstilo,
  obterContextoAprendizado,
  formatarContextoAprendizadoParaPrompt,
  diffSignificativo,
  normText,
};
