const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { splitFollowCall } = require('../src/services/pageDistributionEditorial');

test('remove somente chamada final, preservando fontes, hashtags e declarações', () => {
  for (const call of ['Siga o JM Notícia.', '**Siga o JM Notícia.**', 'Siga a Página Gospell.']) {
    const body = 'Segundo o JM Notícia, houve um culto.\nFonte: JM Notícia — https://example.org\nFoto: Reprodução\n#Culto #JMNotícia';
    assert.deepEqual(splitFollowCall(body + '\n\n' + call), {text:body, hasFollow:true});
    assert.deepEqual(splitFollowCall(body + ' ' + call), {text:body, hasFollow:true});
  }
  const quote = 'O pastor disse: “Siga o caminho correto.”\nFonte: JM Notícia';
  assert.deepEqual(splitFollowCall(quote), {text:quote,hasFollow:false});
});

function generator(verdict) {
  const calls=[];
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/services/pageDistributionEditorial'),'utf8'), {
    module, exports:module.exports,
    require: name => name === 'crypto' ? require('crypto') : {
      chatCompletionClaudeObrigatorio: async messages => {
        calls.push(JSON.parse(messages[1].content));
        return calls.length === 1 ? JSON.stringify({titulo:'Título diferente sobre o culto',
          materia:'Durante o culto, o pastor falou aos presentes. A notícia foi divulgada pelo JM Notícia.\n\nFonte: JM Notícia\nFoto: Reprodução\n#Culto #JMNotícia\n\nSiga o JM Notícia.'}) : JSON.stringify(verdict);
      },
    },
  });
  return {calls,generate:module.exports.generateVariation};
}

test('conferência não recebe assinatura e saída usa a página destino, preservando fonte', async () => {
  for(const name of ['Apocalipse Gospel','Gospel Geral','Página Gospell']) {
    const g=generator({fiel:true});
    const out=await g.generate({titulo:'Culto',materia:'Informação principal.\nFonte: JM Notícia\n\n**Siga o JM Notícia.**'}, {page_name:name}, []);
    assert.equal(g.calls[0].principal.materia.includes('Siga'),false);
    assert.equal(g.calls[1].principal.includes('Siga'),false);
    assert.equal(g.calls[1].versao.materia.includes('Siga'),false);
    assert.ok(out.materia.includes('Fonte: JM Notícia'));
    assert.ok(out.materia.endsWith('Siga '+name+'.'));
    assert.equal((out.materia.match(/Siga /g)||[]).length,1);
  }
});

test('continua bloqueando alteração factual real', async () => {
  const g=generator({fiel:false,motivo:'Nome do pastor alterado'});
  await assert.rejects(g.generate({titulo:'Culto',materia:'Fato original.\nSiga o JM Notícia.'},{page_name:'Gospel Geral'},[]),/Nome do pastor alterado/);
});
