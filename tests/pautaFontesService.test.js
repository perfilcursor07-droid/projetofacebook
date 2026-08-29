const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizarEntrada,
  extrairMaisLidasDoHtml,
  extrairMaisLidasDoMarkdown,
} = require('../src/services/pautaFontesService');

test('extrai somente o bloco Mais lidas quando ele fica dentro da home', () => {
  const html = `
    <html><body>
      <nav>
        <a href="/politica/arquivo-antigo">Arquivo completo de notícias políticas do portal</a>
        <a href="/economia/cotacoes">Veja agora todas as cotações do mercado financeiro</a>
        <a href="/esporte/tabela">Confira a tabela completa do campeonato brasileiro</a>
      </nav>
      <section class="homepage-most-read">
        <h2>Mais Lidas</h2>
        <ol>
          <li><a href="/politica/noticia-a"><h3>Congresso inicia votação de projeto nesta sexta-feira</h3></a></li>
          <li><a href="/brasil/noticia-b"><h3>Temporal muda rotina de moradores em três cidades</h3></a></li>
          <li><a href="/mundo/noticia-c"><h3>Líderes anunciam acordo após reunião internacional</h3></a></li>
          <li><a href="/economia/noticia-d"><h3>Mercado reduz previsão para inflação deste ano</h3></a></li>
          <li><a href="/cultura/noticia-e"><h3>Festival confirma novas atrações para o próximo mês</h3></a></li>
        </ol>
      </section>
    </body></html>`;

  const itens = extrairMaisLidasDoHtml(html, {
    nome: 'Portal Teste',
    url: 'https://noticias.example.com/',
    localizacao: 'home',
    marcador: 'Mais lidas',
    limite: 10,
  });

  assert.equal(itens.length, 5);
  assert.equal(itens[0].titulo, 'Congresso inicia votação de projeto nesta sexta-feira');
  assert.equal(itens[0].url, 'https://noticias.example.com/politica/noticia-a');
  assert.equal(itens[4].posicao, 5);
  assert.equal(itens.some((item) => item.url.includes('arquivo-antigo')), false);
});

test('extrai ItemList em JSON-LD de uma página própria de mais populares', () => {
  const html = `
    <html><body><main><h1>Mais populares</h1></main>
      <script type="application/ld+json">
        {
          "@type": "ItemList",
          "itemListElement": [
            {"position": 1, "item": {"name": "Pesquisa revela mudança nos hábitos dos brasileiros", "url": "https://portal.example.com/brasil/pesquisa-habitos"}},
            {"position": 2, "item": {"name": "Senado aprova proposta após horas de debate", "url": "https://portal.example.com/politica/senado-proposta"}},
            {"position": 3, "item": {"name": "Cientistas registram fenômeno raro durante a madrugada", "url": "https://portal.example.com/ciencia/fenomeno-raro"}}
          ]
        }
      </script>
    </body></html>`;

  const itens = extrairMaisLidasDoHtml(html, {
    nome: 'Portal',
    url: 'https://portal.example.com/mais-lidas/',
    localizacao: 'pagina',
    limite: 10,
  });

  assert.equal(itens.length, 3);
  assert.match(itens[1].url, /senado-proposta$/);
});

test('extrai ranking guardado no estado JavaScript de um CMS', () => {
  const cache = {
    fetch: {
      'mais-lidas': {
        consulta: {
          data: {
            content_elements: [
              {
                headlines: { basic: 'Deputados analisam proposta durante sessão extraordinária' },
                canonical_url: '/politica/deputados-proposta',
                subheadlines: { basic: 'Texto passou pela comissão antes de chegar ao plenário.' },
              },
              {
                headlines: { basic: 'Chuva forte altera trânsito em diferentes regiões da capital' },
                canonical_url: '/brasil/chuva-transito-capital',
              },
              {
                headlines: { basic: 'Equipe confirma mudança para a próxima rodada do campeonato' },
                canonical_url: '/esportes/equipe-mudanca-rodada',
              },
            ],
          },
        },
      },
    },
  };
  const html = `<html><body><h1>Mais lidas</h1><script>Fusion.contentCache=${JSON.stringify(cache)};</script></body></html>`;
  const itens = extrairMaisLidasDoHtml(html, {
    nome: 'Jornal',
    url: 'https://jornal.example.com/mais-lidas/',
    localizacao: 'pagina',
    limite: 10,
  });
  assert.equal(itens.length, 3);
  assert.match(itens[0].url, /deputados-proposta$/);
});

test('fallback Markdown mantém apenas links editoriais do mesmo portal', () => {
  const markdown = `
    # Mais lidas
    [Governo anuncia novas medidas depois de reunião ministerial](https://site.example.com/politica/medidas)
    [Tempestade provoca mudanças em voos de quatro capitais](https://site.example.com/brasil/tempestade-voos)
    [Seleção divulga lista de convocados para os próximos jogos](https://site.example.com/esporte/convocados)
    [Conheça nossos planos e faça sua assinatura](https://assinatura.outro.example/planos)
  `;
  const itens = extrairMaisLidasDoMarkdown(markdown, {
    nome: 'Site',
    url: 'https://site.example.com/mais-lidas',
    limite: 10,
  });
  assert.equal(itens.length, 3);
});

test('normalização limita quantidade e bloqueia endereço local', () => {
  assert.equal(
    normalizarEntrada({ nome: 'Portal', url: 'https://portal.example.com/top', limite: 100 }).limite,
    30
  );
  assert.throws(
    () => normalizarEntrada({ nome: 'Interno', url: 'http://127.0.0.1:3000/admin' }),
    /locais ou privados/
  );
});
