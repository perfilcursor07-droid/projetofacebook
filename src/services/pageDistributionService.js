const db = require('../config/db');
const AiMatters = require('../models/AiMatters');
const Users = require('../models/Users');
const pages = require('./facebookPageResolver');
const editorial = require('./pageDistributionEditorial');
const { enqueue } = require('../workers/queue');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { env } = require('../config/env');

const SETTINGS = 'page_distribution_settings';
const TARGETS = 'page_distribution_targets';
const ITEMS = 'page_distribution_items';
function fail(message, status = 422) { const e = new Error(message); e.status = status; throw e; }
const touch = (patch) => ({ ...patch, updated_at: db.fn.now() });

async function ownedMatter(userId, id) {
  const matter = await AiMatters.findById(id);
  if (!matter || Number(matter.user_id) !== Number(userId)) fail('Matéria não encontrada.', 404);
  return matter;
}

async function settings(userId) {
  const [accountPages, config, targets, user] = await Promise.all([
    pages.pagesForUser(userId), db(SETTINGS).where({ user_id: userId }).first(),
    db(TARGETS).where({ user_id: userId }), Users.findById(userId),
  ]);
  return {
    enabled: Boolean(config?.enabled),
    defaults: { model: user?.marca_modelo_arte, primary: user?.marca_cor_primaria, secondary: user?.marca_cor_secundaria },
    pages: accountPages.map((p) => {
      const t = targets.find((t) => Number(t.page_id) === Number(p.id));
      const brand = editorial.parseBrand(t?.brand);
      return { id: p.id, name: p.page_name, selected: Boolean(t?.selected),
        brand: brand ? { model: brand.marca_modelo_arte, name: brand.marca_nome,
          primary: brand.marca_cor_primaria, secondary: brand.marca_cor_secundaria,
          footer: brand.marca_rodape, category: brand.marca_categoria } : null };
    }),
    models: require('./editorialCardModels').ART_MODELS.map(({ id, name }) => ({ id, name })),
  };
}

async function saveSettings(userId, body) {
  if (typeof body.enabled !== 'boolean' || !Array.isArray(body.pageIds)) fail('Configuração inválida.');
  const owned = await pages.pagesForUser(userId);
  const ids = [...new Set(body.pageIds.map(Number))];
  if (ids.some((id) => !owned.some((p) => Number(p.id) === id))) fail('Página não pertence à sua conta.', 403);
  const socialIds = owned.filter((p) => ids.includes(Number(p.id))).map((p) => p.page_id).filter(Boolean);
  if (new Set(socialIds).size !== socialIds.length) fail('Há dois cadastros da mesma página selecionados. Selecione apenas um.');
  if (body.enabled && !ids.length) fail('Selecione pelo menos uma página.');
  await db.transaction(async (trx) => {
    await trx(SETTINGS).insert({ user_id: userId, enabled: body.enabled }).onConflict('user_id').merge();
    await trx(TARGETS).where({ user_id: userId }).update({ selected: false });
    for (const id of ids) {
      await trx(TARGETS).insert({ user_id: userId, page_id: id, selected: true })
        .onConflict(['user_id', 'page_id']).merge(['selected']);
    }
  });
  return settings(userId);
}

async function copyPrivateMedia(relative, userId, category) {
  const root = path.resolve(env.storagePath);
  const source = path.resolve(root, String(relative));
  if (!source.startsWith(root + path.sep)) fail('Caminho de mídia inválido.');
  const rel = `${category}/user_${Number(userId)}_${crypto.randomUUID()}${path.extname(source)}`;
  const dest = path.resolve(root, rel);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(source, dest);
  return rel;
}

async function saveBrand(userId, pageId, body, logo) {
  if (!await pages.resolvePageForUser(userId, pageId)) fail('Página não encontrada.', 404);
  let brand = null;
  if (body.custom === true) {
    const user = await Users.findById(userId);
    const existing = await db(TARGETS).where({ user_id: userId, page_id: pageId }).first();
    const savedBrand = editorial.parseBrand(existing?.brand);
    brand = Object.fromEntries(Object.entries(user).filter(([k]) => k.startsWith('marca_')));
    if (!require('./editorialCardModels').isArtModel(body.model)) fail('Modelo inválido.');
    for (const key of ['primary', 'secondary']) {
      if (!/^#[a-f0-9]{6}$/i.test(body[key] || '')) fail('Cor inválida.');
    }
    Object.assign(brand, {
      marca_modelo_arte: body.model, marca_modelo_arte_secundario: null,
      marca_nome: String(body.name || '').trim().slice(0, 120),
      marca_cor_primaria: body.primary, marca_cor_secundaria: body.secondary,
      marca_rodape: String(body.footer || '').trim().slice(0, 160),
      marca_categoria: String(body.category || '').trim().slice(0, 80),
      logo_path: savedBrand?.logo_path || (user.logo_path ? await copyPrivateMedia(user.logo_path, userId, 'logos/distribuicao') : null),
    });
    const modelConfig = require('./brandModelConfig');
    brand.marca_modelo_config = modelConfig.withModelConfig(brand, body.model, {
      ...modelConfig.configForModel(brand, body.model),
      corPrimaria: body.primary, corSecundaria: body.secondary,
    });
    if (logo) {
      const relative = `logos/distribuicao/user_${Number(userId)}_${crypto.randomUUID()}.png`;
      const dest = path.resolve(env.storagePath, relative);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await require('sharp')(logo.buffer, { limitInputPixels: 16000000 }).rotate()
        .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).png().toFile(dest);
      brand.logo_path = relative;
    }
  } else if (body.custom !== false) fail('Configuração de marca inválida.');
  await db(TARGETS).insert({ user_id: userId, page_id: pageId, brand: brand ? JSON.stringify(brand) : null })
    .onConflict(['user_id', 'page_id']).merge(['brand']);
  return settings(userId);
}

