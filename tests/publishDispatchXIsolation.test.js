const test = require('node:test');
const assert = require('node:assert/strict');

const { env } = require('../src/config/env');
const ayrshareService = require('../src/services/ayrshareService');
const pageResolver = require('../src/services/facebookPageResolver');
const publishDispatch = require('../src/services/publishDispatch');

test('Meta e X usam chamadas, textos e resultados independentes', async () => {
  const originals = {
    provider: env.postpulse.publishProvider,
    configured: ayrshareService.isConfigured,
    byo: ayrshareService.isTwitterByoConfigured,
    publish: ayrshareService.publishToFacebook,
    resolvePage: pageResolver.resolvePageForUser,
  };
  const calls = [];

  try {
    env.postpulse.publishProvider = 'ayrshare';
    ayrshareService.isConfigured = () => true;
    ayrshareService.isTwitterByoConfigured = () => true;
    pageResolver.resolvePageForUser = async () => ({
      id: 9,
      page_id: '123',
      page_name: 'Página teste',
      ayrshare_profile_key: 'profile-key',
      instagram_ativo: true,
      x_ativo: true,
    });
    ayrshareService.publishToFacebook = async (payload) => {
      calls.push(payload);
      if (payload.publicarX) {
        return {
          post_id: 'ayrshare:x-submit',
          x_publicado: true,
          x_post_id: 'x-native',
          x_post_url: 'https://x.com/test/status/1',
        };
      }
      return {
        post_id: 'ayrshare:meta-submit',
        instagram_publicado: true,
        instagram_post_id: 'ig-native',
      };
    };

    const result = await publishDispatch.publishContent({
      userId: 1,
      page: { id: 9, page_id: '123', page_name: 'Página teste' },
      tipo: 'foto',
      filePath: __filename,
      texto: 'Legenda completa de Facebook e Instagram',
      textoX: 'Resumo exclusivo do X',
      publicarFacebook: true,
      publicarInstagram: true,
      publicarX: true,
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].post, 'Legenda completa de Facebook e Instagram');
    assert.equal(calls[0].publicarFacebook, true);
    assert.equal(calls[0].publicarInstagram, true);
    assert.equal(calls[0].publicarX, false);
    assert.equal(calls[1].post, 'Resumo exclusivo do X');
    assert.equal(calls[1].publicarFacebook, false);
    assert.equal(calls[1].publicarInstagram, false);
    assert.equal(calls[1].publicarX, true);
    assert.equal(result.post_id, 'ayrshare:meta-submit');
    assert.equal(result.instagram_publicado, true);
    assert.equal(result.x_publicado, true);
    assert.equal(result.x_post_url, 'https://x.com/test/status/1');
  } finally {
    env.postpulse.publishProvider = originals.provider;
    ayrshareService.isConfigured = originals.configured;
    ayrshareService.isTwitterByoConfigured = originals.byo;
    ayrshareService.publishToFacebook = originals.publish;
    pageResolver.resolvePageForUser = originals.resolvePage;
  }
});

test('falha exclusiva do X nao derruba publicacao Meta bem-sucedida', async () => {
  const originals = {
    provider: env.postpulse.publishProvider,
    configured: ayrshareService.isConfigured,
    byo: ayrshareService.isTwitterByoConfigured,
    publish: ayrshareService.publishToFacebook,
    resolvePage: pageResolver.resolvePageForUser,
  };

  try {
    env.postpulse.publishProvider = 'ayrshare';
    ayrshareService.isConfigured = () => true;
    ayrshareService.isTwitterByoConfigured = () => true;
    pageResolver.resolvePageForUser = async () => ({
      id: 9,
      page_id: '123',
      page_name: 'Página teste',
      ayrshare_profile_key: 'profile-key',
      instagram_ativo: true,
      x_ativo: true,
    });
    ayrshareService.publishToFacebook = async (payload) => {
      if (payload.publicarX) throw new Error('X recusou a imagem');
      return { post_id: 'ayrshare:meta-ok', instagram_publicado: true };
    };

    const result = await publishDispatch.publishContent({
      userId: 1,
      page: { id: 9, page_id: '123', page_name: 'Página teste' },
      tipo: 'foto',
      filePath: __filename,
      texto: 'Legenda Meta',
      textoX: 'Resumo X',
      publicarFacebook: true,
      publicarInstagram: true,
      publicarX: true,
    });

    assert.equal(result.post_id, 'ayrshare:meta-ok');
    assert.equal(result.instagram_publicado, true);
    assert.equal(result.x_publicado, false);
    assert.equal(result.x_erro, 'X recusou a imagem');
  } finally {
    env.postpulse.publishProvider = originals.provider;
    ayrshareService.isConfigured = originals.configured;
    ayrshareService.isTwitterByoConfigured = originals.byo;
    ayrshareService.publishToFacebook = originals.publish;
    pageResolver.resolvePageForUser = originals.resolvePage;
  }
});

