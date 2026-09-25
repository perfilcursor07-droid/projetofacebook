/* Chat de matérias (/conteudo → Matéria manual): conversas salvas, passos da
   pesquisa em tempo real e refino por prompt antes de virar rascunho. */
(() => {
  const API = '/api/materias-ia/chat';
  const STORAGE_KEY = 'mia_chat_atual';
  const MAX_PAUTAS_LOTE = 8;
  const MAX_LINKS_LOTE = 12;

  const el = {
    lista: document.getElementById('chat-lista'),
    busca: document.getElementById('chat-busca'),
    nova: document.getElementById('chat-nova'),
    novaTop: document.getElementById('chat-nova-top'),
    titulo: document.getElementById('chat-titulo'),
    renomear: document.getElementById('chat-renomear'),
    mensagens: document.getElementById('chat-mensagens'),
    vazio: document.getElementById('chat-vazio'),
    input: document.getElementById('chat-input'),
    linksDetectados: document.getElementById('chat-links-detectados'),
    variosLinks: document.querySelectorAll('.chat-varios-links'),
    enviar: document.getElementById('chat-enviar'),
    voz: document.getElementById('chat-voz'),
    parar: document.getElementById('chat-parar'),
    status: document.getElementById('chat-status'),
    toggleWeb: document.getElementById('chat-toggle-web'),
    toggleWebLabel: document.getElementById('chat-toggle-web-label'),
    toggleTranscricao: document.getElementById('chat-toggle-transcricao'),
    modeloIa: document.getElementById('chat-ai-model'),
    modeloIaNome: document.getElementById('chat-ai-model-name'),
    modeloIaNivel: document.getElementById('chat-ai-model-level'),
    modeloIaMenu: document.getElementById('chat-ai-model-menu'),
    tom: document.getElementById('chat-tom'),
    titleToneBtns: document.querySelectorAll('.chat-title-tone'),
    periodo: document.getElementById('chat-periodo'),
    modoBtns: document.querySelectorAll('.chat-modo-btn'),
    tipoBtns: document.querySelectorAll('.chat-tipo-btn'),
    modoSeg: document.getElementById('chat-modo-seg'),
    sidebar: document.getElementById('chat-sidebar'),
    drawerOpen: document.getElementById('chat-drawer-open'),
    drawerClose: document.getElementById('chat-drawer-close'),
    drawerBackdrop: document.getElementById('chat-drawer-backdrop'),
  };

  if (!el.mensagens || !el.input) return;

  const state = {
    iniciado: false,
    chatId: null,
    conversas: [],
    // O link enviado já é a fonte. Pesquisa extra só roda quando o editor optar.
    pesquisarWeb: false,
    transcreverVideo: true,
    enviando: false,
    controller: null,
    vozAtiva: false,
    vozBase: '',
    vozFinal: '',
    recognition: null,
    modo: 'escrever',
    tipoConversa: 'materia',
    modelosIa: null,
    // Modelos liberados pelo administrador em /claude e o escolhido pelo editor.
    opcoesModelo: [],
    modeloEscolhido: null,
    salvandoPautas: false,
    // Pautas da última pesquisa e quais já viraram matéria nesta conversa
    ultimasPautas: [],
    pautasEscritas: new Set(),
    // Reescrita de pauta: mantém a matéria ancorada no topo da leitura
    ancorarTopo: false,
    ancoradoAtivo: false,
  };

  function urlsDoTexto(texto) {
    const encontradas = String(texto || '').match(/https?:\/\/[^\s<>"']+/gi) || [];
    return [...new Set(encontradas.map((url) => url.replace(/[),.;!?]+$/, '')))];
  }

  function linksComOpcaoDeMaterias(texto) {
    return urlsDoTexto(texto).some((link) => {
      try {
        const host = new URL(link).hostname.toLowerCase();
        return /(^|\.)(youtube\.com|youtu\.be|instagram\.com|facebook\.com|fb\.watch)$/.test(host);
      } catch { return false; }
    });
  }

  function atualizarLinksDetectados() {
    const opcoes = document.getElementById('chat-video-options');
    const quantidade = document.getElementById('chat-video-count');
    if (opcoes) {
      opcoes.hidden = !linksComOpcaoDeMaterias(el.input?.value);
      if (opcoes.hidden && quantidade) quantidade.value = '1';
    }
    if (!el.linksDetectados) return;
    const total = urlsDoTexto(el.input?.value).length;
    if (total < 2) {
      el.linksDetectados.classList.add('hidden');
      el.linksDetectados.textContent = '';
      return;
    }
    el.linksDetectados.classList.remove('hidden');
    el.linksDetectados.textContent =
      total > MAX_LINKS_LOTE
        ? total + ' links detectados · serão usados somente os primeiros ' + MAX_LINKS_LOTE
        : total + ' links detectados · será criada uma matéria separada para cada link';
  }

  /** URLs das pautas que um pedido de reescrita aponta (linhas "Link: ..."). */
  function urlsDoPedido(texto) {
    const matches = String(texto || '').matchAll(/^\s*Link:\s*(https?:\/\/\S+)/gim);
    return [...matches].map((m) => String(m[1] || '').trim()).filter(Boolean);
  }

  function marcarPautaEscrita(url) {
    if (url) state.pautasEscritas.add(String(url).trim());
  }

  function pautaJaEscrita(url) {
    return Boolean(url) && state.pautasEscritas.has(String(url).trim());
  }

  async function api(url, opts = {}) {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    const texto = await res.text();
    let data = null;
    try {
      data = texto ? JSON.parse(texto) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      const err = new Error(data?.error || `Falha na requisição (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function setStatus(texto) {
    if (el.status) el.status.textContent = texto || '';
  }

  function modeloFallback(tipo) {
    return tipo === 'livre'
      ? { provider: 'claude', nome: 'Sonnet 5', nivel: 'Médio', origem: 'token-free-gateway' }
      : { provider: 'claude', nome: 'Sonnet 5', nivel: 'Médio', origem: 'redação' };
  }

  const MODELO_KEY = 'ViralizeAI.materiaModelo';
  const ROTULO_PROVEDOR = { claude: 'Claude', chatgpt: 'ChatGPT' };

  function opcaoEscolhida() {
    return state.opcoesModelo.find((o) => o.id === state.modeloEscolhido) || null;
  }

  function escolherModelo(id, { salvar = true } = {}) {
    const opcao = state.opcoesModelo.find((o) => o.id === id)
      || state.opcoesModelo.find((o) => o.padrao)
      || state.opcoesModelo[0];
    state.modeloEscolhido = opcao?.id || null;
    if (salvar && opcao) {
      try { localStorage.setItem(MODELO_KEY, opcao.id); } catch { /* ignore */ }
    }
    atualizarModeloIa();
  }

  function fecharMenuModelo() {
    if (!el.modeloIaMenu || el.modeloIaMenu.hidden) return;
    el.modeloIaMenu.hidden = true;
    el.modeloIa?.setAttribute('aria-expanded', 'false');
  }

  function renderMenuModelo() {
    if (!el.modeloIaMenu) return;
    el.modeloIaMenu.replaceChildren();
    const titulo = document.createElement('p');
    titulo.className = 'mia-chat-model-menu-title';
    titulo.textContent = 'Escrever com';
    el.modeloIaMenu.appendChild(titulo);
    for (const opcao of state.opcoesModelo) {
      const item = document.createElement('button');
      const ativo = opcao.id === state.modeloEscolhido;
      item.type = 'button';
      item.setAttribute('role', 'option');
      item.className = `mia-chat-model-option${ativo ? ' is-active' : ''}`;
      item.dataset.provider = opcao.provedor || '';
      item.setAttribute('aria-selected', String(ativo));
      const nome = document.createElement('strong');
      nome.textContent = opcao.nome;
      const detalhe = document.createElement('small');
      detalhe.textContent = [ROTULO_PROVEDOR[opcao.provedor], opcao.padrao ? 'padrão' : null]
        .filter(Boolean)
        .join(' · ');
      item.append(nome, detalhe);
      item.addEventListener('click', () => {
        escolherModelo(opcao.id);
        fecharMenuModelo();
        el.input?.focus();
      });
      el.modeloIaMenu.appendChild(item);
    }
  }

  el.modeloIa?.addEventListener('click', () => {
    if (state.opcoesModelo.length < 2 || !el.modeloIaMenu) return;
    const abrir = el.modeloIaMenu.hidden;
    if (abrir) renderMenuModelo();
    el.modeloIaMenu.hidden = !abrir;
    el.modeloIa.setAttribute('aria-expanded', String(abrir));
  });
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest?.('.mia-chat-model')) fecharMenuModelo();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') fecharMenuModelo();
  });

  function atualizarModeloIa() {
    if (!el.modeloIa) return;
    const tipo = state.tipoConversa === 'livre' ? 'livre' : 'materia';
    const escolhido = opcaoEscolhida();
    const modelo = escolhido
      ? {
          provider: escolhido.provedor,
          modelo: escolhido.id,
          nome: escolhido.nome,
          nivel: ROTULO_PROVEDOR[escolhido.provedor] || '',
          origem: 'token-free-gateway',
        }
      : state.modelosIa?.[tipo] || modeloFallback(tipo);
    const nome = modelo.nome || 'IA';
    const nivel = modelo.nivel || '';
    el.modeloIa.classList.toggle('is-selectable', state.opcoesModelo.length > 1);
    if (el.modeloIaNome) el.modeloIaNome.textContent = nome;
    if (el.modeloIaNivel) el.modeloIaNivel.textContent = nivel;
    el.modeloIa.dataset.provider = modelo.provider || '';
    el.modeloIa.title = [
      `Modelo em uso: ${nome}${nivel ? ` ${nivel}` : ''}`,
      modelo.modelo ? `ID: ${modelo.modelo}` : null,
      modelo.origem ? `Origem: ${modelo.origem}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
  }

  async function carregarModeloIa() {
    atualizarModeloIa();
    try {
      const data = await api(`${API}/modelo`);
      state.modelosIa = data?.modelos || null;
      state.opcoesModelo = Array.isArray(data?.opcoes) ? data.opcoes : [];
    } catch {
      state.modelosIa = null;
      state.opcoesModelo = [];
    }
    let salvo = null;
    try { salvo = localStorage.getItem(MODELO_KEY); } catch { /* ignore */ }
    // Um modelo que o administrador desligou volta para o padrão sem aviso.
    escolherModelo(salvo, { salvar: false });
  }

  function isMobileDrawer() {
    return window.matchMedia('(max-width: 1023px)').matches;
  }

  function openDrawer() {
    if (!isMobileDrawer()) return;
    el.sidebar?.classList.add('is-open');
    el.drawerBackdrop?.classList.add('is-visible');
    el.drawerBackdrop?.removeAttribute('hidden');
    el.drawerBackdrop?.setAttribute('aria-hidden', 'false');
    document.body.classList.add('mia-chat-drawer-open');
  }

  function closeDrawer() {
    el.sidebar?.classList.remove('is-open');
    el.drawerBackdrop?.classList.remove('is-visible');
    el.drawerBackdrop?.setAttribute('hidden', '');
    el.drawerBackdrop?.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('mia-chat-drawer-open');
  }

  function scrollFim() {
    el.mensagens.scrollTop = el.mensagens.scrollHeight;
  }

  /** Coloca um bloco no topo da área de leitura, sem mexer na página. */
  function ancorarNoTopo(bloco) {
    if (!bloco) return;
    el.mensagens.scrollTop = Math.max(0, bloco.offsetTop - el.mensagens.offsetTop);
  }

  /* ------------------------------ sidebar ------------------------------ */

  async function renomearConversaNaLista(conversa) {
    if (!conversa?.id) return;
    const atual = conversa.titulo || 'Nova conversa';
    const novo = prompt('Novo nome da conversa:', atual);
    if (!novo || !novo.trim() || novo.trim() === atual) return;
    try {
      const data = await api(`${API}/conversas/${conversa.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ titulo: novo.trim() }),
      });
      conversa.titulo = data.chat.titulo;
      if (Number(state.chatId) === Number(conversa.id)) {
        el.titulo.textContent = data.chat.titulo;
      }
      renderConversas();
    } catch (err) {
      alert(err.message);
    }
  }

  async function alternarConversaFixada(conversa) {
    if (!conversa?.id) return;
    const novoValor = !Boolean(conversa.fixada);
    try {
      const data = await api(`${API}/conversas/${conversa.id}/fixar`, {
        method: 'PATCH',
        body: JSON.stringify({ fixada: novoValor }),
      });
      conversa.fixada = Boolean(data.chat.fixada);
      await carregarConversas();
    } catch (err) {
      alert(err.message);
    }
  }

  async function duplicarConversa(conversa) {
    if (!conversa?.id) return;
    try {
      setStatus('Duplicando conversa…');
      const data = await api(`${API}/conversas/${conversa.id}/duplicar`, {
        method: 'POST',
      });
      await carregarConversas();
      await abrirConversa(data.chat.id);
      setStatus('Conversa duplicada');
    } catch (err) {
      setStatus('');
      alert(err.message);
    }
  }

  function renderConversas() {
    const filtro = String(el.busca?.value || '').trim().toLowerCase();
    el.lista.replaceChildren();

    const itens = state.conversas.filter(
      (c) => !filtro || String(c.titulo || '').toLowerCase().includes(filtro)
    );

    if (!itens.length) {
      const p = document.createElement('p');
      p.className = 'mia-chat-list-empty';
      p.textContent = filtro ? 'Nenhuma conversa encontrada' : 'Nenhuma conversa ainda';
      el.lista.appendChild(p);
      return;
    }

    for (const c of itens) {
      const linha = document.createElement('div');
      const ativo = Number(c.id) === Number(state.chatId);
      linha.className = `mia-chat-conv${ativo ? ' is-active' : ''}${c.fixada ? ' is-pinned' : ''}`;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mia-chat-conv-btn';
      btn.textContent = c.titulo || 'Nova conversa';
      btn.title = c.titulo || 'Nova conversa';
      btn.addEventListener('click', () => abrirConversa(c.id));

      const acoes = document.createElement('div');
      acoes.className = 'mia-chat-conv-actions';

      const fixar = document.createElement('button');
      fixar.type = 'button';
      fixar.className = `mia-chat-conv-action mia-chat-conv-pin${c.fixada ? ' is-active' : ''}`;
      fixar.title = c.fixada ? 'Desafixar conversa' : 'Fixar conversa';
      fixar.setAttribute('aria-label', fixar.title);
      fixar.setAttribute('aria-pressed', c.fixada ? 'true' : 'false');
      fixar.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m14 4 6 6-3 1-4 4-1 5-3-3-4 4-2-2 4-4-3-3 5-1 4-4 1-3Z"/></svg>';
      fixar.addEventListener('click', (ev) => {
        ev.stopPropagation();
        alternarConversaFixada(c);
      });

      const editar = document.createElement('button');
      editar.type = 'button';
      editar.className = 'mia-chat-conv-action mia-chat-conv-edit';
      editar.title = 'Editar nome da conversa';
      editar.setAttribute('aria-label', editar.title);
      editar.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>';
      editar.addEventListener('click', (ev) => {
        ev.stopPropagation();
        renomearConversaNaLista(c);
      });

      const duplicar = document.createElement('button');
      duplicar.type = 'button';
      duplicar.className = 'mia-chat-conv-action mia-chat-conv-duplicate';
      duplicar.title = 'Duplicar conversa';
      duplicar.setAttribute('aria-label', duplicar.title);
      duplicar.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>';
      duplicar.addEventListener('click', (ev) => {
        ev.stopPropagation();
        duplicarConversa(c);
      });

      const excluir = document.createElement('button');
      excluir.type = 'button';
      excluir.className = 'mia-chat-conv-action mia-chat-conv-del';
      excluir.textContent = '✕';
      excluir.title = 'Excluir conversa';
      excluir.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        if (!confirm('Excluir esta conversa e todo o histórico dela?')) return;
        try {
          await api(`${API}/conversas/${c.id}`, { method: 'DELETE' });
          if (Number(state.chatId) === Number(c.id)) novaConversa();
          await carregarConversas();
        } catch (err) {
          alert(err.message);
        }
      });

      linha.appendChild(btn);
      acoes.appendChild(fixar);
      acoes.appendChild(duplicar);
      acoes.appendChild(editar);
      acoes.appendChild(excluir);
      linha.appendChild(acoes);
      el.lista.appendChild(linha);
    }
  }

  async function carregarConversas() {
    try {
      const data = await api(`${API}/conversas`);
      state.conversas = data?.conversas || [];
      renderConversas();
    } catch (err) {
      el.lista.replaceChildren();
      const p = document.createElement('p');
      p.className = 'mia-chat-list-empty';
      p.style.color = '#fda4af';
      p.textContent = err.message;
      el.lista.appendChild(p);
    }
  }

  /* ------------------------------ mensagens ------------------------------ */

  function limparMensagens() {
    el.mensagens.replaceChildren();
    state.ultimasPautas = [];
    state.pautasEscritas = new Set();
    if (el.vazio) {
      el.mensagens.appendChild(el.vazio);
      el.vazio.classList.remove('hidden');
    }
  }

  function esconderVazio() {
    el.vazio?.classList.add('hidden');
  }

  const ICONE_LAPIS =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';

  function blocoUsuario(mensagem) {
    const wrap = document.createElement('div');
    wrap.className = 'mia-msg-user';
    wrap.dataset.userMsg = '1';
    if (mensagem.id) wrap.dataset.msgId = String(mensagem.id);

    const bolha = document.createElement('div');
    bolha.className = 'mia-msg-user-bubble';
    bolha.textContent = mensagem.content || '';
    wrap.appendChild(bolha);

    const editarBtn = document.createElement('button');
    editarBtn.type = 'button';
    editarBtn.className = 'mia-msg-edit-btn';
    editarBtn.title = 'Editar e gerar de novo';
    editarBtn.setAttribute('aria-label', 'Editar mensagem');
    editarBtn.innerHTML = ICONE_LAPIS;
    editarBtn.addEventListener('click', () => iniciarEdicao(wrap));
    wrap.appendChild(editarBtn);

    return wrap;
  }

  function iniciarEdicao(wrapElement) {
    if (state.enviando) return;

    const textoOriginal = wrapElement.querySelector('.mia-msg-user-bubble')?.textContent || '';
    // Guarda o conteúdo para o Cancelar restaurar sem recriar listeners perdidos
    const conteudoAnterior = wrapElement.innerHTML;
    wrapElement.innerHTML = '';
    wrapElement.classList.add('mia-msg-user--editing');

    const textarea = document.createElement('textarea');
    textarea.className = 'mia-msg-edit-textarea';
    textarea.value = textoOriginal;
    textarea.rows = Math.min(8, Math.max(2, textoOriginal.split('\n').length));
    wrapElement.appendChild(textarea);

    const acoes = document.createElement('div');
    acoes.className = 'mia-msg-edit-actions';

    const salvarBtn = document.createElement('button');
    salvarBtn.type = 'button';
    salvarBtn.className = 'mia-msg-edit-save';
    salvarBtn.textContent = 'Enviar editado';
    acoes.appendChild(salvarBtn);

    const cancelarBtn = document.createElement('button');
    cancelarBtn.type = 'button';
    cancelarBtn.className = 'mia-msg-edit-cancel';
    cancelarBtn.textContent = 'Cancelar';
    acoes.appendChild(cancelarBtn);

    wrapElement.appendChild(acoes);
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

    cancelarBtn.addEventListener('click', () => {
      wrapElement.innerHTML = conteudoAnterior;
      wrapElement.classList.remove('mia-msg-user--editing');
    });

    salvarBtn.addEventListener('click', () => {
      const novoTexto = textarea.value.trim();
      if (novoTexto.length < 3) {
        textarea.focus();
        return;
      }
      confirmarEdicao(wrapElement, novoTexto);
    });

    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancelarBtn.click();
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        salvarBtn.click();
      }
    });
  }

  async function confirmarEdicao(wrapElement, novoTexto) {
    if (state.enviando) return;
    const messageId = Number(wrapElement.dataset.msgId || 0);
    if (!state.chatId || !messageId) {
      setStatus('Aguarde a mensagem terminar de salvar antes de editá-la.');
      return;
    }

    const salvarBtn = wrapElement.querySelector('.mia-msg-edit-save');
    if (salvarBtn) {
      salvarBtn.disabled = true;
      salvarBtn.textContent = 'Atualizando…';
    }

    try {
      // A versão antiga e sua resposta deixam de existir também no banco.
      // Depois disso enviar() cria UMA única bolha com o texto revisado.
      await api(`${API}/conversas/${state.chatId}/mensagens/${messageId}`, {
        method: 'DELETE',
      });

      let proximo = wrapElement.nextElementSibling;
      while (proximo) {
        const aRemover = proximo;
        proximo = proximo.nextElementSibling;
        aRemover.remove();
      }
      wrapElement.remove();

      el.input.value = novoTexto;
      await enviar();
    } catch (err) {
      setStatus(err.message || 'Não foi possível atualizar a mensagem.');
      if (salvarBtn) {
        salvarBtn.disabled = false;
        salvarBtn.textContent = 'Enviar editado';
      }
    }
  }

  /** Bloco "raciocínio" recolhível, como o do DeepSeek. */
  function criarPassos(passos = [], { ativo = false } = {}) {
    const box = document.createElement('details');
    box.className = ativo ? 'mia-msg-panel mia-progress is-live' : 'mia-msg-panel mia-progress';
    box.open = false;

    const resumo = document.createElement('summary');
    resumo.className = 'mia-progress-summary';
    const indicador = document.createElement('span');
    indicador.className = ativo ? 'mia-progress-spinner' : 'mia-progress-check';
    indicador.setAttribute('aria-hidden', 'true');
    indicador.textContent = ativo ? '' : '✓';
    resumo.appendChild(indicador);

    const resumoTexto = document.createElement('span');
    resumoTexto.className = 'mia-progress-current';
    resumo.appendChild(resumoTexto);

    const resumoMeta = document.createElement('span');
    resumoMeta.className = 'mia-progress-meta';
    resumo.appendChild(resumoMeta);
    box.appendChild(resumo);

    const lista = document.createElement('div');
    lista.className = 'mia-progress-list mt-2 space-y-1';
    box.appendChild(lista);
    let ultimoPasso = null;

    function atualizarResumo() {
      const total = lista.childElementCount;
      const kinds = [...lista.querySelectorAll('[data-passo-kind]')].map((el) => el.dataset.passoKind);
      // "lendo" também aparece ao abrir o link colado — pesquisa web = busca/resultados.
      const temPesquisaWeb = kinds.some((k) =>
        ['busca', 'pesquisa', 'fontes', 'encontrados'].includes(k)
      );
      const audioTranscrito = kinds.includes('transcricao');
      const audioFalhou = kinds.includes('transcricao-falhou');
      const rotulo =
        state.tipoConversa === 'livre'
          ? temPesquisaWeb
            ? 'Pesquisa do Claude'
            : 'Conversa com Claude'
          : temPesquisaWeb
            ? 'Pesquisa e apuração'
            : 'Leitura e reescrita';
      if (ativo) {
        resumoTexto.textContent = ultimoPasso?.texto || `${rotulo}…`;
        resumoMeta.textContent = total ? String(total) : '';
      } else {
        resumoTexto.textContent = `${rotulo} concluída`;
        const audioStatus = audioTranscrito
          ? 'áudio transcrito'
          : audioFalhou
            ? 'legenda não encontrada'
            : null;
        resumoMeta.textContent = total
          ? `${total} etapas${audioStatus ? ` · ${audioStatus}` : ''} · ver detalhes`
          : '';
      }
    }

    function addPasso(passo) {
      ultimoPasso = passo || null;
      const linha = document.createElement('div');
      linha.className = 'flex items-start gap-2 text-slate-400';
      if (passo.kind) linha.dataset.passoKind = passo.kind;

      const ponto = document.createElement('span');
      const cor =
        passo.kind === 'aviso' || passo.kind === 'transcricao-falhou'
          ? 'bg-amber-400'
          : passo.kind === 'escrevendo'
            ? 'bg-violet-400'
            : ['fontes', 'encontrados', 'transcricao'].includes(passo.kind)
              ? 'bg-emerald-400'
              : 'bg-slate-500';
      ponto.className = `mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${cor}`;
      linha.appendChild(ponto);

      const texto = document.createElement('span');
      texto.className = 'min-w-0 break-words';
      if (passo.url) {
        const a = document.createElement('a');
        a.href = passo.url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.className = 'text-slate-300 underline decoration-slate-700 hover:text-emerald-300';
        a.textContent = passo.texto || passo.url;
        texto.appendChild(a);
      } else {
        texto.textContent = passo.texto || '';
      }
      linha.appendChild(texto);
      lista.appendChild(linha);
      atualizarResumo();
    }

    for (const p of passos) addPasso(p);
    atualizarResumo();
    box.addPasso = addPasso;
    box.temPassos = () => lista.childElementCount > 0;
    return box;
  }

  function renderTexto(container, conteudo) {
    container.replaceChildren();
    const bruto = String(conteudo || '');
    const linhas = bruto.split('\n');
    // Só matéria tem 1ª linha de título; resposta curta é texto normal
    const podeTerTitulo = bruto.trim().length > 500;
    let paragrafo = [];
    let proximoParagrafoEhTitulo = false;

    const preencherComNegrito = (el, texto) => {
      const partes = String(texto || '').split(/(\*\*[^*]+\*\*)/g);
      for (const parte of partes) {
        const negrito = parte.match(/^\*\*([^*]+)\*\*$/);
        if (negrito) {
          const strong = document.createElement('strong');
          strong.textContent = negrito[1];
          el.appendChild(strong);
        } else if (parte) {
          el.appendChild(document.createTextNode(parte));
        }
      }
    };

    const fecharParagrafo = () => {
      if (!paragrafo.length) return;
      const texto = paragrafo.join('\n');
      paragrafo = [];
      const p = document.createElement('p');
      const visivel = texto.replace(/\*\*/g, '').trim();
      const ehHashtags = /^#[^\s#]+(\s+#[^\s#]+)*$/.test(visivel);
      const ehFonteFoto = /^\*{0,2}(Fonte|Foto):/i.test(texto.trim());
      const ehChamada = /Siga o JM Not[ií]cia/i.test(visivel);
      const letras = visivel.replace(/[^\p{L}]/gu, '');
      const ehAncora =
        podeTerTitulo &&
        container.childElementCount === 1 &&
        visivel.length >= 20 &&
        visivel.length <= 260 &&
        letras.length >= 16 &&
        letras === letras.toLocaleUpperCase('pt-BR');
      const ehTitulo =
        podeTerTitulo &&
        (proximoParagrafoEhTitulo || container.childElementCount === 0) &&
        visivel.length <= 200 &&
        !texto.includes('\n');
      p.className = ehHashtags
        ? 'mia-msg-ai-tags'
        : ehFonteFoto || ehChamada
          ? 'mia-msg-ai-meta'
          : ehAncora
            ? 'mia-msg-ai-anchor'
            : ehTitulo
              ? 'mia-msg-ai-title'
              : 'mia-msg-ai-text';
      preencherComNegrito(p, texto);
      container.appendChild(p);
      proximoParagrafoEhTitulo = false;
    };

    for (const linha of linhas) {
      if (!linha.trim()) {
        fecharParagrafo();
        continue;
      }
      // Marcador de separação entre matérias não é texto para o leitor.
      if (/^#{1,6}\s*mat[eé]ria\s*\d+\b/i.test(linha.trim())) {
        fecharParagrafo();
        proximoParagrafoEhTitulo = true;
        continue;
      }
      // "# 1. Título" começa uma nova matéria: vira título próprio.
      const tituloNumerado = linha
        .trim()
        .match(/^(?:#{1,6}\s*|\*{2}\s*)?(\d{1,2})\s*[.)]\s+(\S.{10,200})$/);
      if (tituloNumerado) {
        fecharParagrafo();
        const p = document.createElement('p');
        p.className = 'mia-msg-ai-title';
        p.textContent = `${tituloNumerado[1]}. ${tituloNumerado[2]
          .replace(/\*\*(.+?)\*\*/g, '$1')
          .replace(/\*+$/g, '')
          .trim()}`;
        container.appendChild(p);
        continue;
      }
      paragrafo.push(linha);
    }
    fecharParagrafo();
  }

  function criarBotao(texto, classe) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = texto;
    b.className = classe;
    return b;
  }

  /**
   * Fotos sugeridas para a capa, iguais às de /materias-ia/:id. Clicar numa
   * miniatura preenche a URL e o crédito usados ao salvar o rascunho. A busca
   * só roda quando o quadro aparece na tela e fica em cache na aba, para não
   * gastar créditos do buscador a cada vez que a conversa é reaberta.
   */
  function faixaFotosSugeridas(mensagem, campoUrl, campoCredito) {
    const wrap = document.createElement('div');
    wrap.className = 'mt-2 rounded-lg border border-slate-800 bg-slate-950/60 p-2';
    const topo = document.createElement('div');
    topo.className = 'flex flex-wrap items-center justify-between gap-2';
    const label = document.createElement('p');
    label.className = 'text-[11px] font-semibold uppercase tracking-wide text-slate-500';
    label.textContent = 'Fotos sugeridas para a capa';
    const buscarNovas = criarBotao(
      'Buscar novas',
      'rounded-md border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300 hover:border-violet-400 hover:text-white'
    );
    topo.appendChild(label);
    topo.appendChild(buscarNovas);
    const busca = document.createElement('div');
    busca.className = 'mt-1.5 flex gap-1.5';
    const campoBusca = document.createElement('input');
    campoBusca.type = 'search';
    campoBusca.placeholder = 'Buscar foto por palavra (ex.: Silas Malafaia)';
    campoBusca.className =
      'min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100 placeholder:text-slate-600 focus:border-violet-400 focus:outline-none';
    const botaoBusca = criarBotao(
      'Buscar',
      'rounded-md border border-violet-500/50 px-2.5 py-1 text-[11px] font-semibold text-violet-200 hover:bg-violet-500/10'
    );
    busca.appendChild(campoBusca);
    busca.appendChild(botaoBusca);
    const faixa = document.createElement('div');
    faixa.className = 'mt-2 flex gap-1.5 overflow-x-auto pb-1';
    const meta = document.createElement('p');
    meta.className = 'mt-1 text-[11px] text-slate-500';
    meta.textContent = 'Carregando fotos relacionadas…';
    wrap.appendChild(topo);
    wrap.appendChild(busca);
    wrap.appendChild(faixa);
    wrap.appendChild(meta);

    const chaveCache = `mia-fotos-sugeridas:${mensagem.id}`;
    let botoes = [];

    function creditoDaFoto(img) {
      const fonte = String(img.fonte || '').trim();
      if (!fonte || /^(post|serper|(google|brave|bing)( images| news)?)$/i.test(fonte)) return 'Reprodução/Internet';
      return `Reprodução/${fonte.replace(/^www\./i, '').slice(0, 60)}`;
    }

    function escolher(img, btn) {
      campoUrl.value = img.url || '';
      if (!campoCredito.value.trim() || campoCredito.dataset.auto === '1') {
        campoCredito.value = creditoDaFoto(img);
        campoCredito.dataset.auto = '1';
      }
      botoes.forEach((b) => {
        b.classList.toggle('border-emerald-400', b === btn);
        b.classList.toggle('border-slate-700', b !== btn);
      });
      meta.textContent = 'Foto escolhida — será usada na capa ao salvar o rascunho.';
    }

    function desenhar(data) {
      const imagens = Array.isArray(data?.imagens) ? data.imagens : [];
      faixa.replaceChildren();
      botoes = [];
      if (!imagens.length) {
        meta.textContent = 'Nenhuma foto sugerida. Tente buscar por palavra.';
        return;
      }
      for (const img of imagens) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.title = img.titulo || img.fonte || '';
        btn.className =
          'relative shrink-0 overflow-hidden rounded-md border border-slate-700 bg-slate-950 hover:border-violet-400 focus:outline-none focus:ring-1 focus:ring-violet-400';
        btn.style.cssText = 'width:72px;height:90px;padding:0;flex:0 0 72px';
        const foto = document.createElement('img');
        foto.src = img.thumbnail || img.url;
        foto.alt = '';
        foto.loading = 'lazy';
        foto.decoding = 'async';
        foto.referrerPolicy = 'no-referrer';
        foto.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block';
        foto.addEventListener('error', () => btn.remove(), { once: true });
        btn.appendChild(foto);
        btn.addEventListener('click', () => escolher(img, btn));
        botoes.push(btn);
        faixa.appendChild(btn);
      }
      const partes = [data.aviso, data.pessoa, 'Clique numa miniatura para usar na capa'].filter(Boolean);
      meta.textContent = partes.join(' · ');
    }

    async function carregar({ forcar = false, consulta = '' } = {}) {
      if (!forcar && !consulta) {
        try {
          const cache = JSON.parse(sessionStorage.getItem(chaveCache) || 'null');
          if (cache?.imagens?.length) return desenhar(cache);
        } catch {
          /* sem cache */
        }
      }
      buscarNovas.disabled = true;
      botaoBusca.disabled = true;
      meta.textContent = consulta ? `Buscando “${consulta}”…` : 'Buscando fotos relacionadas…';
      try {
        const data = await api(`${API}/mensagens/${mensagem.id}/sugerir-imagens`, {
          method: 'POST',
          body: JSON.stringify(consulta ? { q: consulta, limite: 16 } : { limite: 12 }),
        });
        if (!consulta) {
          try {
            sessionStorage.setItem(chaveCache, JSON.stringify({
              aviso: data.aviso || null,
              pessoa: data.pessoa || null,
              imagens: data.imagens || [],
            }));
          } catch {
            /* cota cheia */
          }
        }
        desenhar(data);
      } catch (err) {
        meta.textContent = err.message;
      } finally {
        buscarNovas.disabled = false;
        botaoBusca.disabled = false;
      }
    }

    buscarNovas.addEventListener('click', () => carregar({ forcar: true }));
    const buscarPalavra = () => {
      const q = campoBusca.value.trim();
      if (q.length < 2) {
        meta.textContent = 'Digite pelo menos 2 caracteres para buscar.';
        return;
      }
      carregar({ consulta: q });
    };
    botaoBusca.addEventListener('click', buscarPalavra);
    campoBusca.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        buscarPalavra();
      }
    });
    campoCredito.addEventListener('input', () => {
      campoCredito.dataset.auto = '';
    });

    if ('IntersectionObserver' in window) {
      const observador = new IntersectionObserver((entradas) => {
        if (entradas.some((e) => e.isIntersecting)) {
          observador.disconnect();
          carregar();
        }
      });
      observador.observe(wrap);
    } else {
      carregar();
    }
    return wrap;
  }

  function blocoFontes(fontes = []) {
    if (!fontes.length) return null;
    const box = document.createElement('details');
    box.className = 'mia-msg-panel';
    const resumo = document.createElement('summary');
    resumo.className = '';
    resumo.textContent = `Fontes da apuração (${fontes.length})`;
    box.appendChild(resumo);
    const ul = document.createElement('ul');
    ul.className = 'mt-2 space-y-1';
    for (const f of fontes) {
      const li = document.createElement('li');
      li.className = 'text-slate-400';
      if (f.url) {
        const a = document.createElement('a');
        a.href = f.url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.className = 'text-emerald-400 underline hover:text-emerald-300';
        a.textContent = f.veiculo || 'Web';
        li.appendChild(a);
        li.appendChild(document.createTextNode(` — ${f.titulo || ''}`));
      } else {
        li.textContent = `${f.veiculo || 'Web'} — ${f.titulo || ''}`;
      }
      ul.appendChild(li);
    }
    box.appendChild(ul);
    return box;
  }

  function respostaLivreEhDePesquisaOuEscolha(conteudo) {
    const texto = String(conteudo || '').replace(/\s+/g, ' ').trim().slice(0, 5000);
    const temMateriaCompleta = /^\s*fontes?\s*:\s*\S/im.test(String(conteudo || '')) &&
      /(?:^|\n)\s*#[\p{L}\p{M}\p{N}_]+/u.test(String(conteudo || ''));
    if (temMateriaCompleta) return false;
    return (
      /^(?:vou|deixa eu|permit[aá]-me)\s+(?:pesquisar|buscar|procurar)\b/i.test(texto) ||
      /^(?:n[ãa]o|nao)\s+(?:tenho\s+acesso|consigo\s+acessar|posso\s+acessar|sou\s+capaz\s+de\s+acessar)\b/i.test(texto) ||
      /\b(?:post(?:s)?\s+do\s+x|link\s+do\s+x|linha\s+do\s+tempo|aqui\s+v[aã]o\s+os\s+posts|fontes\s+da\s+apura[cç][aã]o)\b/i.test(texto) ||
      /\b(?:minha\s+ferramenta\s+de\s+busca|p[aá]ginas\s+indexadas|n[ãa]o\s+os\s+posts\s+originais|n[ãa]o\s+o\s+feed)\b/i.test(texto) ||
      /\b(?:essa|isso)\s+n[ãa]o\s+vai\s+virar\s+mat[eé]ria\b/i.test(texto) ||
      /\b(?:n[ãa]o\s+vou\s+(?:fazer|transformar|redigir|escrever)|n[ãa]o\s+(?:entra|serve)\s+(?:na\s+)?(?:pauta|mat[eé]ria))\b/i.test(texto) ||
      /\bbriefing\s+(?:do|da)\s+jm\b/i.test(texto) ||
      /\b(?:eixos?|pauta)\s+(?:do|da)\s+jm\s+not[ií]cia\b/i.test(texto) ||
      /\bsem\s+(?:qualquer\s+)?[aâ]ngulo\s+religioso\b/i.test(texto) ||
      /\b(?:n[ãa]o\s+tenho\s+como\s+(?:gravar|salvar|memorizar)|(?:orienta[cç][oõ]es?|prefer[eê]ncias?|regras?)[\s\S]{0,45}(?:gravadas?|salvas?|memorizadas?)|mem[oó]ria\s+atualizada)\b/i.test(texto) ||
      /\bposso\s+(?:seguir|pesquisar|buscar)\b/i.test(texto) ||
      /\b(?:escolha|selecione|digite|responda\s+com)\s+(?:a\s+)?(?:op[cç][aã]o|n[uú]mero)\b/i.test(texto)
    );
  }

  function opcoesNumeradasNoTexto(conteudo) {
    return [...String(conteudo || '').matchAll(/^\s*(\d{1,2})\s*(?:\\?[.)])\s+\S/gm)]
      .map((match) => Number(match[1]))
      .filter((numero, indice, lista) => Number.isFinite(numero) && lista.indexOf(numero) === indice)
      .slice(0, 8);
  }

  function respostaPedeEscolhaNumerada(conteudo) {
    const texto = String(conteudo || '');
    const opcoes = opcoesNumeradasNoTexto(texto);
    const convite =
      /\b(?:escolha|selecione|digite|responda\s+com)\s+(?:a\s+)?(?:op[cç][aã]o|n[uú]mero)\b/i.test(texto) ||
      /\bquer\s+que\s+eu\s+(?:explore|aprofunde|siga|desenvolva)\b/i.test(texto);
    return convite && opcoes.length >= 2 ? opcoes : [];
  }

  function entradaEhEscolhaNumerada(texto) {
    const numero = String(texto || '').trim().match(/^(\d{1,2})\s*[.)]?$/)?.[1];
    if (!numero) return false;
    const corpos = [...el.mensagens.querySelectorAll('.mia-msg-ai-body')];
    const ultimaResposta = corpos[corpos.length - 1]?.textContent || '';
    return respostaPedeEscolhaNumerada(ultimaResposta).includes(Number(numero));
  }

  function blocoEscolhaNumerada(conteudo) {
    const opcoes = respostaPedeEscolhaNumerada(conteudo);
    if (!opcoes.length) return null;

    const box = document.createElement('div');
    box.className = 'mia-msg-panel mt-2 border-emerald-500/30 bg-emerald-500/5';
    const titulo = document.createElement('p');
    titulo.className = 'text-xs font-semibold text-emerald-200';
    titulo.textContent = 'Escolha uma opção';
    const ajuda = document.createElement('p');
    ajuda.className = 'mt-1 text-xs leading-5 text-slate-400';
    ajuda.textContent = `Digite no campo abaixo apenas um número: ${opcoes.join(', ')}.`;
    const usar = criarBotao(
      'Digitar uma opção',
      'mt-2 rounded-lg border border-emerald-500/50 px-3 py-1.5 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/10'
    );
    usar.addEventListener('click', () => {
      el.input.placeholder = `Digite uma opção: ${opcoes.join(', ')}`;
      el.input.focus();
    });
    box.append(titulo, ajuda, usar);
    return box;
  }

  function tituloRascunhoLivre(mensagem) {
    const conteudo = String(mensagem?.content || '').replace(/\\([#*_<>])/g, '$1');
    const explicitos = [
      /^\s*#{1,6}\s+(.{10,200})\s*$/m,
      /^\s*\*\*(.{10,200})\*\*\s*$/m,
      /^\s*(?:t[ií]tulo|manchete)\s*:\s*(.{10,200})\s*$/im,
    ];
    for (const regra of explicitos) {
      const achado = conteudo.match(regra);
      if (achado?.[1]) return achado[1].replace(/\*+/g, '').trim().slice(0, 180);
    }
    const linhas = conteudo.split(/\r?\n/);
    const preambulo = linhas.findIndex((linha) =>
      /\b(?:segue|aqui est[aá]|esta [ée])\s+(?:a\s+)?mat[eé]ria\s*:?\s*$/i.test(linha.trim())
    );
    if (preambulo >= 0) {
      for (let i = preambulo + 1; i < Math.min(linhas.length, preambulo + 5); i += 1) {
        const candidato = linhas[i]
          .trim()
          .replace(/^#{1,6}\s+/, '')
          .replace(/^\*{1,2}|\*{1,2}$/g, '')
          .trim();
        if (candidato.length >= 10 && candidato.length <= 200) return candidato.slice(0, 180);
      }
    }
    const titulo = String(mensagem?.titulo || '').replace(/^\\?#{1,6}\s*/, '').trim();
    if (titulo && !/^(achei|encontrei|aqui est[aá]|claro|vamos)\b/i.test(titulo)) {
      return titulo.slice(0, 180);
    }
    return 'Matéria criada no Claude';
  }

  function areaSalvar(mensagem, container, { livre = false } = {}) {
    const box = document.createElement('div');
    box.className = 'mia-msg-panel mt-1';

    const info = document.createElement('p');
    info.className = 'text-xs text-slate-400';
    info.textContent = livre
      ? 'Quer transformar esta resposta em matéria? Revise o título e salve como rascunho.'
      : 'Gostou? Salve como rascunho — ou peça um ajuste no campo abaixo do chat.';
    box.appendChild(info);

    const ajustesRapidos = document.createElement('div');
    ajustesRapidos.className = 'mia-review-actions';
    for (const [rotulo, pedido] of [
      ['Encurtar', 'Encurte a matéria preservando os fatos principais e os créditos.'],
      ['Melhorar abertura', 'Reescreva a abertura com estrutura própria e o fato mais relevante, sem copiar a fonte nem acrescentar fatos.'],
      ['Revisar redação', 'Revise clareza, repetições e atribuições desta matéria. Evite reproduzir frases e a estrutura das fontes; mantenha citações literais curtas e atribuídas.'],
    ]) {
      const botao = document.createElement('button');
      botao.type = 'button';
      botao.textContent = rotulo;
      botao.addEventListener('click', () => {
        if (state.enviando) return;
        const ajuste = `${pedido}\nMatéria: ${mensagem.titulo || String(mensagem.content || '').slice(0, 180)}`;
        el.input.value = [el.input.value.trim(), ajuste].filter(Boolean).join('\n\n');
        autoGrowInput();
        el.input.focus();
        setStatus('Revise o pedido e envie para aplicar o ajuste.');
      });
      ajustesRapidos.appendChild(botao);
    }
    box.appendChild(ajustesRapidos);

    let tituloLivre = null;
    if (livre) {
      tituloLivre = document.createElement('input');
      tituloLivre.type = 'text';
      tituloLivre.maxLength = 180;
      tituloLivre.value = tituloRascunhoLivre(mensagem);
      tituloLivre.placeholder = 'Título da matéria';
      tituloLivre.className =
        'mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs font-medium text-slate-100 placeholder:text-slate-600 focus:border-emerald-500 focus:outline-none';
      box.appendChild(tituloLivre);
    }

    // No Claude Livre, as sugestões são pedidas antes de a resposta virar um
    // rascunho; no chat normal elas já podem vir gravadas na mensagem.
    let tituloEscolhido = null;
    let opcoesTitulos = [];
    let listaTitulos = null;
    let tituloPrincipalAtual = '';
    const alternativos = Array.isArray(mensagem.titulosAlternativos)
      ? mensagem.titulosAlternativos.filter(Boolean).slice(0, 3)
      : [];

    function mostrarTitulosAlternativos(titulos) {
      const tituloPrincipal = String(
        livre
          ? tituloLivre?.value || tituloRascunhoLivre(mensagem)
          : mensagem.titulo || (mensagem.content || '').split('\n')[0].trim()
      ).trim();
      const sugestoes = [...new Set((titulos || []).map((t) => String(t || '').trim()))]
        .filter((t) => t && t !== tituloPrincipal)
        .slice(0, 3);
      if (!tituloPrincipal || !sugestoes.length) return;

      tituloPrincipalAtual = tituloPrincipal;
      if (!listaTitulos) {
        const wrap = document.createElement('div');
        wrap.className = 'mt-2 rounded-lg border border-slate-800 bg-slate-950/60 p-2';
        const label = document.createElement('p');
        label.className = 'text-[11px] font-semibold uppercase tracking-wide text-slate-500';
        label.textContent = 'Títulos sugeridos pelo Claude';
        wrap.appendChild(label);
        listaTitulos = document.createElement('div');
        listaTitulos.className = 'mt-1.5 grid gap-1.5';
        wrap.appendChild(listaTitulos);
        const dica = document.createElement('p');
        dica.className = 'mt-1.5 text-[11px] text-slate-500';
        dica.textContent = 'Clique em um título para usá-lo no rascunho.';
        wrap.appendChild(dica);
        box.appendChild(wrap);
      }

      listaTitulos.replaceChildren();
      opcoesTitulos = [];
      const marcar = (btn) => {
        const escolhido = btn.dataset.titulo || '';
        if (livre && tituloLivre) tituloLivre.value = escolhido;
        tituloEscolhido = livre || escolhido === tituloPrincipalAtual ? null : escolhido;
        opcoesTitulos.forEach((opcao) => {
          const ativo = opcao === btn;
          opcao.className =
            'w-full rounded-md border px-2.5 py-1.5 text-left text-xs leading-snug transition ' +
            (ativo
              ? 'border-emerald-500 bg-emerald-500/10 text-emerald-200'
              : 'border-slate-700 text-slate-300 hover:border-emerald-500/60 hover:text-white');
        });
      };
      for (const opcao of [tituloPrincipal, ...sugestoes]) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.dataset.titulo = opcao;
        btn.textContent = opcao === tituloPrincipal ? `${opcao}  (atual)` : opcao;
        btn.addEventListener('click', () => marcar(btn));
        opcoesTitulos.push(btn);
        listaTitulos.appendChild(btn);
      }
      marcar(opcoesTitulos[0]);
    }

    if (alternativos.length) mostrarTitulosAlternativos(alternativos);

    const grid = document.createElement('div');
    grid.className = 'mt-2 grid gap-2 md:grid-cols-2';
    const imagem = document.createElement('input');
    imagem.type = 'url';
    imagem.setAttribute('aria-label', 'URL da imagem da capa');
    imagem.placeholder = 'URL da imagem da capa (opcional)';
    imagem.className =
      'w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100 placeholder:text-slate-600 focus:border-emerald-500 focus:outline-none';
    const credito = document.createElement('input');
    credito.type = 'text';
    credito.setAttribute('aria-label', 'Crédito da foto');
    credito.placeholder = 'Crédito da foto (ex.: Reprodução/Instagram)';
    credito.className = imagem.className;
    grid.appendChild(imagem);
    grid.appendChild(credito);
    const opcoesImagem = document.createElement('details');
    opcoesImagem.className = 'mia-image-options';
    const resumoImagem = document.createElement('summary');
    resumoImagem.textContent = 'Imagem de capa e crédito (opcional)';
    opcoesImagem.appendChild(resumoImagem);
    const dicaImagem = document.createElement('p');
    dicaImagem.textContent = 'Ao salvar, o sistema tenta aproveitar a imagem extraída da fonte. Confira a foto no editor antes de publicar, ou informe outra URL abaixo.';
    opcoesImagem.appendChild(dicaImagem);
    opcoesImagem.appendChild(grid);
    if (!mensagem.matterId) box.appendChild(faixaFotosSugeridas(mensagem, imagem, credito));
    box.appendChild(opcoesImagem);

    const acoes = document.createElement('div');
    acoes.className = 'mt-2 grid gap-2 sm:flex sm:flex-wrap sm:items-center';

    const salvar = criarBotao(
      'Salvar como rascunho',
      'rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-emerald-400'
    );
    const sugerirTitulos = livre
      ? criarBotao(
          alternativos.length ? 'Gerar outros 3 com Claude' : 'Sugerir 3 com Claude',
          'rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-1.5 text-xs font-semibold text-amber-100 hover:bg-amber-500/20'
        )
      : null;
    const aviso = document.createElement('span');
    aviso.className = 'text-xs text-slate-400';

    sugerirTitulos?.addEventListener('click', async () => {
      sugerirTitulos.disabled = true;
      const rotulo = sugerirTitulos.textContent;
      sugerirTitulos.textContent = 'Sugerindo…';
      aviso.textContent = 'Claude está gerando 3 títulos…';
      try {
        const data = await api(`${API}/mensagens/${mensagem.id}/titulos-alternativos`, {
          method: 'POST',
          body: JSON.stringify({
            tituloAtual: tituloLivre?.value.trim() || null,
            tom: el.tom?.value || 'natural',
          }),
        });
        mostrarTitulosAlternativos(data.titulos || []);
        aviso.textContent = '3 títulos prontos — escolha um para usar no rascunho.';
      } catch (err) {
        aviso.textContent = err.message;
      } finally {
        sugerirTitulos.disabled = false;
        sugerirTitulos.textContent = rotulo || 'Gerar outros 3 com Claude';
      }
    });

    // Salva o rascunho uma única vez; publicar/agendar reaproveitam o mesmo id.
    let salvando = null;
    function mostrarLinkRascunho(id, texto) {
      aviso.replaceChildren();
      const link = document.createElement('a');
      link.href = `/materias-ia/${id}`;
      link.target = '_blank';
      link.rel = 'noopener';
      link.className = 'text-emerald-300 underline hover:text-emerald-200';
      link.textContent = texto || `Rascunho #${id} — abrir`;
      aviso.appendChild(link);
    }
    function marcarSalvo() {
      salvar.disabled = true;
      salvar.textContent = 'Rascunho salvo';
      salvar.classList.add('opacity-60');
    }
    async function garantirRascunho() {
      if (mensagem.matterId) return mensagem.matterId;
      if (!salvando) {
        salvando = api(`${API}/mensagens/${mensagem.id}/materia`, {
          method: 'POST',
          body: JSON.stringify({
            imagemUrl: imagem.value.trim() || null,
            creditoImagem: credito.value.trim() || null,
            titulo: livre ? tituloLivre?.value.trim() || null : tituloEscolhido,
          }),
        }).then((data) => {
          mensagem.matterId = data.matterId;
          marcarSalvo();
          return data.matterId;
        }).finally(() => {
          salvando = null;
        });
      }
      return salvando;
    }

    const publicarAgora = criarBotao(
      'Publicar agora',
      'rounded-lg border border-sky-400/60 bg-sky-500/15 px-3 py-1.5 text-xs font-semibold text-sky-100 hover:bg-sky-500/25 disabled:opacity-50'
    );
    const agendarBtn = criarBotao(
      'Agendar',
      'rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-1.5 text-xs font-semibold text-amber-100 hover:bg-amber-500/20 disabled:opacity-50'
    );

    // Linha de agendamento: abre ao clicar em "Agendar".
    const linhaAgenda = document.createElement('div');
    linhaAgenda.className = 'mt-2 hidden flex-wrap items-center gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 p-2';
    const campoData = document.createElement('input');
    campoData.type = 'datetime-local';
    campoData.setAttribute('aria-label', 'Data e horário do agendamento (Araguaína)');
    campoData.className =
      'rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100 focus:border-amber-400 focus:outline-none';
    const mais30 = criarBotao(
      '+30 min após o último',
      'hidden rounded border border-amber-500/40 px-2 py-1 text-[11px] text-amber-100 hover:bg-amber-500/10'
    );
    const confirmarAgenda = criarBotao(
      'Confirmar agendamento',
      'rounded-md bg-amber-500 px-3 py-1 text-xs font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-50'
    );
    const fuso = document.createElement('span');
    fuso.className = 'text-[10px] uppercase tracking-wide text-amber-300/60';
    fuso.textContent = 'Horário de Araguaína';
    linhaAgenda.append(campoData, mais30, confirmarAgenda, fuso);

    function bloquearAcoes(sim) {
      publicarAgora.disabled = sim;
      agendarBtn.disabled = sim;
      confirmarAgenda.disabled = sim;
    }
    function finalizar(texto, id) {
      mostrarLinkRascunho(id, texto);
      publicarAgora.classList.add('hidden');
      agendarBtn.classList.add('hidden');
      linhaAgenda.classList.add('hidden');
      linhaAgenda.classList.remove('flex');
    }

    salvar.addEventListener('click', async () => {
      salvar.disabled = true;
      salvar.classList.add('opacity-60');
      aviso.textContent = 'Salvando rascunho…';
      try {
        const id = await garantirRascunho();
        mostrarLinkRascunho(id, `Rascunho #${id} — abrir para revisar e publicar`);
      } catch (err) {
        aviso.textContent = err.message;
        salvar.disabled = false;
        salvar.classList.remove('opacity-60');
      }
    });

    publicarAgora.addEventListener('click', async () => {
      if (!window.confirm('Publicar esta matéria agora no Facebook?')) return;
      bloquearAcoes(true);
      aviso.textContent = mensagem.matterId ? 'Publicando…' : 'Salvando e publicando…';
      try {
        const id = await garantirRascunho();
        aviso.textContent = 'Publicando — pode levar alguns segundos…';
        const data = await api(`/api/materias-ia/matters/${id}/publicar`, {
          method: 'POST',
          body: JSON.stringify({ tipoPublicacao: 'auto', publicarFacebook: true, sync: true }),
        });
        if (data.queued) {
          finalizar(`Na fila de publicação — Rascunho #${id}`, id);
        } else {
          finalizar(`Publicada ✓ — abrir matéria #${id}`, id);
          if (data.link) {
            const post = document.createElement('a');
            post.href = data.link;
            post.target = '_blank';
            post.rel = 'noopener';
            post.className = 'ml-2 text-sky-300 underline hover:text-sky-200';
            post.textContent = 'ver post';
            aviso.appendChild(post);
          }
        }
        if (data.instagramErro) aviso.append(` · Instagram: ${data.instagramErro}`);
      } catch (err) {
        aviso.textContent = err.message;
        bloquearAcoes(false);
      }
    });

    agendarBtn.addEventListener('click', async () => {
      const abrir = linhaAgenda.classList.contains('hidden');
      linhaAgenda.classList.toggle('hidden', !abrir);
      linhaAgenda.classList.toggle('flex', abrir);
      if (!abrir) return;
      campoData.focus();
      try {
        const slot = await api('/api/materias-ia/agenda/proximo-slot');
        if (slot.proximoSlotLocal) {
          mais30.dataset.slot = slot.proximoSlotLocal;
          mais30.textContent = `+30 min após o último${slot.proximoSlotLabel ? ' → ' + slot.proximoSlotLabel : ''}`;
          mais30.classList.remove('hidden');
        }
      } catch {
        /* sem sugestão de horário */
      }
    });
    mais30.addEventListener('click', () => {
      if (mais30.dataset.slot) campoData.value = mais30.dataset.slot;
    });
    confirmarAgenda.addEventListener('click', async () => {
      if (!campoData.value) {
        aviso.textContent = 'Escolha a data e o horário do agendamento.';
        campoData.focus();
        return;
      }
      bloquearAcoes(true);
      aviso.textContent = mensagem.matterId ? 'Agendando…' : 'Salvando e agendando…';
      try {
        const id = await garantirRascunho();
        await api(`/api/materias-ia/matters/${id}/agendar`, {
          method: 'POST',
          body: JSON.stringify({ run_at: campoData.value }),
        });
        const [data, hora] = campoData.value.split('T');
        finalizar(`Agendada ✓ ${data.split('-').reverse().join('/')} ${hora} — abrir matéria #${id}`, id);
      } catch (err) {
        aviso.textContent = err.message;
        bloquearAcoes(false);
      }
    });

    if (sugerirTitulos) acoes.appendChild(sugerirTitulos);
    acoes.appendChild(salvar);
    acoes.appendChild(publicarAgora);
    acoes.appendChild(agendarBtn);
    acoes.appendChild(aviso);
    box.appendChild(acoes);
    box.appendChild(linhaAgenda);

    if (mensagem.matterId) {
      marcarSalvo();
      mostrarLinkRascunho(mensagem.matterId);
      // Rascunho já existente: se já foi publicado ou agendado, mostra isso em
      // vez de oferecer publicar de novo.
      api(`/api/materias-ia/matters/${mensagem.matterId}`)
        .then(({ matter }) => {
          const st = String(matter?.status || '');
          if (st === 'publicado') finalizar(`Publicada ✓ — abrir matéria #${mensagem.matterId}`, mensagem.matterId);
          else if (st === 'agendado') {
            agendarBtn.textContent = 'Remarcar';
            aviso.append(' · agendada');
          }
        })
        .catch(() => {});
    }

    container.appendChild(box);
  }

  /**
   * Resposta com várias matérias: exibe somente uma lista compacta e permite
   * escolher quais itens serão salvos como rascunhos separados.
   */
  function areaSalvarVarias(mensagem, container) {
    const materias = Array.isArray(mensagem.materias) ? mensagem.materias : [];
    const box = document.createElement('div');
    box.className = 'mia-msg-panel mt-1';

    const info = document.createElement('p');
    info.className = 'text-sm font-medium text-white';
    info.textContent = materias.length + ' matérias criadas';
    box.appendChild(info);

    const ajuda = document.createElement('p');
    ajuda.className = 'mt-1 text-xs text-slate-400';
    ajuda.textContent = 'Confira o título e a prévia, marque as que deseja guardar e salve como rascunho.';
    box.appendChild(ajuda);

    const selecionados = new Set(
      materias
        .filter((materia) => materia.salvavel && !materia.matterId)
        .map((materia) => Number(materia.indice))
    );
    const controles = new Map();

    const ferramentas = document.createElement('div');
    ferramentas.className = 'mt-3 flex flex-wrap items-center gap-2';
    const selecionarTodas = criarBotao(
      'Selecionar todas',
      'rounded-lg border border-slate-700 px-2.5 py-1 text-[11px] font-semibold text-slate-200 hover:border-emerald-500'
    );
    const limparSelecao = criarBotao(
      'Limpar seleção',
      'rounded-lg border border-slate-700 px-2.5 py-1 text-[11px] font-semibold text-slate-400 hover:border-slate-500 hover:text-white'
    );
    ferramentas.appendChild(selecionarTodas);
    ferramentas.appendChild(limparSelecao);
    box.appendChild(ferramentas);

    const lista = document.createElement('div');
    lista.className = 'mt-3 space-y-2';
    box.appendChild(lista);

    const rodape = document.createElement('div');
    rodape.className = 'mt-3 flex flex-wrap items-center gap-2';
    const salvarSelecionadas = criarBotao(
      '',
      'rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50'
    );
    const credito = document.createElement('input');
    credito.type = 'text';
    credito.placeholder = 'Crédito da foto (opcional)';
    credito.className =
      'w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs text-slate-100 placeholder:text-slate-600 focus:border-emerald-500 focus:outline-none sm:w-56';
    const aviso = document.createElement('span');
    aviso.className = 'w-full text-xs text-slate-400';
    rodape.appendChild(salvarSelecionadas);
    rodape.appendChild(credito);
    rodape.appendChild(aviso);
    box.appendChild(rodape);

    const atualizarAcao = () => {
      const total = selecionados.size;
      salvarSelecionadas.disabled = total === 0;
      salvarSelecionadas.textContent =
        total === 1 ? 'Salvar 1 selecionada' : 'Salvar ' + total + ' selecionadas';
    };

    const linkRascunho = (matterId) => {
      const abrir = document.createElement('a');
      abrir.href = '/materias-ia/' + matterId;
      abrir.target = '_blank';
      abrir.rel = 'noopener';
      abrir.className = 'text-[11px] font-medium text-emerald-300 underline hover:text-emerald-200';
      abrir.textContent = 'Rascunho #' + matterId + ' — abrir';
      abrir.addEventListener('click', (event) => event.stopPropagation());
      return abrir;
    };

    const marcarSalva = (indice, matterId) => {
      const controle = controles.get(Number(indice));
      if (!controle) return;
      selecionados.delete(Number(indice));
      controle.check.checked = false;
      controle.check.disabled = true;
      controle.card.classList.add('opacity-60');
      controle.estado.replaceChildren(linkRascunho(matterId));
      atualizarAcao();
    };

    materias.forEach((materia, posicao) => {
      const card = document.createElement('label');
      card.className =
        'flex cursor-pointer items-start gap-3 rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-3 transition hover:border-slate-700';

      const check = document.createElement('input');
      check.type = 'checkbox';
      check.className = 'mt-0.5 h-4 w-4 shrink-0 accent-emerald-500';
      check.checked = selecionados.has(Number(materia.indice));
      check.disabled = !materia.salvavel || Boolean(materia.matterId);
      card.appendChild(check);

      const conteudo = document.createElement('span');
      conteudo.className = 'min-w-0 flex-1';

      const titulo = document.createElement('span');
      titulo.className = 'block text-xs font-semibold leading-5 text-white';
      titulo.textContent = posicao + 1 + '. ' + (materia.titulo || 'Matéria sem título');
      conteudo.appendChild(titulo);

      if (materia.previa) {
        const previa = document.createElement('span');
        previa.className = 'mt-1 block text-[11px] leading-4 text-slate-400';
        previa.textContent = materia.previa + (materia.previa.endsWith('…') ? '' : '…');
        conteudo.appendChild(previa);
      }

      const meta = document.createElement('span');
      meta.className = 'mt-2 flex flex-wrap items-center gap-2';
      const estado = document.createElement('span');
      estado.className = 'text-[11px] text-slate-500';
      meta.appendChild(estado);

      if (materia.fonte?.url) {
        const fonte = document.createElement('a');
        fonte.href = materia.fonte.url;
        fonte.target = '_blank';
        fonte.rel = 'noopener noreferrer';
        fonte.className = 'text-[11px] text-sky-300 underline hover:text-sky-200';
        fonte.textContent = materia.fonte.veiculo || materia.fonte.plataforma || 'Abrir fonte';
        fonte.addEventListener('click', (event) => event.stopPropagation());
        meta.appendChild(fonte);
      }
      conteudo.appendChild(meta);
      card.appendChild(conteudo);

      if (!materia.salvavel) estado.textContent = 'Texto curto demais para salvar';
      controles.set(Number(materia.indice), { card, check, estado });

      check.addEventListener('change', () => {
        if (check.checked) selecionados.add(Number(materia.indice));
        else selecionados.delete(Number(materia.indice));
        atualizarAcao();
      });

      lista.appendChild(card);
      if (materia.matterId) marcarSalva(materia.indice, materia.matterId);
    });

    selecionarTodas.addEventListener('click', () => {
      for (const materia of materias) {
        const controle = controles.get(Number(materia.indice));
        if (!controle || controle.check.disabled) continue;
        controle.check.checked = true;
        selecionados.add(Number(materia.indice));
      }
      atualizarAcao();
    });

    limparSelecao.addEventListener('click', () => {
      selecionados.clear();
      for (const controle of controles.values()) {
        if (!controle.check.disabled) controle.check.checked = false;
      }
      atualizarAcao();
    });

    salvarSelecionadas.addEventListener('click', async () => {
      const indices = [...selecionados];
      if (!indices.length) return;
      salvarSelecionadas.disabled = true;
      salvarSelecionadas.classList.add('opacity-60');
      aviso.textContent = 'Salvando rascunhos…';
      try {
        const data = await api(API + '/mensagens/' + mensagem.id + '/materias', {
          method: 'POST',
          body: JSON.stringify({
            indices,
            creditoImagem: credito.value.trim() || null,
          }),
        });

        for (const salva of data.salvas || []) {
          marcarSalva(salva.indice, salva.matterId);
        }

        aviso.replaceChildren();
        const resumo = document.createElement('span');
        resumo.className = data.erros?.length ? 'text-amber-300' : 'text-emerald-300';
        resumo.textContent = data.mensagem || 'Rascunhos criados.';
        aviso.appendChild(resumo);

        const abrir = document.createElement('a');
        abrir.href = '/minhas-materias';
        abrir.className = 'ml-2 text-emerald-300 underline hover:text-emerald-200';
        abrir.textContent = 'ver em Matérias salvas';
        aviso.appendChild(abrir);
      } catch (err) {
        aviso.textContent = err.message;
      } finally {
        salvarSelecionadas.classList.remove('opacity-60');
        atualizarAcao();
      }
    });

    atualizarAcao();
    container.appendChild(box);
  }

  /**
   * Cartões das matérias encontradas no modo "Pesquisar pautas".
   * Escolher uma monta o pedido de reescrita com furo e já envia.
   */
  function textoPedidoPautasSelecionadas(pautas = []) {
    const lista = (Array.isArray(pautas) ? pautas : []).filter(Boolean);
    if (lista.length <= 1) {
      const pauta = lista[0] || {};
      return [
        'Reescreva esta matéria com furo de reportagem, texto totalmente original e sem plagiar:',
        `Título: ${pauta.titulo || ''}`,
        `Veículo: ${pauta.veiculo || ''}`,
        `Link: ${pauta.url || ''}`,
        'Pesquise também mais informações recentes sobre esse assunto para acrescentar contexto e dados novos.',
      ].join('\n');
    }

    const blocos = lista.map((pauta, indice) =>
      [
        `### PAUTA ${indice + 1}`,
        `Título: ${pauta.titulo || ''}`,
        `Veículo: ${pauta.veiculo || ''}`,
        `Link: ${pauta.url || ''}`,
        pauta.resumo ? `Resumo: ${pauta.resumo}` : null,
      ]
        .filter(Boolean)
        .join('\n')
    );

    return [
      `Escreva ${lista.length} matérias, uma para cada pauta selecionada, com furo de reportagem, texto totalmente original e sem plagiar.`,
      `Limite obrigatório: escreva exatamente ${lista.length} matérias e pare na MATERIA ${lista.length}. Não crie pauta extra, variação, resumo adicional nem continuação.`,
      'Entregue tudo na mesma resposta. Separe cada texto com "### MATERIA n", seguido do título, corpo e hashtags daquela matéria.',
      'Não misture os fatos: cada matéria deve usar a pauta/link correspondente como base principal.',
      '',
      ...blocos,
      '',
      'Pesquise também mais informações recentes sobre cada assunto para acrescentar contexto e dados novos.',
    ].join('\n');
  }

  function marcarPautasComoEscritas(pautas = []) {
    (Array.isArray(pautas) ? pautas : []).forEach((pauta) => marcarPautaEscrita(pauta?.url));
  }

  /** Monta o pedido de reescrita da pauta e já envia. */
  function pedirReescritaLote(pautas) {
    if (state.enviando) return;
    const lista = (Array.isArray(pautas) ? pautas : []).filter(Boolean);
    if (!lista.length) return;
    definirModo('escrever');
    // Recolhe a lista longa e ancora a matéria no topo: o usuário lê de cima,
    // sem precisar rolar até o fim da conversa.
    el.mensagens.querySelectorAll('[data-pautas="1"]').forEach((b) => b.colapsar?.());
    state.ancorarTopo = true;
    el.input.value = textoPedidoPautasSelecionadas(lista);
    marcarPautasComoEscritas(lista);
    enviar();
  }

  function pedirReescrita(pauta) {
    pedirReescritaLote([pauta]);
  }

  async function salvarRascunhosDePautas(pautas = []) {
    const lista = (Array.isArray(pautas) ? pautas : []).filter(Boolean);
    if (!lista.length) throw new Error('Selecione ao menos uma pauta.');
    const salvas = [];
    const erros = [];
    for (let inicio = 0; inicio < lista.length; inicio += MAX_PAUTAS_LOTE) {
      const lote = lista.slice(inicio, inicio + MAX_PAUTAS_LOTE);
      try {
        const data = await api(`${API}/pautas/rascunhos`, {
          method: 'POST',
          body: JSON.stringify({
            pautas: lote,
            pesquisarWeb: state.pesquisarWeb,
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

  function blocoPautas(pautas = []) {
    if (!Array.isArray(pautas) || !pautas.length) return null;

    // Guarda para o atalho "continuar desta pesquisa" depois da matéria
    state.ultimasPautas = pautas;

    const box = document.createElement('div');
    box.className = 'mia-msg-pautas';
    const listaFacebook = pautas.some((pauta) => Boolean(pauta?.pagina));
    const limiteSelecao = listaFacebook ? pautas.length : Math.min(MAX_PAUTAS_LOTE, pautas.length);
    if (listaFacebook) box.classList.add('is-facebook-page');
    box.dataset.pautas = '1';
    const selecionadas = new Map();
    const checkboxes = [];

    const cabecalho = document.createElement('div');
    cabecalho.className = 'mia-msg-pautas-head';
    const titulo = document.createElement('p');
    titulo.className = 'mia-msg-pautas-title';
    titulo.textContent = listaFacebook
      ? `Escolha os posts para transformar em matéria (${pautas.length})`
      : `Escolha uma ou mais pautas para salvar (${pautas.length})`;
    cabecalho.appendChild(titulo);

    const acoesCabecalho = document.createElement('div');
    acoesCabecalho.className = 'mia-msg-pautas-head-actions';
    const selecionarTodas = criarBotao(
      listaFacebook ? `Selecionar todos (${pautas.length})` : `Selecionar até ${limiteSelecao}`,
      'mia-chat-ghost-btn'
    );
    const salvarSelecionadas = criarBotao(
      'Salvar rascunhos',
      'mia-chat-btn-primary mia-msg-pautas-batch-btn'
    );
    salvarSelecionadas.disabled = true;
    salvarSelecionadas.classList.add('opacity-60');
    const gerarSelecionadas = criarBotao('Gerar no chat', 'mia-chat-ghost-btn');
    gerarSelecionadas.disabled = true;
    gerarSelecionadas.classList.add('opacity-60');
    const alternar = criarBotao('Recolher lista', 'mia-chat-ghost-btn');
    acoesCabecalho.appendChild(selecionarTodas);
    acoesCabecalho.appendChild(salvarSelecionadas);
    acoesCabecalho.appendChild(gerarSelecionadas);
    acoesCabecalho.appendChild(alternar);
    cabecalho.appendChild(acoesCabecalho);
    box.appendChild(cabecalho);

    const lista = document.createElement('div');
    lista.className = 'mia-msg-pautas-list';
    box.appendChild(lista);

    function atualizarLote() {
      const total = selecionadas.size;
      const ocupado = state.enviando || state.salvandoPautas;
      salvarSelecionadas.disabled = total === 0 || ocupado;
      salvarSelecionadas.classList.toggle('opacity-60', total === 0 || ocupado);
      salvarSelecionadas.textContent = total
        ? `Salvar ${total} rascunho(s)`
        : 'Salvar rascunhos';
      gerarSelecionadas.disabled = total === 0 || ocupado;
      gerarSelecionadas.classList.toggle('opacity-60', total === 0 || ocupado);
      selecionarTodas.textContent = total
        ? 'Limpar seleção'
        : listaFacebook
          ? `Selecionar todos (${pautas.length})`
          : `Selecionar até ${limiteSelecao}`;
    }

    selecionarTodas.addEventListener('click', () => {
      if (selecionadas.size) {
        selecionadas.clear();
        checkboxes.forEach((item) => {
          item.input.checked = false;
          item.card.classList.remove('is-selected');
        });
        atualizarLote();
        return;
      }

      checkboxes.forEach((item, indice) => {
        const marcar = indice < limiteSelecao;
        item.input.checked = marcar;
        item.card.classList.toggle('is-selected', marcar);
        if (marcar) selecionadas.set(item.key, item.pauta);
      });
      if (!listaFacebook && checkboxes.length > limiteSelecao) {
        setStatus(`Selecionei as ${MAX_PAUTAS_LOTE} primeiras pautas. Salve esse lote e depois escolha mais.`);
      }
      atualizarLote();
    });

    salvarSelecionadas.addEventListener('click', async () => {
      const alvos = [...selecionadas.values()];
      if (!alvos.length) {
        setStatus('Marque ao menos uma pauta.');
        return;
      }
      if (!listaFacebook && alvos.length > MAX_PAUTAS_LOTE) {
        setStatus(`Selecione no máximo ${MAX_PAUTAS_LOTE} pautas por vez.`);
        return;
      }
      const itensSelecionados = checkboxes.filter((item) => selecionadas.has(item.key));
      state.salvandoPautas = true;
      salvarSelecionadas.textContent = 'Salvando rascunhos...';
      setStatus(`Gerando e salvando ${alvos.length} rascunho(s) das pautas selecionadas...`);
      atualizarLote();
      try {
        const data = await salvarRascunhosDePautas(alvos);
        (data.salvas || []).forEach((salva) => {
          const item = itensSelecionados[Number(salva.indice) - 1];
          if (item) item.marcarEscrita();
        });
        setStatus(data.mensagem || 'Rascunhos criados.');
        const aviso = document.createElement('div');
        aviso.className = 'mia-msg-panel mt-1 text-xs text-emerald-200';
        const link = document.createElement('a');
        link.href = '/minhas-materias';
        link.className = 'text-emerald-300 underline hover:text-emerald-200';
        link.textContent = data.mensagem || 'Rascunhos criados. Abrir Matérias salvas';
        aviso.appendChild(link);
        if (data.erros?.length) {
          const falhas = document.createElement('span');
          falhas.className = 'ml-2 text-amber-300';
          falhas.textContent = `${data.erros.length} falha(s).`;
          aviso.appendChild(falhas);
        }
        box.insertBefore(aviso, lista);
      } catch (err) {
        setStatus(err.message);
      } finally {
        state.salvandoPautas = false;
        atualizarLote();
      }
    });

    gerarSelecionadas.addEventListener('click', () => {
      const alvos = [...selecionadas.values()];
      if (!alvos.length) {
        setStatus('Marque ao menos uma pauta.');
        return;
      }
      if (!listaFacebook && alvos.length > MAX_PAUTAS_LOTE) {
        setStatus(`Selecione no máximo ${MAX_PAUTAS_LOTE} pautas por vez.`);
        return;
      }
      checkboxes
        .filter((item) => selecionadas.has(item.key))
        .forEach((item) => item.marcarEscrita());
      pedirReescritaLote(alvos);
    });

    box.expandir = () => {
      lista.classList.remove('hidden');
      alternar.textContent = 'Recolher lista';
    };
    box.colapsar = () => {
      lista.classList.add('hidden');
      const escritas = pautas.filter((p) => pautaJaEscrita(p.url)).length;
      alternar.textContent = `Mostrar lista (${pautas.length - escritas} restantes)`;
    };
    alternar.addEventListener('click', () => {
      if (lista.classList.contains('hidden')) box.expandir();
      else box.colapsar();
    });

    pautas.forEach((pauta, indice) => {
      const escrita = pautaJaEscrita(pauta.url);
      const key = pauta.url || `${indice}:${pauta.titulo || ''}:${pauta.veiculo || ''}`;

      const card = document.createElement('article');
      card.className = escrita ? 'mia-msg-pauta is-done' : 'mia-msg-pauta';

      const meta = document.createElement('div');
      meta.className = 'mia-msg-pauta-meta';
      const selecionar = document.createElement('label');
      selecionar.className = 'mia-msg-pauta-check';
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.setAttribute('aria-label', `Selecionar pauta ${indice + 1}`);
      selecionar.appendChild(check);
      meta.appendChild(selecionar);
      const num = document.createElement('span');
      num.className = 'mia-msg-pauta-num';
      num.textContent = String(indice + 1);
      meta.appendChild(num);
      const veiculo = document.createElement('span');
      veiculo.className = 'mia-msg-pauta-veiculo';
      veiculo.textContent = pauta.veiculo || 'Web';
      meta.appendChild(veiculo);
      const selo = document.createElement('span');
      selo.className = escrita ? 'mia-msg-pauta-selo' : 'hidden';
      selo.textContent = 'Já escrita ✓';
      selo.dataset.selo = '1';
      meta.appendChild(selo);
      card.appendChild(meta);

      const h = document.createElement('p');
      h.className = 'mia-msg-pauta-titulo';
      h.textContent = pauta.titulo || 'Sem título';
      card.appendChild(h);

      if (pauta.imagem) {
        card.classList.add('has-image');
        const img = document.createElement('img');
        img.src = pauta.imagem;
        img.alt = '';
        img.loading = 'lazy';
        img.referrerPolicy = 'no-referrer';
        img.className = 'mia-msg-pauta-imagem';
        img.addEventListener('error', () => img.remove());
        card.appendChild(img);
      }

      if (pauta.resumo) {
        const r = document.createElement('p');
        r.className = 'mia-msg-pauta-resumo';
        r.textContent = listaFacebook
          ? String(pauta.resumo).replace(/\s+/g, ' ').slice(0, 180)
          : pauta.resumo;
        card.appendChild(r);
      }

      const acoes = document.createElement('div');
      acoes.className = 'mia-msg-pauta-acoes';

      const escrever = criarBotao(
        escrita ? 'Escrever de novo' : 'Reescrever com furo',
        escrita ? 'mia-chat-ghost-btn' : 'mia-chat-btn-primary'
      );
      const marcarEscrita = () => {
        selecionadas.delete(key);
        check.checked = false;
        card.classList.remove('is-selected');
        selo.className = 'mia-msg-pauta-selo';
        selo.textContent = 'Já escrita ✓';
        escrever.textContent = 'Escrever de novo';
        escrever.className = 'mia-chat-ghost-btn';
        card.className = 'mia-msg-pauta is-done';
        atualizarLote();
      };
      selecionar.addEventListener('click', (ev) => ev.stopPropagation());
      check.addEventListener('change', () => {
        if (check.checked && !selecionadas.has(key) && selecionadas.size >= limiteSelecao) {
          check.checked = false;
          setStatus(`Selecione no máximo ${limiteSelecao} pautas por vez.`);
          return;
        }
        if (check.checked) selecionadas.set(key, pauta);
        else selecionadas.delete(key);
        card.classList.toggle('is-selected', check.checked);
        atualizarLote();
      });
      card.addEventListener('click', (ev) => {
        if (ev.target.closest('button,a,input,label')) return;
        check.checked = !check.checked;
        check.dispatchEvent(new Event('change', { bubbles: true }));
      });
      escrever.addEventListener('click', () => {
        // Marca o cartão na hora, sem esperar recarregar a conversa
        marcarEscrita();
        pedirReescrita(pauta);
      });
      acoes.appendChild(escrever);
      checkboxes.push({ input: check, card, key, pauta, marcarEscrita });

      if (pauta.url) {
        const abrir = document.createElement('a');
        abrir.href = pauta.url;
        abrir.target = '_blank';
        abrir.rel = 'noopener';
        abrir.className = 'mia-chat-ghost-btn';
        abrir.textContent = 'Ler original ↗';
        acoes.appendChild(abrir);
      }

      card.appendChild(acoes);
      lista.appendChild(card);
    });

    atualizarLote();
    return box;
  }

  /**
   * Depois da matéria pronta: escolher outra pauta da mesma pesquisa
   * ou começar uma pesquisa nova, sem precisar rolar a conversa.
   */
  function blocoContinuar() {
    const pautas = state.ultimasPautas || [];
    if (!pautas.length) return null;

    const restantes = pautas.filter((p) => !pautaJaEscrita(p.url));

    const box = document.createElement('div');
    box.className = 'mia-msg-panel mt-1';

    const titulo = document.createElement('p');
    titulo.className = 'text-[11px] font-semibold uppercase tracking-wider text-slate-500';
    titulo.textContent = restantes.length
      ? `Continuar desta pesquisa — ${restantes.length} pauta(s) restante(s)`
      : 'Você já escreveu todas as pautas desta pesquisa';
    box.appendChild(titulo);

    if (restantes.length) {
      const lista = document.createElement('div');
      lista.className = 'mt-2 space-y-1.5';
      restantes.slice(0, 6).forEach((pauta) => {
        const linha = document.createElement('button');
        linha.type = 'button';
        linha.className =
          'flex w-full items-start gap-2 rounded-lg border border-slate-800 px-2.5 py-2 text-left transition hover:border-emerald-500/50 hover:bg-slate-900';
        const seta = document.createElement('span');
        seta.className = 'mt-0.5 shrink-0 text-[11px] text-emerald-400';
        seta.textContent = '↻';
        linha.appendChild(seta);
        const txt = document.createElement('span');
        txt.className = 'min-w-0';
        const t = document.createElement('span');
        t.className = 'block text-xs font-medium leading-snug text-slate-200';
        t.textContent = pauta.titulo || 'Sem título';
        txt.appendChild(t);
        const v = document.createElement('span');
        v.className = 'mt-0.5 block text-[10px] text-slate-500';
        v.textContent = pauta.veiculo || 'Web';
        txt.appendChild(v);
        linha.appendChild(txt);
        linha.addEventListener('click', () => pedirReescrita(pauta));
        lista.appendChild(linha);
      });
      box.appendChild(lista);
    }

    const acoes = document.createElement('div');
    acoes.className = 'mt-2.5 flex flex-wrap items-center gap-2';

    const nova = criarBotao(
      'Nova pesquisa de pautas',
      'rounded-lg border border-emerald-500/50 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-200 transition hover:bg-emerald-500/20'
    );
    nova.addEventListener('click', () => {
      definirModo('pautas');
      el.input.value = '';
      el.input.focus();
      setStatus('Digite o novo tema e envie para ver as matérias.');
    });
    acoes.appendChild(nova);

    if (restantes.length) {
      const verLista = criarBotao(
        'Ver a lista completa',
        'rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 transition hover:border-emerald-500 hover:text-white'
      );
      verLista.addEventListener('click', () => {
        const blocos = el.mensagens.querySelectorAll('[data-pautas="1"]');
        const alvo = blocos[blocos.length - 1];
        if (!alvo) return;
        alvo.expandir?.();
        ancorarNoTopo(alvo);
      });
      acoes.appendChild(verLista);
    }

    box.appendChild(acoes);
    return box;
  }

  function blocoAssistente(mensagem, { ultima = true } = {}) {
    const wrap = document.createElement('div');
    wrap.className = 'mia-msg-ai';

    if (Array.isArray(mensagem.passos) && mensagem.passos.length) {
      const passos = criarPassos(mensagem.passos);
      passos.open = false;
      wrap.appendChild(passos);
      // Os avisos ficam dentro de "Pesquisa e apuração": o painel laranja
      // repetia a mesma lista e atrapalhava a leitura da matéria.
    }

    const variasMaterias = Array.isArray(mensagem.materias) && mensagem.materias.length >= 2;
    if (!variasMaterias) {
    const corpo = document.createElement('div');
      corpo.className = 'mia-msg-ai-body';
    renderTexto(corpo, mensagem.content);
    wrap.appendChild(corpo);
    }

    const pautas = blocoPautas(mensagem.pautas || []);
    if (pautas) wrap.appendChild(pautas);

    const fontes = blocoFontes(mensagem.fontes || []);
    if (fontes) wrap.appendChild(fontes);

    if (variasMaterias) {
      areaSalvarVarias(mensagem, wrap);
      if (ultima) {
        const continuar = blocoContinuar();
        if (continuar) wrap.appendChild(continuar);
      }
      return wrap;
    }

    // Segunda proteção no navegador: conversas antigas ou uma instância do
    // servidor ainda em recarga podem não trazer o sinal do backend.
    const inicioRespostaLivre = String(mensagem.content || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 900)
      .toLowerCase();
    const devolutivaDePesquisa =
      respostaLivreEhDePesquisaOuEscolha(mensagem.content) ||
      /^(?:i\s+)?n[ãa]o\s+(?:encontrei|localizei|achei|identifiquei|há|ha)\b/.test(
        inicioRespostaLivre
      ) ||
      /\b(?:posso seguir de duas formas|n[ãa]o encontrei(?:,| nas fontes| nenhum)|casos que já usei nesta conversa)\b/i.test(
        inicioRespostaLivre
      );
    if (state.tipoConversa === 'livre') {
      const escolha = blocoEscolhaNumerada(mensagem.content);
      if (escolha) wrap.appendChild(escolha);
    }
    const respostaLivreSalvavel =
      state.tipoConversa === 'livre' &&
      mensagem.podeSalvarRascunho !== false &&
      !devolutivaDePesquisa &&
      String(mensagem.content || '').trim().length >= 120;
    if ((mensagem.ehMateria && state.tipoConversa !== 'livre') || respostaLivreSalvavel) {
      areaSalvar(mensagem, wrap, { livre: state.tipoConversa === 'livre' });
      // Atalhos só na última matéria, para não repetir a cada mensagem antiga
      if (ultima) {
        const continuar = blocoContinuar();
        if (continuar) wrap.appendChild(continuar);
      }
    }

    return wrap;
  }

  function renderMensagens(mensagens) {
    limparMensagens();
    if (!mensagens.length) return;
    esconderVazio();
    // Marca de antemão as pautas que já viraram matéria nesta conversa
    for (const m of mensagens) {
      if (m.role === 'user') urlsDoPedido(m.content).forEach(marcarPautaEscrita);
    }
    mensagens.forEach((m, indice) => {
      const ultima = indice === mensagens.length - 1;
      el.mensagens.appendChild(
        m.role === 'user' ? blocoUsuario(m) : blocoAssistente(m, { ultima })
      );
    });
    scrollFim();
  }

  /* ------------------------------ conversas ------------------------------ */

  function novaConversa({ preservarTipo = false } = {}) {
    state.chatId = null;
    // Conversa nova abre direto no Claude; o modo Matéria continua
    // disponível quando o editor quiser aplicar o fluxo editorial completo.
    if (!preservarTipo) state.tipoConversa = 'materia';
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    el.titulo.textContent = state.tipoConversa === 'livre' ? 'Nova conversa com Claude' : 'Nova conversa';
    el.renomear?.classList.add('hidden');
    state.pesquisarWeb = false;
    // Cada conversa começa com uma escolha editorial limpa. O destaque na
    // tela inicial torna explícito que este tom será aplicado às manchetes.
    if (el.tom) el.tom.value = 'natural';
    aplicarTomDosTitulos('natural');
    aplicarTipoConversa();
    aplicarToggleWeb();
    limparMensagens();
    renderConversas();
    closeDrawer();
    el.input.focus();
  }

  async function abrirConversa(id) {
    try {
      setStatus('Abrindo conversa…');
      const data = await api(`${API}/conversas/${id}`);
      const chat = data?.chat;
      state.chatId = chat.id;
      try {
        sessionStorage.setItem(STORAGE_KEY, String(chat.id));
      } catch {
        /* ignore */
      }
      el.titulo.textContent = chat.titulo || 'Nova conversa';
      el.renomear?.classList.remove('hidden');
      state.tipoConversa = chat.modo === 'livre' ? 'livre' : 'materia';
      aplicarTipoConversa();
      state.pesquisarWeb = chat.pesquisarWeb === true;
      aplicarToggleWeb();
      if (el.tom) el.tom.value = chat.tom || 'natural';
      aplicarTomDosTitulos(chat.tom || 'natural');
      if (el.periodo) el.periodo.value = chat.periodo || '30d';
      renderMensagens(chat.mensagens || []);
      renderConversas();
      setStatus('');
      closeDrawer();
    } catch (err) {
      setStatus(err.message);
    }
  }

  /* ------------------------------ envio ------------------------------ */

  function aplicarToggleWeb() {
    if (!el.toggleWeb) return;
    const on = state.pesquisarWeb;
    el.toggleWeb.setAttribute('aria-pressed', on ? 'true' : 'false');
    el.toggleWeb.classList.toggle('is-on', on);
    const dot = el.toggleWeb.querySelector('.mia-chat-chip-dot') || el.toggleWeb.firstElementChild;
    if (dot) {
      dot.className = 'mia-chat-chip-dot';
    }
    // Período só faz sentido com a busca ligada
    el.periodo?.classList.toggle('hidden', !on);
    el.periodo?.closest('.mia-chat-tool-field')?.classList.toggle('hidden', !on);
  }

  function aplicarTipoConversa() {
    const livre = state.tipoConversa === 'livre';
    el.tipoBtns?.forEach((btn) => {
      const ativo = btn.dataset.chatTipo === state.tipoConversa;
      btn.setAttribute('aria-pressed', ativo ? 'true' : 'false');
      btn.className = ativo
        ? 'chat-tipo-btn mia-chat-seg-btn is-active'
        : 'chat-tipo-btn mia-chat-seg-btn';
    });
    el.modoSeg?.classList.toggle('hidden', livre);
    // O tom também vale para os títulos extraídos de respostas do Claude
    // Livre, portanto permanece disponível nos dois tipos de conversa.
    el.toggleTranscricao?.classList.toggle('hidden', livre);
    if (el.toggleWeb) {
      el.toggleWeb.disabled = livre;
      el.toggleWeb.title = livre
        ? 'A pesquisa nativa da sua conta Claude fica disponível automaticamente.'
        : 'Desligado: extrai o link e escreve sem verificar. Ligado: pesquisa outras fontes, verifica os fatos e revisa.';
    }
    if (el.toggleWebLabel) {
      el.toggleWebLabel.textContent = livre ? 'Pesquisa automática' : 'Pesquisar fontes';
    }
    if (livre) {
      el.toggleWeb?.setAttribute('aria-pressed', 'true');
      el.toggleWeb?.classList.add('is-on');
      el.periodo?.closest('.mia-chat-tool-field')?.classList.add('hidden');
    } else {
      aplicarToggleWeb();
    }
    if (el.input) {
      el.input.placeholder = livre
        ? 'Converse normalmente com o Claude…'
        : state.modo === 'pautas'
          ? 'Tema para pesquisar. Ex.: Polêmica Silas Malafaia'
          : 'Descreva o assunto, cole um link ou peça um ajuste…';
    }
    atualizarModeloIa();
  }

  function definirTipoConversa(novo) {
    const tipo = novo === 'livre' ? 'livre' : 'materia';
    if (tipo === state.tipoConversa) return;
    const tinhaConversa = Boolean(state.chatId);
    state.tipoConversa = tipo;
    if (tinhaConversa) novaConversa({ preservarTipo: true });
    aplicarTipoConversa();
    setStatus(
      tipo === 'livre'
        ? 'Claude ativo · conversa sem regras editoriais.'
        : 'Pronto para criar. Cole um link ou conte o que deseja escrever.'
    );
    el.input?.focus();
  }

  function aplicarTomDosTitulos(tom) {
    const valor = ['natural', 'polemico', 'direto', 'curiosidade', 'emocional', 'factual']
      .includes(String(tom || '').toLowerCase())
      ? String(tom).toLowerCase()
      : 'natural';
    if (el.tom && el.tom.value !== valor) el.tom.value = valor;
    el.titleToneBtns?.forEach((btn) => {
      const ativo = btn.dataset.titleTone === valor;
      btn.classList.toggle('is-active', ativo);
      btn.setAttribute('aria-pressed', ativo ? 'true' : 'false');
    });
  }

  function aplicarToggleTranscricao() {
    if (!el.toggleTranscricao) return;
    const on = state.transcreverVideo;
    el.toggleTranscricao.setAttribute('aria-pressed', on ? 'true' : 'false');
    el.toggleTranscricao.classList.toggle('is-on', on);
    el.toggleTranscricao.title = on
      ? 'Primeiro usa a transcrição disponibilizada pela plataforma. Se não houver, processa somente o áudio.'
      : 'Usa somente a transcrição disponibilizada pela plataforma; não baixa nem processa o áudio.';
  }

  /**
   * 'escrever' = já escreve a matéria.
   * 'pautas'  = pesquisa o tema e lista matérias para o usuário escolher.
   */
  function definirModo(novo) {
    state.modo = novo === 'pautas' ? 'pautas' : 'escrever';
    el.modoBtns?.forEach((btn) => {
      const ativo = btn.dataset.chatModo === state.modo;
      btn.setAttribute('aria-pressed', ativo ? 'true' : 'false');
      btn.className = ativo
        ? 'chat-modo-btn mia-chat-seg-btn is-active'
        : 'chat-modo-btn mia-chat-seg-btn';
    });
    // Pesquisar pautas depende da busca na web
    if (state.modo === 'pautas' && !state.pesquisarWeb) {
      state.pesquisarWeb = true;
      aplicarToggleWeb();
    }
    if (el.input && state.tipoConversa !== 'livre') {
      el.input.placeholder =
        state.modo === 'pautas'
          ? 'Digite o tema para pesquisar. Ex.: Polêmica Silas Malafaia'
          : 'Descreva o assunto, cole um link ou peça um ajuste…';
    }
  }

  function setEnviando(on) {
    state.enviando = on;
    el.enviar.disabled = on;
    el.enviar.classList.toggle('opacity-60', on);
    el.parar?.classList.toggle('hidden', !on);
    if (el.toggleTranscricao) el.toggleTranscricao.disabled = on;
    if (on && state.vozAtiva) pararVoz();
  }

  function juntarVoz(base, finalizado, parcial) {
    const partes = [base, finalizado, parcial]
      .map((p) => String(p || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    return partes.join('\n').trimStart();
  }

  function setVozAtiva(on) {
    state.vozAtiva = on;
    if (!el.voz) return;
    el.voz.classList.toggle('is-recording', on);
    el.voz.setAttribute('aria-pressed', on ? 'true' : 'false');
    el.voz.title = on ? 'Parar gravação de voz' : 'Gravar áudio para escrever';
    el.voz.setAttribute('aria-label', el.voz.title);
  }

  function pararVoz() {
    if (!state.recognition || !state.vozAtiva) return;
    try {
      state.recognition.stop();
    } catch {
      setVozAtiva(false);
    }
  }

  function iniciarVoz() {
    if (!el.voz || state.enviando) return;
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      el.voz.disabled = true;
      setStatus('Seu navegador não suporta ditado por voz aqui.');
      return;
    }

    if (state.vozAtiva) {
      pararVoz();
      return;
    }

    const recognition = new SpeechRecognition();
    state.recognition = recognition;
    state.vozBase = String(el.input.value || '').trim();
    state.vozFinal = '';

    recognition.lang = 'pt-BR';
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onstart = () => {
      setVozAtiva(true);
      setStatus('Ouvindo… fale sua matéria.');
    };

    recognition.onresult = (event) => {
      let parcial = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const trecho = String(event.results[i][0]?.transcript || '').trim();
        if (!trecho) continue;
        if (event.results[i].isFinal) state.vozFinal = `${state.vozFinal} ${trecho}`.trim();
        else parcial = `${parcial} ${trecho}`.trim();
      }
      el.input.value = juntarVoz(state.vozBase, state.vozFinal, parcial);
      el.input.dispatchEvent(new Event('input', { bubbles: true }));
    };

    recognition.onerror = (event) => {
      const erro = event.error || '';
      if (erro === 'not-allowed' || erro === 'service-not-allowed') {
        setStatus('Permita o microfone no navegador para gravar por voz.');
      } else if (erro === 'no-speech') {
        setStatus('Não ouvi nada. Clique no microfone e tente de novo.');
      } else {
        setStatus('Não consegui gravar por voz agora.');
      }
    };

    recognition.onend = () => {
      setVozAtiva(false);
      state.recognition = null;
      state.vozBase = '';
      state.vozFinal = '';
      if (!state.enviando) setStatus('');
      el.input.focus();
    };

    try {
      recognition.start();
    } catch {
      setStatus('Não consegui iniciar o microfone.');
      setVozAtiva(false);
    }
  }

  function prepararVoz() {
    if (!el.voz) return;
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      el.voz.disabled = true;
      el.voz.title = 'Ditado por voz indisponível neste navegador';
      el.voz.setAttribute('aria-label', el.voz.title);
    }
  }

  async function enviar() {
    if (state.enviando) return;
    let texto = String(el.input.value || '').trim();
    const quantidadeVideo = linksComOpcaoDeMaterias(texto)
      ? Number(document.getElementById('chat-video-count')?.value || 1) : 1;
    if ([2, 3, 4, 5].includes(quantidadeVideo)) {
      texto += `\n\nCrie até ${quantidadeVideo} matérias independentes a partir dos assuntos distintos presentes no conteúdo dos links acima. Analise a transcrição completa disponível e a legenda. Cada matéria deve ter um foco diferente, título próprio, corpo e crédito da fonte. Não repita o mesmo fato com títulos diferentes e não invente assuntos para completar a quantidade. Se houver apenas um assunto aproveitável, entregue somente uma matéria. Separe cada matéria com o cabeçalho "### MATÉRIA 1", "### MATÉRIA 2" e assim por diante. A quantidade é o total para este pedido, não por link.`;
    }
    const escolhaNumerada = entradaEhEscolhaNumerada(texto);
    const pedePesquisaLivre =
      state.tipoConversa === 'livre' &&
      /\b(pesquis\w*|busc\w*|procur\w*|recent\w*|hoje|agora|atual(?:mente)?|últim\w*)\b/i.test(texto);
    const linksPedido = urlsDoTexto(texto);
    if (texto.length < 3 && !escolhaNumerada) {
      setStatus('Escreva o que você quer que a IA faça');
      return;
    }

    esconderVazio();
    el.input.value = '';
    autoGrowInput();
    atualizarLinksDetectados();
    setEnviando(true);
    const janela = el.periodo?.selectedOptions?.[0]?.textContent?.trim() || '';
    setStatus(
      state.tipoConversa === 'livre'
        ? pedePesquisaLivre
          ? 'Claude está pesquisando na web…'
          : state.pesquisarWeb
          ? `Pesquisando na internet${janela ? ` — ${janela.toLowerCase()}` : ''} para o Claude…`
          : 'Claude está respondendo…'
        : state.modo === 'pautas'
        ? `Procurando matérias sobre o tema${janela ? ` — ${janela.toLowerCase()}` : ''}…`
        : state.pesquisarWeb
        ? `Pesquisando na internet${janela ? ` — ${janela.toLowerCase()}` : ''}…`
          : linksPedido.length > 1
            ? 'Lendo ' + Math.min(linksPedido.length, MAX_LINKS_LOTE) + ' links e criando uma matéria para cada…'
        : 'Escrevendo…'
    );

    const bolhaUsuario = blocoUsuario({ content: texto });
    el.mensagens.appendChild(bolhaUsuario);
    scrollFim();

    const wrap = document.createElement('div');
    wrap.className = 'mia-msg-ai';
    const passos = criarPassos([], { ativo: true });
    wrap.appendChild(passos);
    const corpo = document.createElement('div');
    corpo.className = 'mia-msg-ai-body';
    corpo.hidden = true;
    wrap.appendChild(corpo);
    el.mensagens.appendChild(wrap);

    // Reescrita de pauta: fixa o começo da resposta na tela em vez de
    // empurrar a rolagem para o fim a cada pedaço de texto.
    const ancorado = state.ancorarTopo === true;
    state.ancorarTopo = false;
    state.ancoradoAtivo = ancorado;
    if (ancorado) ancorarNoTopo(wrap);
    else scrollFim();

    let parcial = '';
    state.controller = new AbortController();

    try {
      const res = await fetch(`${API}/conversas/${state.chatId || 'nova'}/mensagens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: state.controller.signal,
        body: JSON.stringify({
          texto,
          pesquisarWeb: state.pesquisarWeb,
          transcreverVideo: state.transcreverVideo,
          tom: el.tom?.value || 'natural',
          periodo: el.periodo?.value || '30d',
          modo: state.modo,
          tipoConversa: state.tipoConversa,
          modelo: state.modeloEscolhido,
        }),
      });

      if (!res.ok || !res.body) {
        let msg = `Falha ao gerar a resposta (${res.status})`;
        try {
          const data = await res.json();
          if (data?.error) msg = data.error;
        } catch {
          /* ignore */
        }
        throw new Error(msg);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const tratarEvento = (evento) => {
        if (evento.tipo === 'conversa') {
          state.chatId = evento.chat.id;
          el.titulo.textContent = evento.chat.titulo || 'Nova conversa';
          el.renomear?.classList.remove('hidden');
          try {
            sessionStorage.setItem(STORAGE_KEY, String(evento.chat.id));
          } catch {
            /* ignore */
          }
          carregarConversas();
        } else if (evento.tipo === 'mensagem-usuario') {
          if (evento.mensagem?.id) bolhaUsuario.dataset.msgId = String(evento.mensagem.id);
        } else if (evento.tipo === 'passo') {
          passos.addPasso(evento.passo);
          if (evento.passo?.texto) setStatus(evento.passo.texto);
        } else if (evento.tipo === 'delta') {
          parcial += evento.texto || '';
          if (parcial.trim()) corpo.hidden = false;
          renderTexto(corpo, parcial);
          if (!ancorado) scrollFim();
        } else if (evento.tipo === 'pautas') {
          const cartoes = blocoPautas(evento.pautas || []);
          if (cartoes) {
            wrap.appendChild(cartoes);
            if (!ancorado) scrollFim();
          }
        } else if (evento.tipo === 'fim') {
          state.chatId = evento.chatId;
          const pronto = blocoAssistente(evento.mensagem);
          wrap.replaceWith(pronto);
          setStatus('');
          // Matéria reescrita começa visível no topo; as pautas restantes
          // ficam logo abaixo dela, no bloco "Continuar desta pesquisa".
          if (ancorado) ancorarNoTopo(pronto);
          else scrollFim();
          carregarConversas();
        } else if (evento.tipo === 'erro') {
          throw new Error(evento.erro || 'Falha ao gerar a resposta');
        }
      };

      /* eslint-disable no-await-in-loop */
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const linhas = buffer.split('\n');
        buffer = linhas.pop() || '';
        for (const linha of linhas) {
          const l = linha.trim();
          if (!l) continue;
          try {
            tratarEvento(JSON.parse(l));
          } catch (err) {
            if (err instanceof SyntaxError) continue;
            throw err;
          }
        }
      }
      /* eslint-enable no-await-in-loop */

      if (!passos.temPassos()) passos.remove();
      if (!parcial.trim() && !corpo.childElementCount) {
        setStatus('A IA não retornou texto. Tente novamente.');
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        setStatus('Geração interrompida');
      } else {
        // Mensagem longa (ex.: erro técnico) não pode estourar o layout do chat.
        const curta = String(err.message || 'Falha ao gerar a resposta')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 300);
        setStatus(curta.slice(0, 120));
        const p = document.createElement('p');
        p.className = 'mia-msg-panel';
        p.style.borderColor = 'rgba(244, 63, 94, 0.35)';
        p.style.color = '#fecdd3';
        p.textContent = curta;
        corpo.hidden = false;
        corpo.appendChild(p);
      }
    } finally {
      state.controller = null;
      state.ancoradoAtivo = false;
      setEnviando(false);
    }
  }

  /* ------------------------------ eventos ------------------------------ */

  el.enviar.addEventListener('click', enviar);
  el.voz?.addEventListener('click', iniciarVoz);
  el.parar?.addEventListener('click', () => state.controller?.abort());
  el.nova?.addEventListener('click', novaConversa);
  el.novaTop?.addEventListener('click', novaConversa);
  el.drawerOpen?.addEventListener('click', openDrawer);
  el.drawerClose?.addEventListener('click', closeDrawer);
  el.drawerBackdrop?.addEventListener('click', closeDrawer);
  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') closeDrawer();
  });
  window.addEventListener('resize', () => {
    if (!isMobileDrawer()) closeDrawer();
  });
  el.busca?.addEventListener('input', renderConversas);
  el.toggleWeb?.addEventListener('click', () => {
    if (state.tipoConversa === 'livre') return;
    state.pesquisarWeb = !state.pesquisarWeb;
    aplicarToggleWeb();
    // Sem busca não há como listar pautas
    if (!state.pesquisarWeb && state.modo === 'pautas') definirModo('escrever');
  });
  el.toggleTranscricao?.addEventListener('click', () => {
    state.transcreverVideo = !state.transcreverVideo;
    aplicarToggleTranscricao();
  });

  el.modoBtns?.forEach((btn) => {
    btn.addEventListener('click', () => definirModo(btn.dataset.chatModo));
  });
  el.tipoBtns?.forEach((btn) => {
    btn.addEventListener('click', () => definirTipoConversa(btn.dataset.chatTipo));
  });
  el.titleToneBtns?.forEach((btn) => {
    btn.addEventListener('click', () => {
      aplicarTomDosTitulos(btn.dataset.titleTone);
      setStatus(`Tom dos títulos: ${btn.textContent.trim()}.`);
      el.input?.focus();
    });
  });
  el.tom?.addEventListener('change', () => aplicarTomDosTitulos(el.tom.value));

  el.input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      enviar();
    }
  });

  function autoGrowInput() {
    if (!el.input) return;
    el.input.style.height = 'auto';
    el.input.style.height = `${Math.min(el.input.scrollHeight, 144)}px`;
  }
  el.input.addEventListener('input', () => {
    autoGrowInput();
    atualizarLinksDetectados();
  });
  autoGrowInput();
  atualizarLinksDetectados();

  el.renomear?.addEventListener('click', async () => {
    if (!state.chatId) return;
    const conversa = state.conversas.find((c) => Number(c.id) === Number(state.chatId)) || {
      id: state.chatId,
      titulo: el.titulo.textContent || 'Nova conversa',
    };
    await renomearConversaNaLista(conversa);
  });

  function fecharMenuMais() {
    document.querySelectorAll('.mia-chat-more').forEach((menu) => {
      menu.open = false;
    });
  }

  el.variosLinks?.forEach((botao) => {
    botao.addEventListener('click', () => {
      definirModo('escrever');
      fecharMenuMais();
      if (!String(el.input.value || '').trim()) {
        el.input.value = 'Crie uma matéria separada para cada link:\n';
      }
      autoGrowInput();
      atualizarLinksDetectados();
      setStatus('Cole até 12 links, um por linha, e clique em enviar.');
      el.input.focus();
      el.input.setSelectionRange(el.input.value.length, el.input.value.length);
    });
  });

  document.querySelectorAll('[data-start-matter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const escolha = btn.dataset.startMatter;
      const radar = document.getElementById('chat-radar-options');
      if (escolha === 'pautas') {
        if (radar) {
          radar.hidden = !radar.hidden;
          btn.setAttribute('aria-expanded', String(!radar.hidden));
          if (!radar.hidden) radar.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
        return;
      }
      definirTipoConversa('materia');
      definirModo('escrever');
      const dicas = {
        link: 'Cole o link da notícia abaixo. Você pode acrescentar o enfoque desejado.',
        tema: 'Conte o tema e os fatos que você já conhece. Ative “Pesquisar fontes” para ampliar a apuração.',
        video: 'Cole o link do vídeo abaixo. A IA usará a transcrição disponível ou processará o áudio.',
      };
      setStatus(dicas[escolha] || 'Descreva sua matéria abaixo.');
      el.input.placeholder = escolha === 'video' ? 'Cole o link do vídeo…'
        : escolha === 'link' ? 'Cole o link da notícia…' : 'Sobre o que você quer escrever?';
      el.input.focus();
    });
  });

  document.querySelectorAll('.chat-exemplo').forEach((btn) => {
    btn.addEventListener('click', () => {
      const textoEl = btn.querySelector('.mia-chat-prompt-text');
      const texto = (textoEl?.textContent || btn.textContent || '').trim();
      if (btn.dataset.modoExemplo === 'pautas') definirModo('pautas');
      else definirModo('escrever');
      fecharMenuMais();
      el.input.value = texto;
      autoGrowInput();
      el.input.focus();
    });
  });

  async function iniciar() {
    if (state.iniciado) return;
    state.iniciado = true;
    // Um único menu mantém anexos, criação manual e ajustes encontráveis.
    const ferramentas = document.querySelector('#chat-ferramentas .mia-chat-more-menu');
    const criar = document.getElementById('chat-criar');
    const secaoCriar = criar?.querySelector('.mia-chat-menu-sec');
    if (ferramentas && secaoCriar) {
      ferramentas.prepend(secaoCriar);
      criar.hidden = true;
    }
    const ajustes = ferramentas?.querySelector('.mia-chat-tools');
    if (ajustes && el.modoSeg) ajustes.appendChild(el.modoSeg);
    prepararVoz();
    carregarModeloIa();
    aplicarToggleWeb();
    aplicarToggleTranscricao();
    definirModo(state.modo);
    aplicarTipoConversa();
    await carregarConversas();
    let salvo = null;
    try {
      salvo = sessionStorage.getItem(STORAGE_KEY);
    } catch {
      salvo = null;
    }
    if (salvo && state.conversas.some((c) => Number(c.id) === Number(salvo))) {
      await abrirConversa(Number(salvo));
    }
  }

  const painel = document.getElementById('mia-manual');
  document.querySelector('[data-mia-modo="manual"]')?.addEventListener('click', iniciar);
  if (painel && !painel.classList.contains('hidden')) iniciar();
})();