async function selectedPages(userId) {
  const config = await settings(userId);
  if (!config.enabled) fail('Publicação em várias páginas está desativada.');
  const selected = config.pages.filter((p) => p.selected);
  if (!selected.length) fail('Selecione as páginas em Páginas.');
  return selected;
}

async function status(userId, sourceId) {
  const source = await ownedMatter(userId, sourceId);
  const config = await settings(userId);
  const variant = await db(ITEMS).where({ user_id: userId, matter_id: sourceId }).first();
  // Jobs run in the existing memory queue. A stopped process must not leave the UI spinning forever.
  const expired = new Date(Date.now() - 30 * 60 * 1000);
  await db(ITEMS).where({ user_id: userId, source_id: sourceId }).whereIn('state', ['queued', 'preparing'])
    .where('updated_at', '<', expired).update(touch({ state: 'error', error: 'Preparo interrompido. Clique em Preparar versões novamente.' }));
  await db(ITEMS).where({ user_id: userId, source_id: sourceId, state: 'sending' })
    .where('updated_at', '<', expired).update(touch({ state: 'uncertain', error: 'Envio sem confirmação. Confira na página antes de repetir.' }));
  const rows = await db(ITEMS).where({ user_id: userId, source_id: sourceId });
  const items = [];
  for (const row of rows) {
    const page = config.pages.find((p) => Number(p.id) === Number(row.page_id));
    if (!page) continue;
    const m = row.matter_id ? await ownedMatter(userId, row.matter_id) : null;
    items.push({ id: row.id, pageId: row.page_id, pageName: page.name, selected: page.selected,
      state: m?.publication_id && row.state === 'ready' ? 'sent' : row.state,
      error: row.error, matterId: m?.id, title: m?.titulo, text: m?.materia,
      image: m?.imagem_url, stale: row.fingerprint !== editorial.fingerprint(source) });
  }
  return { enabled: config.enabled && !variant, pages: config.pages.filter((p) => p.selected),
    sourceId: variant?.source_id || null, items };
}

async function prepare(userId, sourceId) {
  const source = await ownedMatter(userId, sourceId);
  if (await db(ITEMS).where({ user_id: userId, matter_id: sourceId }).first()) fail('Prepare as versões na matéria principal.');
  if (!String(source.materia || '').trim() || String(source.materia).startsWith('⏳')) fail('Espere a matéria ficar pronta.');
  const selected = await selectedPages(userId);
  const hash = editorial.fingerprint(source);
  for (const page of selected) {
    const key = { user_id: userId, source_id: sourceId, page_id: page.id };
    await db(ITEMS).insert(key).onConflict(['user_id', 'source_id', 'page_id']).ignore();
    const row = await db(ITEMS).where(key).first();
    if (['sending', 'sent', 'uncertain', 'preparing', 'queued'].includes(row.state)) continue;
    if (row.state === 'ready' && row.fingerprint === hash && row.matter_id) continue;
    // Compare-and-set: two clicks/processes cannot generate two children for the same destination.
    const claimed = await db(ITEMS).where({ id: row.id, state: row.state })
      .update(touch({ state: 'queued', error: null }));
    if (!claimed) continue;
    enqueue(`versão matéria ${sourceId} página ${page.id}`, async () => {
      if (!await db(ITEMS).where({ id: row.id, state: 'queued' }).update(touch({ state: 'preparing' }))) return;
      try {
        await prepareItem(userId, source, page, row, hash);
      } catch (err) {
        await db(ITEMS).where({ id: row.id }).update(touch({ state: 'error', error: String(err.message).slice(0, 500) }));
      }
    });
  }
  return status(userId, sourceId);
}

