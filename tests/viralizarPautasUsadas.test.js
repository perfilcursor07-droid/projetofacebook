const test = require('node:test');
const assert = require('node:assert/strict');

const AiMatters = require('../src/models/AiMatters');
const viralizarService = require('../src/services/viralizarService');

test('radar oculta pauta já agendada mesmo quando a manchete foi reescrita', async () => {
  const original = AiMatters.findUsedReferencesByUser;
  AiMatters.findUsedReferencesByUser = async () => [
    {
      id: 3178,
      titulo: 'Igreja evangélica de SC entra na mira do [[MP]] após atos no 7 de setembro',
      fonte_titulo: null,
      fonte_url: 'https://site.test/noticia-sc',
      status: 'agendado',
      publication_id: null,
      facebook_page_id: 17,
    },
  ];

  try {
    const resultado = await viralizarService.sincronizarPautasUsadas({
      userId: 9,
      facebookPageId: null,
      topicos: [
        {
          titulo:
            'Igreja evangélica de SC entra na mira do MP após manifestações supostamente homofóbicas no desfile de 7 de setembro',
          link: 'https://outro-site.test/mesmo-assunto',
          resumo: 'O Ministério Público apura manifestações ocorridas no desfile.',
        },
        {
          titulo: 'Pastor anuncia novo projeto social para famílias',
          link: 'https://site.test/pauta-nova',
        },
      ],
    });

    assert.equal(resultado.novosExcluidos, 1);
    assert.equal(resultado.topicos.length, 1);
    assert.equal(resultado.topicos[0].titulo, 'Pastor anuncia novo projeto social para famílias');
    assert.match(resultado.excluidos[0].motivo, /Já gerada, agendada ou publicada/);
  } finally {
    AiMatters.findUsedReferencesByUser = original;
  }
});

test('radar oculta pauta pelo mesmo link em qualquer status aproveitável', async () => {
  const original = AiMatters.findUsedReferencesByUser;
  AiMatters.findUsedReferencesByUser = async () => [
    {
      titulo: 'Título já salvo',
      fonte_url: 'https://portal.test/materia/?utm_source=facebook',
      status: 'rascunho',
      publication_id: null,
    },
  ];

  try {
    const resultado = await viralizarService.sincronizarPautasUsadas({
      userId: 9,
      topicos: [
        {
          titulo: 'Outra manchete para a mesma reportagem',
          link: 'https://portal.test/materia',
        },
      ],
    });

    assert.equal(resultado.topicos.length, 0);
    assert.equal(resultado.novosExcluidos, 1);
  } finally {
    AiMatters.findUsedReferencesByUser = original;
  }
});
