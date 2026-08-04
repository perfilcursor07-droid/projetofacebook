/**
 * Publicação em Grupos do Facebook via Ayrshare.
 *
 * Modelo: cada grupo é conectado no painel do Ayrshare (Social Accounts) e
 * recebe uma Profile-Key própria — igual ao que já é feito com as Páginas.
 * Publicar em um grupo = publishToFacebook usando a Profile-Key do grupo.
 */
const ayrshareService = require('./ayrshareService');
const FacebookGroups = require('../models/FacebookGroups');

function assertAyrshare() {
  if (!ayrshareService.isConfigured()) {
    const err = new Error(
      'Publicação em grupos exige o Ayrshare configurado (AYRSHARE_API_KEY no .env).'
    );
    err.status = 400;
    throw err;
  }
}

/**
 * Publica um texto/imagem em vários grupos selecionados.
 * Não interrompe no primeiro erro: tenta todos e devolve o relatório.
 *
 * @param {number} userId
 * @param {{ texto: string, imagemUrl?: string|null, filePath?: string|null,
 *           grupoIds: number[] }} opts
 * @returns {Promise<{ enviados: object[], falhas: object[], semChave: object[] }>}
 */
async function publicarNosGrupos(userId, { texto, imagemUrl = null, filePath = null, grupoIds = [] }) {
  assertAyrshare();

  const conteudo = String(texto || '').trim();
  if (!conteudo && !imagemUrl && !filePath) {
    const err = new Error('Nada para publicar: envie texto ou imagem.');
    err.status = 400;
    throw err;
  }

  const grupos = await FacebookGroups.findByIds(userId, grupoIds);
  if (!grupos.length) {
    const err = new Error('Selecione ao menos um grupo válido.');
    err.status = 400;
    throw err;
  }

  const enviados = [];
  const falhas = [];
  const semChave = [];

  for (const grupo of grupos) {
    if (!grupo.ativo) continue;
    const profileKey = String(grupo.ayrshare_profile_key || '').trim();

    // Sem Profile-Key não dá para postar: o grupo precisa estar conectado no Ayrshare.
    if (!profileKey) {
      semChave.push({ id: grupo.id, nome: grupo.nome });
      await FacebookGroups.registrarPost(grupo.id, {
        erro: 'Grupo sem Profile-Key do Ayrshare. Conecte o grupo no painel e informe a chave.',
      });
      continue;
    }

    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await ayrshareService.publishToFacebook({
        post: conteudo,
        imageUrl: imagemUrl,
        filePath,
        profileKey,
      });
      // eslint-disable-next-line no-await-in-loop
      await FacebookGroups.registrarPost(grupo.id, { erro: null });
      enviados.push({
        id: grupo.id,
        nome: grupo.nome,
        postUrl: res.postUrl || null,
        postId: res.id || null,
      });
    } catch (err) {
      const msg = ayrshareService.apiErrorMessage(err) || err.message || 'Falha ao publicar';
      // eslint-disable-next-line no-await-in-loop
      await FacebookGroups.registrarPost(grupo.id, { erro: msg });
      falhas.push({ id: grupo.id, nome: grupo.nome, erro: msg });
    }
  }

  return { enviados, falhas, semChave };
}

module.exports = { publicarNosGrupos, assertAyrshare };
