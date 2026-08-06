/**
 * Extras do chat de matérias (/materia-manual), carregado depois do
 * materia-chat.js. Não altera o chat existente: injeta os controles novos e
 * usa os elementos que já estão na página.
 *
 *  1. Botão "Em alta" ao lado de Escrever/Pautas — ao clicar já lista os
 *     assuntos do momento (política, igreja evangélica, polêmica gospel) e
 *     permite buscar outro tema. Clicar em um manda a IA escrever a matéria.
 *  2. Anexar PDF — o texto do arquivo entra no pedido enviado à IA.
 */
(() => {
  const API = '/api/materias-ia/chat-extras';
  const MAX_PDF_NO_PEDIDO = 12000;
  const MAX_TOPICOS_LOTE = 8;
  /** Quantos esqueletos aparecem enquanto o radar carrega. */
  const ESQUELETOS = 6;

  const el = {
    seg: document.querySelector('.mia-chat-seg'),
    tools: document.querySelector('.mia-chat-tools'),
    composer: document.getElementById('chat-composer'),
    input: document.getElementById('chat-input'),
    enviar: document.getElementById('chat-enviar'),
    mensagens: document.getElementById('chat-mensagens'),
    vazio: document.getElementById('chat-vazio'),
    status: document.getElementById('chat-status'),
    periodo: document.getElementById('chat-periodo'),
  };

  if (!el.seg || !el.tools || !el.input || !el.enviar || !el.mensagens) return;

  let anexo = null;
  let altaAtiva = false;
  let carregandoAlta = false;

  /* ------------------------------ estilos ------------------------------ */

  const estilos = document.createElement('style');
  estilos.textContent = `
    .mia-x-anexo-btn, .mia-x-alta-btn { cursor: pointer; }
    .mia-x-chip {
      display: inline-flex; align-items: center; gap: .4rem;
      max-width: 100%; margin: .5rem 0 0; padding: .35rem .5rem .35rem .6rem;
      border: 1px solid rgba(16,185,129,.35); border-radius: .6rem;
      background: rgba(16,185,129,.1); color: #a7f3d0;
      font-size: .75rem; line-height: 1.3;
    }
    .mia-x-chip-nome { max-width: 16rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mia-x-chip-meta { color: #6ee7b7; opacity: .75; }
    .mia-x-chip-x {
      display: flex; align-items: center; justify-content: center;
      width: 1.1rem; height: 1.1rem; border: none; border-radius: .3rem;
      background: transparent; color: #6ee7b7; cursor: pointer; font-size: .9rem; line-height: 1;
    }
    .mia-x-chip-x:hover { background: rgba(244,63,94,.2); color: #fecdd3; }

    .mia-x-alta { border: 1px solid #1e293b; border-radius: .9rem; background: rgba(2,6,23,.4); padding: .75rem; }
    .mia-x-alta-head { display: flex; align-items: flex-start; justify-content: space-between; gap: .75rem; }
    .mia-x-alta-title { margin: 0; font-size: .7rem; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: #64748b; }
    .mia-x-temas { display: flex; flex-wrap: wrap; gap: .3rem; margin: .5rem 0 .1rem; }
    .mia-x-tema {
      border-radius: .35rem; padding: .1rem .4rem;
      background: rgba(16,185,129,.12); color: #6ee7b7;
      font-size: .65rem; font-weight: 500;
    }
    .mia-x-busca { display: flex; gap: .4rem; margin: .6rem 0; }
    .mia-x-busca input {
      flex: 1; min-width: 0; border: 1px solid #334155; border-radius: .5rem;
      background: #020617; padding: .35rem .55rem; color: #e2e8f0; font-size: .75rem; outline: none;
    }
    .mia-x-busca input:focus { border-color: #10b981; }
    .mia-x-busca button {
      flex-shrink: 0; border: none; border-radius: .5rem; background: #10b981; color: #022c22;
      padding: .35rem .7rem; font-size: .7rem; font-weight: 600; cursor: pointer;
    }
    .mia-x-busca button:hover { background: #34d399; }
    .mia-x-busca button:disabled { opacity: .55; cursor: default; }

    .mia-x-lote {
      display: flex; flex-wrap: wrap; align-items: center; gap: .4rem;
      margin: .45rem 0 .65rem;
    }
    .mia-x-lote button {
      border-radius: .5rem; padding: .35rem .65rem;
      font-size: .7rem; font-weight: 600; cursor: pointer;
    }
    .mia-x-lote-select {
      border: 1px solid #334155; background: transparent; color: #cbd5e1;
    }
    .mia-x-lote-select:hover { border-color: rgba(16,185,129,.6); color: #fff; }
    .mia-x-lote-gerar {
      border: none; background: #10b981; color: #022c22;
    }
    .mia-x-lote-gerar:hover { background: #34d399; }
    .mia-x-lote-gerar:disabled { opacity: .55; cursor: default; }

    .mia-x-alta-list { display: flex; flex-direction: column; gap: .5rem; }
    .mia-x-card {
      display: flex; gap: .6rem; width: 100%; text-align: left;
      border: 1px solid #1e293b; border-radius: .75rem; background: rgba(15,23,42,.55);
      padding: .6rem .7rem; cursor: pointer; transition: border-color .15s, background .15s;
    }
    .mia-x-card:hover { border-color: rgba(16,185,129,.55); background: rgba(15,23,42,.9); }
    .mia-x-card.is-selected { border-color: rgba(16,185,129,.65); background: rgba(16,185,129,.08); }
    .mia-x-card-check {
      flex-shrink: 0; display: flex; align-items: center; justify-content: center;
      width: 1.2rem; height: 1.4rem;
    }
    .mia-x-card-check input { width: 1rem; height: 1rem; accent-color: #10b981; cursor: pointer; }
    .mia-x-card-pos {
      flex-shrink: 0; display: flex; align-items: center; justify-content: center;
      width: 1.4rem; height: 1.4rem; border-radius: .4rem;
      background: rgba(16,185,129,.12); color: #6ee7b7;
      font-size: .68rem; font-weight: 700; font-variant-numeric: tabular-nums;
    }
    .mia-x-card-txt { min-width: 0; flex: 1; }
    .mia-x-card-tit { display: block; font-size: .8125rem; font-weight: 500; line-height: 1.35; color: #e2e8f0; }
    .mia-x-card-meta { display: block; margin-top: .2rem; font-size: .65rem; color: #64748b; }
    .mia-x-card-res { display: block; margin-top: .25rem; font-size: .7rem; line-height: 1.4; color: #94a3b8; }
    .mia-x-card-actions { flex-shrink: 0; display: flex; align-items: flex-start; }
    .mia-x-card-gerar {
      border: 1px solid rgba(16,185,129,.45); border-radius: .5rem;
      background: rgba(16,185,129,.12); color: #a7f3d0;
      padding: .25rem .5rem; font-size: .68rem; font-weight: 600; cursor: pointer;
    }
    .mia-x-card-gerar:hover { border-color: rgba(16,185,129,.8); color: #fff; }
    @media (max-width: 560px) {
      .mia-x-card { flex-wrap: wrap; }
      .mia-x-card-txt { flex-basis: calc(100% - 4rem); }
      .mia-x-card-actions { width: 100%; justify-content: flex-end; }
    }

    .mia-x-carregando {
      display: flex; align-items: center; gap: .5rem; margin: 0;
      color: #cbd5e1; font-size: .8125rem; line-height: 1.4;
    }
    .mia-x-spin {
      flex-shrink: 0; width: .9rem; height: .9rem; border-radius: 50%;
      border: 2px solid rgba(148,163,184,.3); border-top-color: #10b981;
      animation: mia-x-rodar .7s linear infinite;
    }
    @keyframes mia-x-rodar { to { transform: rotate(360deg); } }
    .mia-x-skel {
      height: 3.4rem; border-radius: .75rem; border: 1px solid #1e293b;
      background-image: linear-gradient(90deg, rgba(15,23,42,.55) 25%, rgba(30,41,59,.8) 37%, rgba(15,23,42,.55) 63%);
      background-size: 400% 100%;
      animation: mia-x-brilho 1.4s ease infinite;
    }
    @keyframes mia-x-brilho { 0% { background-position: 100% 0; } 100% { background-position: 0 0; } }
    .mia-x-erro {
      border: 1px solid rgba(244,63,94,.35); border-radius: .75rem;
      background: rgba(244,63,94,.08); padding: .6rem .7rem;
      color: #fecdd3; font-size: .75rem; line-height: 1.45;
    }
    @media (prefers-reduced-motion: reduce) {
      .mia-x-spin, .mia-x-skel { animation: none; }
    }
  `;
  document.head.appendChild(estilos);

  /* ------------------------------ helpers ------------------------------ */

  function setStatus(texto) {
    if (el.status) el.status.textContent = texto || '';
  }

  async function apiJson(url, opts = {}) {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    const bruto = await res.text();
    let data = null;
    try {
      data = bruto ? JSON.parse(bruto) : null;
    } catch {
      data = null;
    }
    if (!res.ok) throw new Error(data?.error || `Falha na requisição (${res.status})`);
    return data;
  }

  function botaoModo(nome) {
    return document.querySelector(`.chat-modo-btn[data-chat-modo="${nome}"]`);
  }

  /** Bloco do radar na thread: sempre marcado para ser substituído depois. */
  function novoBlocoAlta() {
    const wrap = document.createElement('div');
    wrap.className = 'mia-msg-ai';
    wrap.dataset.miaAlta = '1';
    return wrap;
  }

  function mostrarBloco(wrap) {
    el.mensagens.appendChild(wrap);
    wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* --------------------------- botão "Em alta" -------------------------- */

  const btnAlta = document.createElement('button');
  btnAlta.type = 'button';
  btnAlta.className = 'mia-chat-seg-btn mia-x-alta-btn';
  btnAlta.setAttribute('aria-pressed', 'false');
  btnAlta.title = 'Mostra os assuntos em alta agora para você escolher';
  btnAlta.textContent = 'Em alta';
  el.seg.appendChild(btnAlta);

  function marcarAlta(ativa) {
    altaAtiva = ativa;
    btnAlta.setAttribute('aria-pressed', ativa ? 'true' : 'false');
    btnAlta.classList.toggle('is-active', ativa);
    if (!ativa) return;
    // Os dois modos nativos saem do estado ativo enquanto o radar manda.
    document.querySelectorAll('.chat-modo-btn').forEach((b) => {
      b.classList.remove('is-active');
      b.setAttribute('aria-pressed', 'false');
    });
  }

  // Voltar para Escrever/Pautas desliga o radar.
  document.querySelectorAll('.chat-modo-btn').forEach((b) => {
    b.addEventListener('click', () => marcarAlta(false));
  });

  function limparBlocosAlta() {
    el.mensagens.querySelectorAll('[data-mia-alta="1"]').forEach((n) => n.remove());
  }

  function textoPedidoTopicosSelecionados(topicos = []) {
    const lista = (Array.isArray(topicos) ? topicos : []).filter(Boolean);
    if (lista.length <= 1) {
      const topico = lista[0] || {};
      return [
        'Escreva uma matéria sobre este assunto que está em alta agora, com furo de reportagem, texto totalmente original e sem plagiar:',
        `Título: ${topico.titulo || ''}`,
        `Veículo: ${topico.veiculo || ''}`,
        `Link: ${topico.url || ''}`,
        'Pesquise também mais informações recentes sobre esse assunto para acrescentar contexto e dados novos.',
      ].join('\n');
    }

    const blocos = lista.map((topico, indice) =>
      [
        `### ASSUNTO ${indice + 1}`,
        `Título: ${topico.titulo || ''}`,
        `Veículo: ${topico.veiculo || ''}`,
        `Link: ${topico.url || ''}`,
        topico.resumo ? `Resumo: ${topico.resumo}` : null,
      ]
        .filter(Boolean)
        .join('\n')
    );

    return [
      `Escreva ${lista.length} matérias, uma para cada assunto selecionado em alta agora, com furo de reportagem, texto totalmente original e sem plagiar.`,
      `Limite obrigatório: escreva exatamente ${lista.length} matérias e pare na MATERIA ${lista.length}. Não crie assunto extra, variação, resumo adicional nem continuação.`,
      'Entregue tudo na mesma resposta. Separe cada texto com "### MATERIA n", seguido do título, corpo e hashtags daquela matéria.',
      'Não misture os fatos: cada matéria deve usar o assunto/link correspondente como base principal.',
      '',
      ...blocos,
      '',
      'Pesquise também mais informações recentes sobre cada assunto para acrescentar contexto e dados novos.',
    ].join('\n');
  }

  function pedirMateriaDosTopicos(topicos) {
    const lista = (Array.isArray(topicos) ? topicos : []).filter(Boolean);
    if (!lista.length) return;
    marcarAlta(false);
    botaoModo('escrever')?.click();
    el.input.value = textoPedidoTopicosSelecionados(lista);
    el.input.dispatchEvent(new Event('input', { bubbles: true }));
    el.enviar.click();
  }

  function pedirMateriaDoTopico(topico) {
    pedirMateriaDosTopicos([topico]);
  }

  /**
   * Aviso de carregando com esqueletos. Entra na hora do clique para o usuário
   * não olhar uma área vazia achando que nada aconteceu.
   */
  function renderCarregando(termo) {
    limparBlocosAlta();
    el.vazio?.classList.add('hidden');

    const wrap = novoBlocoAlta();

    const corpo = document.createElement('div');
    corpo.className = 'mia-msg-ai-body';
    const linha = document.createElement('p');
    linha.className = 'mia-x-carregando';
    linha.setAttribute('role', 'status');
    linha.setAttribute('aria-live', 'polite');
    const spin = document.createElement('span');
    spin.className = 'mia-x-spin';
    linha.appendChild(spin);
    const txt = document.createElement('span');
    txt.textContent = termo
      ? `Carregando matérias em alta sobre “${termo}”… aguarde.`
      : 'Carregando as matérias em alta agora… aguarde alguns segundos.';
    linha.appendChild(txt);
    corpo.appendChild(linha);
    wrap.appendChild(corpo);

    const box = document.createElement('div');
    box.className = 'mia-x-alta';
    const lista = document.createElement('div');
    lista.className = 'mia-x-alta-list';
    for (let i = 0; i < ESQUELETOS; i += 1) {
      const skel = document.createElement('div');
      skel.className = 'mia-x-skel';
      lista.appendChild(skel);
    }
    box.appendChild(lista);
    wrap.appendChild(box);

    mostrarBloco(wrap);
  }

  function renderErro(mensagem, termo) {
    limparBlocosAlta();
    const wrap = novoBlocoAlta();

    const box = document.createElement('div');
    box.className = 'mia-x-alta';

    const erro = document.createElement('p');
    erro.className = 'mia-x-erro';
    erro.textContent = mensagem || 'Não consegui carregar as matérias em alta.';
    box.appendChild(erro);

    const acoes = document.createElement('div');
    acoes.className = 'mia-x-busca';
    const tentar = document.createElement('button');
    tentar.type = 'button';
    tentar.textContent = 'Tentar de novo';
    tentar.addEventListener('click', () => carregarAlta(termo || ''));
    acoes.appendChild(tentar);
    box.appendChild(acoes);

    wrap.appendChild(box);
    mostrarBloco(wrap);
  }

  function renderAlta(data) {
    const topicos = data.topicos || [];
    const temas = data.temas || [];
    const horas = data.horas || 24;

    limparBlocosAlta();
    el.vazio?.classList.add('hidden');

    const wrap = novoBlocoAlta();

    const corpo = document.createElement('div');
    corpo.className = 'mia-msg-ai-body';
    const p = document.createElement('p');
    p.textContent = topicos.length
      ? `${topicos.length} assunto(s) em alta nas últimas ${horas}h (${data.totalAnalisado || 0} analisados). Marque um ou mais e eu escrevo tudo de uma vez.`
      : `Não achei nada em alta nas últimas ${horas}h nesses temas. Tente de novo em alguns minutos ou busque outro tema abaixo.`;
    corpo.appendChild(p);
    wrap.appendChild(corpo);

    const box = document.createElement('div');
    box.className = 'mia-x-alta';

    const head = document.createElement('div');
    head.className = 'mia-x-alta-head';
    const titulo = document.createElement('p');
    titulo.className = 'mia-x-alta-title';
    titulo.textContent = data.padrao ? 'Em alta agora' : 'Em alta — sua busca';
    head.appendChild(titulo);
    const recarregar = document.createElement('button');
    recarregar.type = 'button';
    recarregar.className = 'mia-chat-ghost-btn';
    recarregar.textContent = 'Atualizar';
    recarregar.addEventListener('click', () => carregarAlta(data.padrao ? '' : temas.join(', ')));
    head.appendChild(recarregar);
    box.appendChild(head);

    if (temas.length) {
      const chips = document.createElement('div');
      chips.className = 'mia-x-temas';
      temas.forEach((t) => {
        const chip = document.createElement('span');
        chip.className = 'mia-x-tema';
        chip.textContent = t;
        chips.appendChild(chip);
      });
      box.appendChild(chips);
    }

    // Busca fica dentro do painel: não disputa o campo de mensagem do chat.
    const busca = document.createElement('div');
    busca.className = 'mia-x-busca';
    const campo = document.createElement('input');
    campo.type = 'search';
    campo.placeholder = 'Buscar outro tema. Ex.: Malafaia, política evangélica';
    campo.setAttribute('aria-label', 'Buscar tema em alta');
    if (!data.padrao) campo.value = temas.join(', ');
    const botao = document.createElement('button');
    botao.type = 'button';
    botao.textContent = 'Buscar';
    const disparar = () => carregarAlta(campo.value);
    botao.addEventListener('click', disparar);
    campo.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      disparar();
    });
    busca.appendChild(campo);
    busca.appendChild(botao);
    box.appendChild(busca);

    if (topicos.length) {
      const selecionados = new Map();
      const itens = [];

      const lote = document.createElement('div');
      lote.className = 'mia-x-lote';
      const selecionar = document.createElement('button');
      selecionar.type = 'button';
      selecionar.className = 'mia-x-lote-select';
      selecionar.textContent = `Selecionar até ${Math.min(MAX_TOPICOS_LOTE, topicos.length)}`;
      const gerar = document.createElement('button');
      gerar.type = 'button';
      gerar.className = 'mia-x-lote-gerar';
      gerar.textContent = 'Gerar selecionados';
      gerar.disabled = true;
      lote.appendChild(selecionar);
      lote.appendChild(gerar);
      box.appendChild(lote);

      function atualizarLote() {
        const total = selecionados.size;
        gerar.disabled = total === 0;
        gerar.textContent = total ? `Gerar ${total} selecionado(s)` : 'Gerar selecionados';
        selecionar.textContent = total
          ? 'Limpar seleção'
          : `Selecionar até ${Math.min(MAX_TOPICOS_LOTE, topicos.length)}`;
      }

      selecionar.addEventListener('click', () => {
        if (selecionados.size) {
          selecionados.clear();
          itens.forEach((item) => {
            item.input.checked = false;
            item.card.classList.remove('is-selected');
          });
          atualizarLote();
          return;
        }

        itens.forEach((item, indice) => {
          const marcar = indice < MAX_TOPICOS_LOTE;
          item.input.checked = marcar;
          item.card.classList.toggle('is-selected', marcar);
          if (marcar) selecionados.set(item.key, item.topico);
        });
        if (itens.length > MAX_TOPICOS_LOTE) {
          setStatus(`Selecionei os ${MAX_TOPICOS_LOTE} primeiros assuntos. Gere esse lote e depois escolha mais.`);
        }
        atualizarLote();
      });

      gerar.addEventListener('click', () => {
        const alvos = [...selecionados.values()];
        if (!alvos.length) {
          setStatus('Marque ao menos um assunto.');
          return;
        }
        pedirMateriaDosTopicos(alvos);
      });

      const lista = document.createElement('div');
      lista.className = 'mia-x-alta-list';

      topicos.forEach((t, i) => {
        const key = t.url || `${i}:${t.titulo || ''}:${t.veiculo || ''}`;
        const card = document.createElement('article');
        card.className = 'mia-x-card';

        const checkWrap = document.createElement('label');
        checkWrap.className = 'mia-x-card-check';
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.setAttribute('aria-label', `Selecionar assunto ${i + 1}`);
        checkWrap.appendChild(check);
        card.appendChild(checkWrap);

        const pos = document.createElement('span');
        pos.className = 'mia-x-card-pos';
        pos.textContent = String(i + 1);
        card.appendChild(pos);

        const txt = document.createElement('span');
        txt.className = 'mia-x-card-txt';

        const tit = document.createElement('span');
        tit.className = 'mia-x-card-tit';
        tit.textContent = t.titulo;
        txt.appendChild(tit);

        const meta = document.createElement('span');
        meta.className = 'mia-x-card-meta';
        meta.textContent = [
          t.tema ? t.tema : '',
          t.veiculo || 'Web',
          t.contagemFontes > 1 ? `${t.contagemFontes} fontes` : '',
        ]
          .filter(Boolean)
          .join(' · ');
        txt.appendChild(meta);

        if (t.resumo) {
          const res = document.createElement('span');
          res.className = 'mia-x-card-res';
          res.textContent = t.resumo.length > 170 ? `${t.resumo.slice(0, 170)}…` : t.resumo;
          txt.appendChild(res);
        }

        card.appendChild(txt);

        const acoes = document.createElement('span');
        acoes.className = 'mia-x-card-actions';
        const gerarUm = document.createElement('button');
        gerarUm.type = 'button';
        gerarUm.className = 'mia-x-card-gerar';
        gerarUm.textContent = 'Gerar';
        gerarUm.addEventListener('click', (ev) => {
          ev.stopPropagation();
          pedirMateriaDoTopico(t);
        });
        acoes.appendChild(gerarUm);
        card.appendChild(acoes);

        checkWrap.addEventListener('click', (ev) => ev.stopPropagation());
        check.addEventListener('change', () => {
          if (check.checked && !selecionados.has(key) && selecionados.size >= MAX_TOPICOS_LOTE) {
            check.checked = false;
            setStatus(`Selecione no máximo ${MAX_TOPICOS_LOTE} assuntos por vez.`);
            return;
          }
          if (check.checked) selecionados.set(key, t);
          else selecionados.delete(key);
          card.classList.toggle('is-selected', check.checked);
          atualizarLote();
        });
        card.addEventListener('click', (ev) => {
          if (ev.target.closest('button,a,input,label')) return;
          check.checked = !check.checked;
          check.dispatchEvent(new Event('change', { bubbles: true }));
        });

        itens.push({ input: check, card, key, topico: t });
        lista.appendChild(card);
      });

      atualizarLote();
      box.appendChild(lista);
    }

    wrap.appendChild(box);
    mostrarBloco(wrap);
  }

  async function carregarAlta(busca = '') {
    if (carregandoAlta) return;
    carregandoAlta = true;
    btnAlta.disabled = true;

    const horas = el.periodo?.value === '24h' ? 24 : 48;
    const termo = String(busca || '').replace(/\s+/g, ' ').trim();

    setStatus(
      termo ? `Carregando matérias em alta sobre “${termo}”…` : 'Carregando matérias em alta…'
    );
    renderCarregando(termo);

    try {
      const data = await apiJson(`${API}/em-alta`, {
        method: 'POST',
        body: JSON.stringify({ busca: termo, horas }),
      });
      renderAlta(data);
      setStatus(`${(data.topicos || []).length} assunto(s) em alta`);
    } catch (err) {
      const mensagem = err.message || 'Falha ao buscar o radar';
      setStatus(mensagem);
      renderErro(mensagem, termo);
    } finally {
      carregandoAlta = false;
      btnAlta.disabled = false;
    }
  }

  btnAlta.addEventListener('click', () => {
    marcarAlta(true);
    carregarAlta('');
  });

  /* ---------------------------- anexo em PDF ---------------------------- */

  const inputArquivo = document.createElement('input');
  inputArquivo.type = 'file';
  inputArquivo.accept = 'application/pdf,.pdf';
  inputArquivo.hidden = true;
  document.body.appendChild(inputArquivo);

  const btnAnexo = document.createElement('button');
  btnAnexo.type = 'button';
  btnAnexo.className = 'mia-chat-chip mia-x-anexo-btn';
  btnAnexo.title = 'Anexar um PDF para a IA escrever a matéria com base nele';
  btnAnexo.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg> PDF';
  el.tools.appendChild(btnAnexo);

  // O chip fica logo abaixo do campo de texto, fora da barra de ferramentas.
  const chipWrap = document.createElement('div');
  if (el.composer) el.composer.insertBefore(chipWrap, el.input.nextSibling);
  else el.tools.parentElement?.appendChild(chipWrap);

  function renderChip() {
    chipWrap.replaceChildren();
    if (!anexo) return;

    const chip = document.createElement('span');
    chip.className = 'mia-x-chip';

    const nome = document.createElement('span');
    nome.className = 'mia-x-chip-nome';
    nome.textContent = anexo.nome;
    chip.appendChild(nome);

    const meta = document.createElement('span');
    meta.className = 'mia-x-chip-meta';
    meta.textContent = [
      anexo.paginas ? `${anexo.paginas} pág.` : '',
      anexo.truncado ? 'texto cortado' : '',
    ]
      .filter(Boolean)
      .join(' · ');
    chip.appendChild(meta);

    const fechar = document.createElement('button');
    fechar.type = 'button';
    fechar.className = 'mia-x-chip-x';
    fechar.setAttribute('aria-label', `Remover ${anexo.nome}`);
    fechar.textContent = '×';
    fechar.addEventListener('click', () => {
      anexo = null;
      renderChip();
      setStatus('PDF removido.');
    });
    chip.appendChild(fechar);

    chipWrap.appendChild(chip);
  }

  btnAnexo.addEventListener('click', () => inputArquivo.click());

  inputArquivo.addEventListener('change', async () => {
    const arquivo = inputArquivo.files?.[0];
    inputArquivo.value = '';
    if (!arquivo) return;

    btnAnexo.disabled = true;
    setStatus(`Lendo ${arquivo.name}…`);
    try {
      const dados = new FormData();
      dados.append('arquivo', arquivo);
      const res = await fetch(`${API}/anexos`, { method: 'POST', body: dados });
      const bruto = await res.text();
      let data = null;
      try {
        data = bruto ? JSON.parse(bruto) : null;
      } catch {
        data = null;
      }
      if (!res.ok) throw new Error(data?.error || `Falha ao enviar o PDF (${res.status})`);

      anexo = data.anexo;
      renderChip();
      setStatus(
        `PDF pronto: ${anexo.nome}. Escreva o que quer e envie — a matéria sai com base nele.`
      );
      el.input.focus();
    } catch (err) {
      anexo = null;
      renderChip();
      setStatus(err.message || 'Falha ao ler o PDF');
    } finally {
      btnAnexo.disabled = false;
    }
  });

  /**
   * Injeta o conteúdo do PDF no pedido pouco antes do chat enviar.
   * Roda na fase de captura, então acontece antes do handler do materia-chat.js.
   */
  function injetarAnexoNoPedido() {
    if (!anexo || el.enviar.disabled) return;
    const base =
      String(el.input.value || '').replace(/\s+$/g, '').trim() ||
      `Faça uma matéria com base no PDF ${anexo.nome}`;
    el.input.value = [
      base,
      '',
      `--- Conteúdo do PDF anexado (${anexo.nome}) ---`,
      String(anexo.texto || '').slice(0, MAX_PDF_NO_PEDIDO),
      '--- fim do PDF ---',
      '',
      'Use o conteúdo do PDF acima como base factual da matéria. Não invente dados que não estejam nele.',
    ].join('\n');
    anexo = null;
    renderChip();
  }

  el.enviar.addEventListener('click', injetarAnexoNoPedido, true);
  el.input.addEventListener(
    'keydown',
    (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) injetarAnexoNoPedido();
    },
    true
  );
})();
