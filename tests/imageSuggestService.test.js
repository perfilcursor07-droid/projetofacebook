const assert = require('node:assert/strict');
const test = require('node:test');

function substituirModulo(caminho, exports) {
  const resolvido = require.resolve(caminho);
  const anterior = require.cache[resolvido];
  require.cache[resolvido] = {
    id: resolvido,
    filename: resolvido,
    loaded: true,
    exports,
  };
  return () => {
    if (anterior) require.cache[resolvido] = anterior;
    else delete require.cache[resolvido];
  };
}

test('usa capas do Google News quando SerpApi e Brave estao indisponiveis', async (t) => {
  const servicePath = require.resolve('../src/services/imageSuggestService');
  const restaurar = [];
  let chamadasPexels = 0;

  restaurar.push(
    substituirModulo('axios', {
      get: async (url) => {
        const err = new Error(
          url.includes('serpapi')
            ? 'Your account has run out of searches.'
            : 'The provided subscription token is deactivated.'
        );
        err.response = {
          data: url.includes('serpapi')
            ? { error: err.message }
            : { error: { detail: err.message } },
        };
        throw err;
      },
    }),
    substituirModulo('../src/config/env', {
      env: {
        serpApiKey: 'serpapi-teste',
        serperApiKey: '',
        braveImageApiKey: 'brave-teste',
        pexelsApiKey: 'pexels-teste',
      },
    }),
    substituirModulo('../src/services/deepseekService', {}),
    substituirModulo('../src/services/pexelsService', {
      searchPhotos: async () => {
        chamadasPexels += 1;
        return { photos: [] };
      },
    }),
    substituirModulo('../src/services/providerHealth', {
      estaFora: () => false,
      registrarFalha: () => {},
      registrarSucesso: () => {},
    }),
    substituirModulo('../src/services/newsResearch', {
      buscarGoogleNewsRss: async () => [
        { titulo: 'Assembleia de Deus divulga comunicado', link: 'https://irrelevante.test/0', veiculo: 'Outro' },
        { titulo: 'Assembleia de Deus realiza culto', link: 'https://jornal.test/1', veiculo: 'Jornal 1' },
        { titulo: 'Igreja Assembleia reúne fiéis', link: 'https://portal.test/2', veiculo: 'Portal 2' },
      ],
    }),
    substituirModulo('../src/services/articleSource', {
      extrairMetadadosImagemArtigo: async (url) => ({
        url,
        titulo:
          url.endsWith('/0')
            ? 'Comunicado eleitoral 2026'
            : url.endsWith('/1')
              ? 'Assembleia de Deus realiza culto'
              : 'Igreja Assembleia reúne fiéis',
        imagem:
          url.endsWith('/0')
            ? 'https://cdn.irrelevante.test/comunicado.jpg'
            : url.endsWith('/1')
              ? 'https://cdn.jornal.test/culto.jpg'
              : 'https://cdn.portal.test/igreja.jpg',
        veiculo: url.endsWith('/0') ? 'Outro' : url.endsWith('/1') ? 'Jornal 1' : 'Portal 2',
      }),
    })
  );

  delete require.cache[servicePath];
  t.after(() => {
    delete require.cache[servicePath];
    restaurar.reverse().forEach((fn) => fn());
  });

  const service = require(servicePath);
  const result = await service.buscarImagensPorPalavra('igreja Assembleia de Deus', {
    limite: 2,
  });

  assert.equal(result.imagens.length, 2);
  assert.deepEqual(result.imagens.map((item) => item.origem), ['google-news', 'google-news']);
  assert.doesNotMatch(result.imagens.map((item) => item.titulo).join(' '), /Comunicado eleitoral/);
  assert.match(result.aviso, /Google News \(capa dos veículos\)/);
  assert.equal(chamadasPexels, 0);
});

test('Bing Images extrai murl do /images/async sem API key', async (t) => {
  const servicePath = require.resolve('../src/services/imageSuggestService');
  const restaurar = [];
  restaurar.push(
    substituirModulo('axios', {
      get: async (url) => {
        assert.match(String(url), /bing\.com\/images\/async/);
        return {
          data:
            'junk murl&quot;:&quot;https://cdn.igreja.test/culto.jpg&quot; ' +
            'turl&quot;:&quot;https://tse.mm.bing.net/th?id=abc&quot; ' +
            '&quot;t&quot;:&quot;Culto na igreja&quot; ' +
            'purl&quot;:&quot;https://jornal.test/culto&quot; more',
        };
      },
      post: async () => {
        throw new Error('Serper não deve ser chamado neste teste');
      },
    }),
    substituirModulo('../src/config/env', { env: {} }),
    substituirModulo('../src/services/deepseekService', {}),
    substituirModulo('../src/services/pexelsService', { searchPhotos: async () => ({ photos: [] }) }),
    substituirModulo('../src/services/providerHealth', {
      estaFora: () => false,
      registrarFalha: () => {},
      registrarSucesso: () => {},
    })
  );

  delete require.cache[servicePath];
  t.after(() => {
    delete require.cache[servicePath];
    restaurar.reverse().forEach((fn) => fn());
  });

  const service = require(servicePath);
  const imagens = await service.buscarBingImagens('culto igreja', { count: 8 });
  assert.equal(imagens.length, 1);
  assert.equal(imagens[0].origem, 'bing');
  assert.equal(imagens[0].url, 'https://cdn.igreja.test/culto.jpg');
  assert.match(imagens[0].thumbnail, /bing\.net/);
});
