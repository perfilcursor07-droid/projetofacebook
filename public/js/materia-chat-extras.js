/**
 * Extras do chat de matérias (/materia-manual), carregado depois do
 * materia-chat.js. Não altera o chat existente: injeta os controles novos e
 * usa os elementos que já estão na página.
 *
 *  1. Botão "Em alta" ao lado de Escrever/Pautas — ao clicar já lista os
 *     assuntos do momento (política, igreja evangélica, polêmica gospel) e
 *     permite buscar outro tema. Clicar em um manda a IA escrever a matéria.
 *  2. Anexar PDF — o texto do arquivo entra no pedido enviado à IA.
 *  3. Anexar imagem — OCR identifica o texto do print e o transforma em pauta.
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
  let anexoImagem = null;
  let altaAtiva = false;
  let carregandoAlta = false;
  let publicoAtivo = false;
  let carregandoPublico = false;
  let paginaFacebookAtiva = false;
  let carregandoPaginaFacebook = false;

  /* ------------------------------ estilos ------------------------------ */

  const estilos = document.createElement('style');
  estilos.textContent = `
    .mia-x-anexo-btn, .mia-x-imagem-btn, .mia-x-alta-btn, .mia-x-publico-btn, .mia-x-facebook-btn { cursor: pointer; }
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
    .mia-x-bases {
      margin: .55rem 0 .7rem; padding: .55rem .65rem;
      border-left: 2px solid rgba(244,63,94,.65); background: rgba(136,19,55,.08);
    }
    .mia-x-bases-title { margin: 0 0 .35rem; color: #fda4af; font-size: .68rem; font-weight: 600; }
    .mia-x-base { display: block; margin-top: .25rem; color: #cbd5e1; font-size: .68rem; line-height: 1.35; }
    .mia-x-base.hidden { display: none; }
    .mia-x-base-meta { color: #64748b; }
    .mia-x-result-note { margin: .3rem 0 0; color: #64748b; font-size: .68rem; line-height: 1.35; }
    .mia-x-result-note.is-warning { color: #fcd34d; }
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
    .mia-x-lote-save {
      border: none; background: #10b981; color: #022c22;
    }
    .mia-x-lote-save:hover { background: #34d399; }
    .mia-x-lote-save:disabled { opacity: .55; cursor: default; }

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
    .mia-x-card-thumb {
      flex: 0 0 4.5rem; width: 4.5rem; height: 4.5rem; border-radius: .55rem;
      object-fit: cover; background: #020617; border: 1px solid #1e293b;
    }
    .mia-x-card-tit { display: block; font-size: .8125rem; font-weight: 500; line-height: 1.35; color: #e2e8f0; }
    .mia-x-card-meta { display: block; margin-top: .2rem; font-size: .65rem; color: #64748b; }
    .mia-x-card-res { display: block; margin-top: .25rem; font-size: .7rem; line-height: 1.4; color: #94a3b8; }
    .mia-x-card-actions { flex-shrink: 0; display: flex; align-items: flex-start; gap: .35rem; }
    .mia-x-card-gerar {
      border: 1px solid rgba(16,185,129,.45); border-radius: .5rem;
      background: rgba(16,185,129,.12); color: #a7f3d0;
      padding: .25rem .5rem; font-size: .68rem; font-weight: 600; cursor: pointer;
    }
    .mia-x-card-gerar:hover { border-color: rgba(16,185,129,.8); color: #fff; }
    .mia-x-card-fonte {
      border: 1px solid #334155; border-radius: .5rem; background: transparent; color: #cbd5e1;
      padding: .25rem .5rem; font-size: .68rem; font-weight: 600; text-decoration: none;
    }
    .mia-x-card-fonte:hover { border-color: #64748b; color: #fff; }
    @media (max-width: 560px) {
      .mia-x-card { flex-wrap: wrap; }
      .mia-x-card-thumb { flex-basis: 4rem; width: 4rem; height: 4rem; }
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

  function formatarDataPauta(topico) {
    const ts = Number(topico?.dataTimestamp) || Date.parse(String(topico?.data || ''));
    if (!Number.isFinite(ts) || ts <= 0) return '';
    return new Intl.DateTimeFormat('pt-BR', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    }).format(new Date(ts));
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

  const btnPublico = document.createElement('button');
  btnPublico.type = 'button';
  btnPublico.className = 'mia-chat-seg-btn mia-x-publico-btn';
  btnPublico.setAttribute('aria-pressed', 'false');
  btnPublico.title = 'Sugere pautas novas com base no que viralizou na sua página';
  btnPublico.textContent = 'Meu público';
  el.seg.appendChild(btnPublico);

  const btnPaginaFacebook = document.createElement('button');
  btnPaginaFacebook.type = 'button';
  btnPaginaFacebook.className = 'mia-chat-seg-btn mia-x-facebook-btn';
  btnPaginaFacebook.setAttribute('aria-pressed', 'false');
  btnPaginaFacebook.title = 'Cole uma página do Facebook, escolha os posts e crie rascunhos';
  btnPaginaFacebook.textContent = 'Página Facebook';
  el.seg.appendChild(btnPaginaFacebook);

  function desativarPaginaFacebook() {
    paginaFacebookAtiva = false;
    btnPaginaFacebook.setAttribute('aria-pressed', 'false');
    btnPaginaFacebook.classList.remove('is-active');
  }

  function marcarPublico(ativa) {
    publicoAtivo = ativa;
    btnPublico.setAttribute('aria-pressed', ativa ? 'true' : 'false');
    btnPublico.classList.toggle('is-active', ativa);
    if (!ativa) return;
    desativarPaginaFacebook();
    altaAtiva = false;
    btnAlta.setAttribute('aria-pressed', 'false');
    btnAlta.classList.remove('is-active');
    document.querySelectorAll('.chat-modo-btn').forEach((b) => {
      b.classList.remove('is-active');
      b.setAttribute('aria-pressed', 'false');
    });
  }

  function marcarAlta(ativa) {
    altaAtiva = ativa;
    btnAlta.setAttribute('aria-pressed', ativa ? 'true' : 'false');
    btnAlta.classList.toggle('is-active', ativa);
    if (!ativa) return;
    desativarPaginaFacebook();
    publicoAtivo = false;
    btnPublico.setAttribute('aria-pressed', 'false');
    btnPublico.classList.remove('is-active');
    // Os dois modos nativos saem do estado ativo enquanto o radar manda.
    document.querySelectorAll('.chat-modo-btn').forEach((b) => {
      b.classList.remove('is-active');
      b.setAttribute('aria-pressed', 'false');
    });
  }

  // Voltar para Escrever/Pautas desliga o radar.
  document.querySelectorAll('.chat-modo-btn').forEach((b) => {
    b.addEventListener('click', () => {
      marcarAlta(false);
      marcarPublico(false);
      desativarPaginaFacebook();
    });
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
    desativarPaginaFacebook();
    botaoModo('escrever')?.click();
    el.input.value = textoPedidoTopicosSelecionados(lista);
    el.input.dispatchEvent(new Event('input', { bubbles: true }));
    el.enviar.click();
  }

  function pedirMateriaDoTopico(topico) {
    pedirMateriaDosTopicos([topico]);
  }

  async function salvarTopicosComoRascunhos(topicos) {
    const pautas = (Array.isArray(topicos) ? topicos : [])
      .filter(Boolean)
      .map((topico) => ({
        titulo: topico.titulo || '',
        url: topico.url || '',
        veiculo: topico.pagina ? `Facebook · ${topico.pagina}` : topico.veiculo || 'Web',
        resumo: topico.resumo || '',
        data: topico.data || '',
        dataTimestamp: Number(topico.dataTimestamp) || null,
        imagemUrl: topico.imagem || topico.imagemUrl || null,
        creditoImagem: topico.pagina
          ? `Reprodução/Facebook · ${topico.pagina}`
          : topico.veiculo || 'Reprodução',
      }));
    if (!pautas.length) throw new Error('Selecione ao menos uma pauta.');
    const salvas = [];
    const erros = [];
    for (let inicio = 0; inicio < pautas.length; inicio += MAX_TOPICOS_LOTE) {
      const lote = pautas.slice(inicio, inicio + MAX_TOPICOS_LOTE);
      try {
        const data = await apiJson('/api/materias-ia/chat/pautas/rascunhos', {
          method: 'POST',
          body: JSON.stringify({
            pautas: lote,
            pesquisarWeb: true,
            periodo: el.periodo?.value || '30d',
          }),
        });
        for (const item of data.salvas || []) salvas.push({ ...item, indice: inicio + Number(item.indice) });
        for (const item of data.erros || []) erros.push({ ...item, indice: inicio + Number(item.indice) });
      } catch (err) {
        lote.forEach((pauta, i) => erros.push({ indice: inicio + i + 1, titulo: pauta.titulo, error: err.message }));
      }
    }
    if (!salvas.length) throw new Error(erros[0]?.error || 'Não foi possível criar os rascunhos.');
    return {
      salvas,
      erros,
      mensagem: `${salvas.length} rascunho(s) criado(s)${erros.length ? ` · ${erros.length} falha(s)` : ''}.`,
    };
  }

  function marcarPaginaFacebook(ativa) {
    paginaFacebookAtiva = ativa;
    btnPaginaFacebook.setAttribute('aria-pressed', ativa ? 'true' : 'false');
    btnPaginaFacebook.classList.toggle('is-active', ativa);
    if (!ativa) return;
    altaAtiva = false;
    publicoAtivo = false;
    btnAlta.setAttribute('aria-pressed', 'false');
    btnAlta.classList.remove('is-active');
    btnPublico.setAttribute('aria-pressed', 'false');
    btnPublico.classList.remove('is-active');
    document.querySelectorAll('.chat-modo-btn').forEach((b) => {
      b.classList.remove('is-active');
      b.setAttribute('aria-pressed', 'false');
    });
  }

  /**
   * Aviso de carregando com esqueletos. Entra na hora do clique para o usuário
   * não olhar uma área vazia achando que nada aconteceu.
   */
  function renderCarregando(termo, paraPublico = false, paginaFacebook = false) {
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
    txt.textContent = paginaFacebook
      ? 'Abrindo a página do Facebook e extraindo os posts...'
      : paraPublico
        ? 'Analisando o que viralizou e procurando pautas novas para o seu público...'
      : termo
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

  function renderErro(mensagem, termo, paraPublico = false) {
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
    tentar.addEventListener('click', () => {
      if (paraPublico) carregarParaPublico();
      else carregarAlta(termo || '');
    });
    acoes.appendChild(tentar);
    box.appendChild(acoes);

    wrap.appendChild(box);
    mostrarBloco(wrap);
  }

  function renderPaginaFacebookEntrada(url = '', mensagemErro = '') {
    limparBlocosAlta();
    el.vazio?.classList.add('hidden');
    const wrap = novoBlocoAlta();
    const corpo = document.createElement('div');
    corpo.className = 'mia-msg-ai-body';
    const texto = document.createElement('p');
    texto.textContent =
      'Cole o link de uma página ou perfil público do Facebook. Vou listar os posts para você escolher quais devem virar matérias em rascunho.';
    corpo.appendChild(texto);
    wrap.appendChild(corpo);

    const box = document.createElement('div');
    box.className = 'mia-x-alta';
    const titulo = document.createElement('p');
    titulo.className = 'mia-x-alta-title';
    titulo.textContent = 'Página Facebook';
    box.appendChild(titulo);
    if (mensagemErro) {
      const erro = document.createElement('p');
      erro.className = 'mia-x-erro';
      erro.textContent = mensagemErro;
      box.appendChild(erro);
    }
    const busca = document.createElement('div');
    busca.className = 'mia-x-busca';
    const campo = document.createElement('input');
    campo.type = 'url';
    campo.placeholder = 'https://www.facebook.com/NomeDaPagina';
    campo.value = String(url || '');
    campo.setAttribute('aria-label', 'URL da página do Facebook');
    const botao = document.createElement('button');
    botao.type = 'button';
    botao.textContent = 'Listar posts';
    const disparar = () => carregarPaginaFacebook(campo.value);
    botao.addEventListener('click', disparar);
    campo.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      disparar();
    });
    busca.appendChild(campo);
    busca.appendChild(botao);
    box.appendChild(busca);
    const ajuda = document.createElement('p');
    ajuda.className = 'mia-x-result-note';
    ajuda.textContent = 'A leitura usa primeiro a sessão gratuita configurada no servidor; nenhuma publicação é feita automaticamente.';
    box.appendChild(ajuda);
    wrap.appendChild(box);
    mostrarBloco(wrap);
    setTimeout(() => campo.focus(), 0);
  }

  function renderAlta(data) {
    const topicos = data.topicos || [];
    const temas = data.temas || [];
    const horas = data.horas || 24;
    const paraPublico = data.origem === 'viralizadas';
    const paginaFacebook = data.origem === 'pagina-facebook';
    const podeSalvarRascunho = paraPublico || paginaFacebook;
    const basesVirais = Array.isArray(data.basesVirais) ? data.basesVirais : [];

    limparBlocosAlta();
    el.vazio?.classList.add('hidden');

    const wrap = novoBlocoAlta();

    const corpo = document.createElement('div');
    corpo.className = 'mia-msg-ai-body';
    const p = document.createElement('p');
    p.textContent = paginaFacebook
      ? `${topicos.length} post(s) encontrados em ${data.pagina || 'Facebook'}. Selecione um ou mais para criar as matérias como rascunho.`
      : paraPublico
        ? `${topicos.length} pauta(s) nova(s) encontradas a partir do que mais engajou na sua página. Selecione uma ou mais para salvar como rascunho.`
      : topicos.length
        ? `${topicos.length} assunto(s) em alta nas últimas ${horas}h (${data.totalAnalisado || 0} analisados). Marque um ou mais e eu escrevo tudo de uma vez.`
        : `Não achei nada em alta nas últimas ${horas}h nesses temas. Tente de novo em alguns minutos ou busque outro tema abaixo.`;
    corpo.appendChild(p);
    if (paraPublico && Number(data.totalOcultado) > 0) {
      const ocultadas = document.createElement('p');
      ocultadas.className = 'mia-x-result-note';
      ocultadas.textContent = `${Number(data.totalOcultado)} pauta(s) que já existem no sistema ou na Página foram ocultadas.`;
      corpo.appendChild(ocultadas);
    }
    if (paraPublico && topicos.length < 20) {
      const limite = document.createElement('p');
      limite.className = 'mia-x-result-note is-warning';
      limite.textContent = 'A lista ficou menor porque só entram pautas realmente novas e publicadas nos últimos 7 dias.';
      corpo.appendChild(limite);
    }
    wrap.appendChild(corpo);

    const box = document.createElement('div');
    box.className = 'mia-x-alta';

    const head = document.createElement('div');
    head.className = 'mia-x-alta-head';
    const titulo = document.createElement('p');
    titulo.className = 'mia-x-alta-title';
    titulo.textContent = paginaFacebook
      ? `Posts de ${data.pagina || 'Facebook'}`
      : paraPublico
        ? 'Sugestões para o seu público'
      : data.padrao
        ? 'Em alta agora'
        : 'Em alta — sua busca';
    head.appendChild(titulo);
    const recarregar = document.createElement('button');
    recarregar.type = 'button';
    recarregar.className = 'mia-chat-ghost-btn';
    recarregar.textContent = 'Atualizar';
    recarregar.addEventListener('click', () => {
      if (paginaFacebook) carregarPaginaFacebook(data.paginaUrl);
      else if (paraPublico) carregarParaPublico();
      else carregarAlta(data.padrao ? '' : temas.join(', '));
    });
    head.appendChild(recarregar);
    box.appendChild(head);

    if (paraPublico && basesVirais.length) {
      const bases = document.createElement('div');
      bases.className = 'mia-x-bases';
      const basesTitulo = document.createElement('p');
      basesTitulo.className = 'mia-x-bases-title';
      basesTitulo.textContent = `Baseado em ${basesVirais.length} matéria(s) que engajaram`;
      bases.appendChild(basesTitulo);
      basesVirais.slice(0, 4).forEach((base) => {
        const item = document.createElement('span');
        item.className = 'mia-x-base';
        item.textContent = base.titulo || 'Matéria publicada';
        const metaBase = document.createElement('span');
        metaBase.className = 'mia-x-base-meta';
        metaBase.textContent = ` · ${base.likes || 0} curtidas · ${base.comments || 0} comentários`;
        item.appendChild(metaBase);
        bases.appendChild(item);
      });
      box.appendChild(bases);
    }

    if (!paraPublico && !paginaFacebook && temas.length) {
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
    campo.placeholder = paginaFacebook
      ? 'https://www.facebook.com/NomeDaPagina'
      : 'Buscar outro tema. Ex.: Malafaia, política evangélica';
    campo.setAttribute('aria-label', paginaFacebook ? 'URL da página do Facebook' : 'Buscar tema em alta');
    if (paginaFacebook) campo.value = data.paginaUrl || '';
    else if (!data.padrao) campo.value = temas.join(', ');
    const botao = document.createElement('button');
    botao.type = 'button';
    botao.textContent = paginaFacebook ? 'Listar posts' : 'Buscar';
    const disparar = () =>
      paginaFacebook ? carregarPaginaFacebook(campo.value) : carregarAlta(campo.value);
    botao.addEventListener('click', disparar);
    campo.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      disparar();
    });
    busca.appendChild(campo);
    busca.appendChild(botao);
    if (!paraPublico) box.appendChild(busca);

    if (topicos.length) {
      const selecionados = new Map();
      const itens = [];
      const limiteSelecao = paginaFacebook ? topicos.length : Math.min(MAX_TOPICOS_LOTE, topicos.length);

      const lote = document.createElement('div');
      lote.className = 'mia-x-lote';
      const selecionar = document.createElement('button');
      selecionar.type = 'button';
      selecionar.className = 'mia-x-lote-select';
      selecionar.textContent = paginaFacebook
        ? `Selecionar todos (${topicos.length})`
        : `Selecionar até ${limiteSelecao}`;
      const salvar = document.createElement('button');
      salvar.type = 'button';
      salvar.className = 'mia-x-lote-save';
      salvar.textContent = 'Salvar rascunhos';
      salvar.disabled = true;
      const gerar = document.createElement('button');
      gerar.type = 'button';
      gerar.className = 'mia-x-lote-gerar';
      gerar.textContent = paraPublico ? 'Gerar no chat' : 'Gerar selecionados';
      gerar.disabled = true;
      lote.appendChild(selecionar);
      if (podeSalvarRascunho) lote.appendChild(salvar);
      if (!paginaFacebook) lote.appendChild(gerar);
      box.appendChild(lote);

      const resultadoLote = document.createElement('p');
      resultadoLote.className = 'mia-x-base hidden';
      box.appendChild(resultadoLote);

      let salvando = false;

      function atualizarLote() {
        const total = selecionados.size;
        salvar.disabled = total === 0 || salvando;
        salvar.textContent = salvando
          ? 'Criando rascunhos...'
          : total
            ? `Salvar ${total} rascunho(s)`
            : 'Salvar rascunhos';
        gerar.disabled = total === 0 || salvando;
        gerar.textContent = total
          ? paraPublico
            ? `Gerar ${total} no chat`
            : `Gerar ${total} selecionado(s)`
          : paraPublico
            ? 'Gerar no chat'
            : 'Gerar selecionados';
        selecionar.textContent = total
          ? 'Limpar seleção'
          : paginaFacebook
            ? `Selecionar todos (${topicos.length})`
            : `Selecionar até ${limiteSelecao}`;
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
          const marcar = indice < limiteSelecao;
          item.input.checked = marcar;
          item.card.classList.toggle('is-selected', marcar);
          if (marcar) selecionados.set(item.key, item.topico);
        });
        if (!paginaFacebook && itens.length > limiteSelecao) {
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

      salvar.addEventListener('click', async () => {
        const alvos = [...selecionados.values()];
        if (!alvos.length || salvando) return;
        salvando = true;
        atualizarLote();
        setStatus(`Criando ${alvos.length} rascunho(s)${paginaFacebook ? ' dos posts selecionados' : ' para o seu público'}...`);
        try {
          const result = await salvarTopicosComoRascunhos(alvos);
          resultadoLote.classList.remove('hidden');
          resultadoLote.textContent = result.mensagem || `${result.salvas?.length || 0} rascunho(s) criado(s).`;
          const abrir = document.createElement('a');
          abrir.href = '/minhas-materias?status=rascunho';
          abrir.className = 'mia-chat-ghost-btn';
          abrir.textContent = 'Abrir rascunhos';
          resultadoLote.appendChild(document.createTextNode(' '));
          resultadoLote.appendChild(abrir);
          setStatus(result.mensagem || 'Rascunhos criados.');
        } catch (err) {
          resultadoLote.classList.remove('hidden');
          resultadoLote.textContent = err.message || 'Não foi possível criar os rascunhos.';
          setStatus(resultadoLote.textContent);
        } finally {
          salvando = false;
          atualizarLote();
        }
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

        if (t.imagem) {
          const thumb = document.createElement('img');
          thumb.className = 'mia-x-card-thumb';
          thumb.src = t.imagem;
          thumb.alt = '';
          thumb.loading = 'lazy';
          thumb.referrerPolicy = 'no-referrer';
          card.appendChild(thumb);
        }

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
          paraPublico && t.afinidadePublico ? `${t.afinidadePublico}% de afinidade` : '',
          paraPublico && t.potencialPublico ? `${t.potencialPublico}% potencial` : '',
          paginaFacebook && t.pagina ? t.pagina : '',
          t.veiculo || 'Web',
          formatarDataPauta(t),
          paginaFacebook && t.mediaType === 'video' ? 'Vídeo' : '',
          t.contagemFontes > 1 ? `${t.contagemFontes} fontes` : '',
        ]
          .filter(Boolean)
          .join(' · ');
        if (paraPublico && t.motivoAfinidade) meta.title = t.motivoAfinidade;
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
        if (t.url) {
          const fonte = document.createElement('a');
          fonte.href = t.url;
          fonte.target = '_blank';
          fonte.rel = 'noopener';
          fonte.className = 'mia-x-card-fonte';
          fonte.textContent = 'Fonte ↗';
          fonte.title = `Abrir matéria original em ${t.veiculo || 'nova aba'}`;
          acoes.appendChild(fonte);
        }
        const gerarUm = document.createElement('button');
        gerarUm.type = 'button';
        gerarUm.className = 'mia-x-card-gerar';
        gerarUm.textContent = podeSalvarRascunho ? 'Salvar' : 'Gerar';
        gerarUm.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          if (!podeSalvarRascunho) {
            pedirMateriaDoTopico(t);
            return;
          }
          gerarUm.disabled = true;
          gerarUm.textContent = 'Salvando...';
          try {
            const result = await salvarTopicosComoRascunhos([t]);
            gerarUm.textContent = 'Rascunho salvo';
            setStatus(result.mensagem || 'Rascunho criado.');
          } catch (err) {
            gerarUm.disabled = false;
            gerarUm.textContent = 'Tentar salvar';
            setStatus(err.message || 'Não foi possível criar o rascunho.');
          }
        });
        acoes.appendChild(gerarUm);
        card.appendChild(acoes);

        checkWrap.addEventListener('click', (ev) => ev.stopPropagation());
        check.addEventListener('change', () => {
          if (check.checked && !selecionados.has(key) && selecionados.size >= limiteSelecao) {
            check.checked = false;
            setStatus(`Selecione no máximo ${limiteSelecao} assuntos por vez.`);
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

  async function carregarParaPublico() {
    if (carregandoPublico) return;
    carregandoPublico = true;
    btnPublico.disabled = true;
    setStatus('Analisando as matérias que viralizaram na sua página...');
    renderCarregando('', true);

    try {
      const data = await apiJson(`${API}/para-meu-publico`, {
        method: 'POST',
        body: JSON.stringify({ limit: 30 }),
      });
      renderAlta(data);
      setStatus(`${(data.topicos || []).length} pauta(s) sugerida(s) para o seu público`);
    } catch (err) {
      const mensagem = err.message || 'Falha ao sugerir pautas para o seu público';
      setStatus(mensagem);
      renderErro(mensagem, '', true);
    } finally {
      carregandoPublico = false;
      btnPublico.disabled = false;
    }
  }

  btnPublico.addEventListener('click', () => {
    marcarPublico(true);
    carregarParaPublico();
  });

  async function carregarPaginaFacebook(url) {
    if (carregandoPaginaFacebook) return;
    const paginaUrl = String(url || '').trim();
    if (!/^https?:\/\/(?:[^/]+\.)?(?:facebook\.com|fb\.com)\//i.test(paginaUrl)) {
      setStatus('Cole uma URL válida de página do Facebook.');
      renderPaginaFacebookEntrada(paginaUrl, 'O link precisa ser de uma página ou perfil do Facebook.');
      return;
    }
    carregandoPaginaFacebook = true;
    btnPaginaFacebook.disabled = true;
    setStatus('Extraindo posts da página do Facebook...');
    renderCarregando(paginaUrl, false, true);
    try {
      const data = await apiJson(`${API}/pagina-facebook/posts`, {
        method: 'POST',
        body: JSON.stringify({ url: paginaUrl, limit: 40 }),
      });
      renderAlta(data);
      setStatus(`${(data.topicos || []).length} post(s) encontrados em ${data.pagina || 'Facebook'}`);
    } catch (err) {
      const mensagem = err.message || 'Não consegui extrair os posts dessa página.';
      setStatus(mensagem);
      renderPaginaFacebookEntrada(paginaUrl, mensagem);
    } finally {
      carregandoPaginaFacebook = false;
      btnPaginaFacebook.disabled = false;
    }
  }

  btnPaginaFacebook.addEventListener('click', () => {
    marcarPaginaFacebook(true);
    renderPaginaFacebookEntrada();
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

  const inputImagem = document.createElement('input');
  inputImagem.type = 'file';
  inputImagem.accept = 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp';
  inputImagem.hidden = true;
  document.body.appendChild(inputImagem);

  const btnImagem = document.createElement('button');
  btnImagem.type = 'button';
  btnImagem.className = 'mia-chat-chip mia-x-imagem-btn';
  btnImagem.title = 'Enviar uma imagem ou print; a IA lê o texto e cria a matéria';
  btnImagem.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg> Imagem';
  el.tools.appendChild(btnImagem);

  // O chip fica logo abaixo do campo de texto, fora da barra de ferramentas.
  const chipWrap = document.createElement('div');
  if (el.composer) el.composer.insertBefore(chipWrap, el.input.nextSibling);
  else el.tools.parentElement?.appendChild(chipWrap);

  function renderChip() {
    chipWrap.replaceChildren();

    const criarChip = (dados, tipo) => {
      if (!dados) return;
      const chip = document.createElement('span');
      chip.className = 'mia-x-chip';

      const nome = document.createElement('span');
      nome.className = 'mia-x-chip-nome';
      nome.textContent = dados.nome;
      chip.appendChild(nome);

      const meta = document.createElement('span');
      meta.className = 'mia-x-chip-meta';
      meta.textContent = (tipo === 'imagem'
        ? [
            dados.palavras ? `${dados.palavras} palavras` : '',
            Number.isFinite(Number(dados.confianca)) ? `OCR ${dados.confianca}%` : '',
          ]
        : [dados.paginas ? `${dados.paginas} pág.` : '', dados.truncado ? 'texto cortado' : '']
      )
        .filter(Boolean)
        .join(' · ');
      chip.appendChild(meta);

      const fechar = document.createElement('button');
      fechar.type = 'button';
      fechar.className = 'mia-x-chip-x';
      fechar.setAttribute('aria-label', `Remover ${dados.nome}`);
      fechar.textContent = '×';
      fechar.addEventListener('click', () => {
        if (tipo === 'imagem') anexoImagem = null;
        else anexo = null;
        renderChip();
        setStatus(`${tipo === 'imagem' ? 'Imagem' : 'PDF'} removido.`);
      });
      chip.appendChild(fechar);
      chipWrap.appendChild(chip);
    };

    criarChip(anexo, 'pdf');
    criarChip(anexoImagem, 'imagem');
  }

  btnAnexo.addEventListener('click', () => inputArquivo.click());
  btnImagem.addEventListener('click', () => inputImagem.click());

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

  inputImagem.addEventListener('change', async () => {
    const arquivo = inputImagem.files?.[0];
    inputImagem.value = '';
    if (!arquivo) return;

    btnImagem.disabled = true;
    setStatus(`Procurando texto em ${arquivo.name}…`);
    try {
      const dados = new FormData();
      dados.append('imagem', arquivo);
      const res = await fetch(`${API}/anexos-imagem`, { method: 'POST', body: dados });
      const bruto = await res.text();
      let data = null;
      try {
        data = bruto ? JSON.parse(bruto) : null;
      } catch {
        data = null;
      }
      if (!res.ok) throw new Error(data?.error || `Falha ao analisar a imagem (${res.status})`);

      anexoImagem = data.anexo;
      renderChip();
      setStatus(
        `Texto encontrado em ${anexoImagem.nome}: ${anexoImagem.palavras} palavra(s). Escreva o que quer e envie.`
      );
      el.input.focus();
    } catch (err) {
      anexoImagem = null;
      renderChip();
      setStatus(err.message || 'Não consegui ler o texto da imagem');
    } finally {
      btnImagem.disabled = false;
    }
  });

  /**
   * Injeta o conteúdo do PDF no pedido pouco antes do chat enviar.
   * Roda na fase de captura, então acontece antes do handler do materia-chat.js.
   */
  function injetarAnexoNoPedido() {
    if ((!anexo && !anexoImagem) || el.enviar.disabled) return;
    const base =
      String(el.input.value || '').replace(/\s+$/g, '').trim() ||
      (anexoImagem
        ? `Faça uma matéria com base no texto desta imagem: ${anexoImagem.nome}`
        : `Faça uma matéria com base no PDF ${anexo.nome}`);
    const partes = [base];
    if (anexo) {
      partes.push(
        '',
        `--- Conteúdo do PDF anexado (${anexo.nome}) ---`,
        String(anexo.texto || '').slice(0, MAX_PDF_NO_PEDIDO),
        '--- fim do PDF ---'
      );
    }
    if (anexoImagem) {
      partes.push(
        '',
        `--- Texto detectado por OCR na imagem (${anexoImagem.nome}) ---`,
        String(anexoImagem.texto || '').slice(0, MAX_PDF_NO_PEDIDO),
        '--- fim do texto da imagem ---'
      );
    }
    partes.push(
      '',
      'Use o conteúdo anexado como pista factual. Pesquise na web para confirmar nomes, datas e contexto antes de escrever. Não invente dados e não copie o texto literalmente.'
    );
    el.input.value = partes.join('\n');
    anexo = null;
    anexoImagem = null;
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