test('erro de upload da imagem no X faz uma unica tentativa somente com texto', async () => {
  const originals = {
    provider: env.postpulse.publishProvider,
    configured: ayrshareService.isConfigured,
    byo: ayrshareService.isTwitterByoConfigured,
    publish: ayrshareService.publishToFacebook,
    resolvePage: pageResolver.resolvePageForUser,
  };
  const xCalls = [];

  try {
    env.postpulse.publishProvider = 'ayrshare';
    ayrshareService.isConfigured = () => true;
    ayrshareService.isTwitterByoConfigured = () => true;
    pageResolver.resolvePageForUser = async () => ({
      id: 9,
      page_id: '123',
      page_name: 'Página teste',
      ayrshare_profile_key: 'profile-key',
      instagram_ativo: true,
      x_ativo: true,
    });
    ayrshareService.publishToFacebook = async (payload) => {
      if (!payload.publicarX) return { post_id: 'ayrshare:meta-ok' };
      xCalls.push(payload);
      if (payload.filePath || payload.imageUrl) {
        throw new Error(
          'Upload Error: Please check the media file size, dimensions, and content-type.'
        );
      }
      return {
        post_id: 'ayrshare:x-text-ok',
        x_publicado: true,
        x_post_id: 'x-text-native',
        x_post_url: 'https://x.com/test/status/2',
      };
    };

    const result = await publishDispatch.publishContent({
      userId: 1,
      page: { id: 9, page_id: '123', page_name: 'Página teste' },
      tipo: 'foto',
      filePath: __filename,
      texto: 'Legenda Meta',
      textoX: 'Resumo X',
      publicarFacebook: true,
      publicarInstagram: false,
      publicarX: true,
    });

    assert.equal(xCalls.length, 2);
    assert.equal(Boolean(xCalls[0].filePath || xCalls[0].imageUrl), true);
    assert.equal(xCalls[1].filePath, null);
    assert.equal(xCalls[1].imageUrl, null);
    assert.equal(result.post_id, 'ayrshare:meta-ok');
    assert.equal(result.x_publicado, true);
    assert.equal(result.x_post_url, 'https://x.com/test/status/2');
    assert.match(result.x_erro, /publicou somente o texto/);
  } finally {
    env.postpulse.publishProvider = originals.provider;
    ayrshareService.isConfigured = originals.configured;
    ayrshareService.isTwitterByoConfigured = originals.byo;
    ayrshareService.publishToFacebook = originals.publish;
    pageResolver.resolvePageForUser = originals.resolvePage;
  }
});

test('configuracao ausente do X vira aviso quando Meta foi publicado', async () => {
  const originals = {
    provider: env.postpulse.publishProvider,
    configured: ayrshareService.isConfigured,
    byo: ayrshareService.isTwitterByoConfigured,
    publish: ayrshareService.publishToFacebook,
    resolvePage: pageResolver.resolvePageForUser,
  };

  try {
    env.postpulse.publishProvider = 'ayrshare';
    ayrshareService.isConfigured = () => true;
    ayrshareService.isTwitterByoConfigured = () => false;
    pageResolver.resolvePageForUser = async () => ({
      id: 9,
      page_id: '123',
      page_name: 'Página teste',
      ayrshare_profile_key: 'profile-key',
      instagram_ativo: true,
      x_ativo: true,
    });
    ayrshareService.publishToFacebook = async (payload) => {
      assert.equal(payload.publicarX, false);
      return { post_id: 'ayrshare:meta-ok', instagram_publicado: true };
    };

    const result = await publishDispatch.publishContent({
      userId: 1,
      page: { id: 9, page_id: '123', page_name: 'Página teste' },
      tipo: 'foto',
      filePath: __filename,
      texto: 'Legenda Meta',
      textoX: 'Resumo X',
      publicarFacebook: true,
      publicarInstagram: true,
      publicarX: true,
    });

    assert.equal(result.post_id, 'ayrshare:meta-ok');
    assert.equal(result.instagram_publicado, true);
    assert.equal(result.x_publicado, false);
    assert.match(result.x_erro, /configure AYRSHARE_X_API_KEY/);
  } finally {
    env.postpulse.publishProvider = originals.provider;
    ayrshareService.isConfigured = originals.configured;
    ayrshareService.isTwitterByoConfigured = originals.byo;
    ayrshareService.publishToFacebook = originals.publish;
    pageResolver.resolvePageForUser = originals.resolvePage;
  }
});