async function prepareItem(userId, source, page, row, hash) {
  if (!(await selectedPages(userId)).some((p) => p.id === page.id)) fail('Página removida da seleção.');
  const siblings = await db(ITEMS).where({ user_id: userId, source_id: source.id }).whereNotNull('matter_id');
  const previous = [source];
  for (const s of siblings) {
    if (s.id !== row.id) previous.push(await ownedMatter(userId, s.matter_id));
  }
  const variation = await editorial.generateVariation(source, { page_name: page.name }, previous);
  const target = await db(TARGETS).where({ user_id: userId, page_id: page.id }).first();
  const patch = { user_id: userId, facebook_page_id: page.id, ...variation,
    tipo_publicacao: source.tipo_publicacao, status: 'rascunho',
    distribution_brand: target?.brand || '{}', publication_id: null, scheduled_at: null, error_message: null,
  };
  for (const field of ['hashtags', 'fonte_titulo', 'fonte_url', 'fonte_resumo', 'fonte_credito', 'contexto_apuracao']) {
    if (source[field] != null) patch[field] = typeof source[field] === 'object' ? JSON.stringify(source[field]) : source[field];
  }
  let id = row.matter_id;
  if (id) {
    const existing = await ownedMatter(userId, id);
    if (existing.publication_id || existing.status === 'agendado') fail('Esta versão já foi enviada ou agendada.');
    await AiMatters.update(id, patch);
  } else {
    [id] = await AiMatters.create(patch);
    await db(ITEMS).where({ id: row.id }).update({ matter_id: id });
  }
  const photo = source.imagem_fonte_url || (!source.imagem_path ? source.imagem_url : null);
  if (source.tipo_publicacao === 'foto' && !photo) fail('Selecione a foto original na matéria principal para gerar as artes por página.');
  if (photo) {
    // Each variant owns its source file: deleting/reframing one never removes another's image.
    const artwork = require('./matterArtworkService');
    const buffer = await require('./editorialCardService').fetchImage(photo);
    const stored = await artwork.storeMatterSourceImage({ userId, matterId: id, buffer });
    await artwork.composeMatterArtwork({ userId, matterId: id, sourceUrl: stored.publicUrl, force: true });
  }
  if (source.tipo_publicacao === 'reel') {
    const clip = source.video_clip_id ? await require('../models/VideoClips').findById(source.video_clip_id) : null;
    const video = clip?.caminho_arquivo || source.video_path;
    if (!video) fail('Espere o vídeo ficar pronto.');
    await AiMatters.update(id, { video_path: await copyPrivateMedia(video, userId, 'distribuicao'), video_clip_id: null });
  }
  await db(ITEMS).where({ id: row.id }).update(touch({ state: 'ready', fingerprint: hash, error: null }));
}

async function publish(userId, sourceId) {
  const source = await ownedMatter(userId, sourceId);
  const selected = await selectedPages(userId);
  const rows = await db(ITEMS).where({ user_id: userId, source_id: sourceId }).whereIn('page_id', selected.map((p) => p.id));
  if (rows.length !== selected.length || rows.some((r) => !['ready', 'sending', 'sent', 'uncertain'].includes(r.state))) {
    fail('Prepare todas as versões antes de publicar.');
  }
  for (const row of rows.filter((r) => r.state === 'ready')) {
    if (row.fingerprint !== editorial.fingerprint(source)) fail('A matéria principal mudou. Prepare as versões novamente.');
    const child = await ownedMatter(userId, row.matter_id);
    if (Number(child.facebook_page_id) !== Number(row.page_id)) fail('Destino da versão foi alterado. Revise a página.');
    if (child.status === 'agendado') fail('Uma versão está agendada. Cancele o agendamento antes de publicar o grupo.');
  }
  for (const row of rows.filter((r) => r.state === 'ready')) {
    const claimed = await db(ITEMS).where({ id: row.id, state: 'ready' }).update(touch({ state: 'sending' }));
    if (!claimed) continue;
    enqueue(`publicar matéria ${sourceId} página ${row.page_id}`, async () => {
      try {
        const active = await db(ITEMS).where({ id: row.id, state: 'sending' }).first();
        if (!active) return;
        if (!(await selectedPages(userId)).some((p) => Number(p.id) === Number(row.page_id))) fail('Destino desativado antes do envio.');
        const child = await ownedMatter(userId, row.matter_id);
        if (!child.publication_id) {
          if (Number(child.facebook_page_id) !== Number(row.page_id) || child.status === 'agendado') fail('Versão alterada antes do envio; revise no editor.');
          const result = await require('./materiaIaService').publicarMateria(userId, child.id, {
            sync: true, facebook_page_id: row.page_id, publicar_facebook: true,
            publicar_instagram: false, publicar_x: false,
            distributionClaim: row.id,
          });
          if (!result.postId && !result.fbPostUrl) fail('Provedor não confirmou o ID do envio. Confira na página antes de repetir.');
        }
        await db(ITEMS).where({ id: row.id }).update(touch({ state: 'sent', error: null }));
      } catch (err) {
        // A timeout may mean the provider accepted the post. Never automatically resend it.
        await db(ITEMS).where({ id: row.id }).update(touch({ state: 'uncertain', error: String(err.message).slice(0, 500) }));
      }
    });
  }
  return status(userId, sourceId);
}

module.exports = { settings, saveSettings, saveBrand, status, prepare, publish };
