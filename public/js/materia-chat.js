/* Chat de matérias (/conteudo → Matéria manual): conversas salvas, passos da
   pesquisa em tempo real e refino por prompt antes de virar rascunho. */
(() => {
  const API = '/api/materias-ia/chat';
  const STORAGE_KEY = 'mia_chat_atual';

  const el = {
    lista: document.getElementById('chat-lista'),
    busca: document.getElementById('chat-busca'),
    nova: document.getElementById('chat-nova'),
    titulo: document.getElementById('chat-titulo'),
    renomear: document.getElementById('chat-renomear'),
    mensagens: document.getElementById('chat-mensagens'),
    vazio: document.getElementById('chat-vazio'),
    input: document.getElementById('chat-input'),
    enviar: document.getElementById('chat-enviar'),
    parar: document.getElementById('chat-parar'),
    status: document.getElementById('chat-status'),
    toggleWeb: document.getElementById('chat-toggle-web'),
    tom: document.getElementById('chat-tom'),
    periodo: document.getElementById('chat-periodo'),
    modoBtns: document.querySelectorAll('.chat-modo-btn'),
  };

  if (!el.mensagens || !el.input) return;

  const state = {
    iniciado: false,
    chatId: null,
    conversas: [],
    pesquisarWeb: true,
    enviando: false,
    controller: null,
    modo: 'escrever',
  };

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

  function scrollFim() {
    el.mensagens.scrollTop = el.mensagens.scrollHeight;
  }

  /* ------------------------------ sidebar ------------------------------ */

  function renderConversas() {
    const filtro = String(el.busca?.value || '').trim().toLowerCase();
    el.lista.replaceChildren();

    const itens = state.conversas.filter(
      (c) => !filtro || String(c.titulo || '').toLowerCase().includes(filtro)
    );

    if (!itens.length) {
      const p = document.createElement('p');
      p.className = 'px-1 py-2 text-xs text-slate-500';
      p.textContent = filtro ? 'Nenhuma conversa encontrada' : 'Nenhuma conversa ainda';
      el.lista.appendChild(p);
      return;
    }

    for (const c of itens) {
      const linha = document.createElement('div');
      const ativo = Number(c.id) === Number(state.chatId);
      linha.className = `group flex items-center gap-1 rounded-lg px-2 py-1.5 ${
        ativo ? 'bg-emerald-500/15 text-emerald-100' : 'text-slate-300 hover:bg-slate-800/70'
      }`;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'min-w-0 flex-1 truncate text-left text-xs sm:text-sm';
      btn.textContent = c.titulo || 'Nova conversa';
      btn.title = c.titulo || 'Nova conversa';
      btn.addEventListener('click', () => abrirConversa(c.id));

      const excluir = document.createElement('button');
      excluir.type = 'button';
      excluir.className =
        'shrink-0 rounded px-1 text-xs text-slate-500 opacity-0 transition group-hover:opacity-100 hover:text-rose-300';
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
      linha.appendChild(excluir);
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
      p.className = 'px-1 py-2 text-xs text-rose-300';
      p.textContent = err.message;
      el.lista.appendChild(p);
    }
  }

  /* ------------------------------ mensagens ------------------------------ */

  function limparMensagens() {
    el.mensagens.replaceChildren();
    if (el.vazio) {
      el.mensagens.appendChild(el.vazio);
      el.vazio.classList.remove('hidden');
    }
  }

  function esconderVazio() {
    el.vazio?.classList.add('hidden');
  }

  function blocoUsuario(mensagem) {
    const wrap = document.createElement('div');
    wrap.className = 'flex justify-end';
    const bolha = document.createElement('div');
    bolha.className =
      'max-w-[92%] whitespace-pre-wrap rounded-2xl bg-emerald-500/15 px-3 py-2 text-sm text-emerald-50 sm:max-w-[85%] sm:px-4 sm:py-2.5';
    bolha.textContent = mensagem.content || '';
    wrap.appendChild(bolha);
    return wrap;
  }

  /** Bloco "raciocínio" recolhível, como o do DeepSeek. */
  function criarPassos(passos = []) {
    const box = document.createElement('details');
    box.className = 'rounded-xl border border-slate-800 bg-slate-950/60 px-2.5 py-2 text-[11px] sm:px-3 sm:text-xs';
    box.open = true;

    const resumo = document.createElement('summary');
    resumo.className = 'cursor-pointer list-none text-slate-400 hover:text-slate-200';
    box.appendChild(resumo);

    const lista = document.createElement('div');
    lista.className = 'mt-2 space-y-1';
    box.appendChild(lista);

    function atualizarResumo() {
      const total = lista.childElementCount;
      resumo.textContent = total ? `Pesquisa e apuração (${total} etapas)` : 'Pesquisa e apuração';
    }

    function addPasso(passo) {
      const linha = document.createElement('div');
      linha.className = 'flex items-start gap-2 text-slate-400';

      const ponto = document.createElement('span');
      const cor =
        passo.kind === 'aviso'
          ? 'bg-amber-400'
          : passo.kind === 'escrevendo'
            ? 'bg-violet-400'
            : passo.kind === 'fontes' || passo.kind === 'encontrados'
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
      scrollFim();
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

    const fecharParagrafo = () => {
      if (!paragrafo.length) return;
      const texto = paragrafo.join('\n');
      paragrafo = [];
      const p = document.createElement('p');
      const ehHashtags = /^#[^\s#]+(\s+#[^\s#]+)*$/.test(texto.trim());
      const ehTitulo =
        podeTerTitulo && container.childElementCount === 0 && texto.length <= 200 && !texto.includes('\n');
      p.className = ehHashtags
        ? 'text-xs font-medium text-emerald-300 sm:text-sm'
        : ehTitulo
          ? 'text-sm font-semibold leading-snug text-white sm:text-base'
          : 'whitespace-pre-wrap text-sm leading-relaxed text-slate-200';
      p.textContent = texto.replace(/\*\*(.+?)\*\*/g, '$1');
      container.appendChild(p);
    };

    for (const linha of linhas) {
      if (!linha.trim()) {
        fecharParagrafo();
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

  function blocoFontes(fontes = []) {
    if (!fontes.length) return null;
    const box = document.createElement('details');
    box.className = 'rounded-xl border border-slate-800 bg-slate-950/60 px-2.5 py-2 text-[11px] sm:px-3 sm:text-xs';
    const resumo = document.createElement('summary');
    resumo.className = 'cursor-pointer list-none text-slate-400 hover:text-slate-200';
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

  function areaSalvar(mensagem, container) {
    const box = document.createElement('div');
    box.className = 'mt-3 rounded-xl border border-slate-800 bg-slate-950/60 p-2.5 sm:p-3';

    const info = document.createElement('p');
    info.className = 'text-xs text-slate-400';
    info.textContent = 'Gostou? Salve como rascunho — ou peça um ajuste no campo abaixo do chat.';
    box.appendChild(info);

    const grid = document.createElement('div');
    grid.className = 'mt-2 grid gap-2 md:grid-cols-2';
    const imagem = document.createElement('input');
    imagem.type = 'url';
    imagem.placeholder = 'URL da imagem da capa (opcional)';
    imagem.className =
      'w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100 placeholder:text-slate-600 focus:border-emerald-500 focus:outline-none';
    const credito = document.createElement('input');
    credito.type = 'text';
    credito.placeholder = 'Crédito da foto (ex.: Reprodução/Instagram)';
    credito.className = imagem.className;
    grid.appendChild(imagem);
    grid.appendChild(credito);
    box.appendChild(grid);

    const acoes = document.createElement('div');
    acoes.className = 'mt-2 grid gap-2 sm:flex sm:flex-wrap sm:items-center';

    const salvar = criarBotao(
      'Salvar como rascunho',
      'rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-emerald-400'
    );
    const copiar = criarBotao(
      'Copiar texto',
      'rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:border-emerald-500 hover:text-white'
    );
    const ajustar = criarBotao(
      'Pedir ajuste',
      'rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:border-emerald-500 hover:text-white'
    );
    const aviso = document.createElement('span');
    aviso.className = 'text-xs text-slate-400';

    salvar.addEventListener('click', async () => {
      salvar.disabled = true;
      salvar.classList.add('opacity-60');
      aviso.textContent = 'Salvando rascunho…';
      try {
        const data = await api(`${API}/mensagens/${mensagem.id}/materia`, {
          method: 'POST',
          body: JSON.stringify({
            imagemUrl: imagem.value.trim() || null,
            creditoImagem: credito.value.trim() || null,
          }),
        });
        aviso.replaceChildren();
        const link = document.createElement('a');
        link.href = data.redirect;
        link.target = '_blank';
        link.rel = 'noopener';
        link.className = 'text-emerald-300 underline hover:text-emerald-200';
        link.textContent = `Rascunho #${data.matterId} — abrir para revisar e publicar`;
        aviso.appendChild(link);
        salvar.textContent = 'Rascunho salvo';
      } catch (err) {
        aviso.textContent = err.message;
        salvar.disabled = false;
        salvar.classList.remove('opacity-60');
      }
    });

    copiar.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(mensagem.content || '');
        copiar.textContent = 'Copiado';
        setTimeout(() => {
          copiar.textContent = 'Copiar texto';
        }, 1500);
      } catch {
        aviso.textContent = 'Não foi possível copiar neste navegador';
      }
    });

    ajustar.addEventListener('click', () => {
      el.input.focus();
      el.input.placeholder = 'Ex.: deixe mais curto, acrescente a reação do governo, troque o título…';
    });

    acoes.appendChild(salvar);
    acoes.appendChild(copiar);
    acoes.appendChild(ajustar);
    acoes.appendChild(aviso);
    box.appendChild(acoes);

    if (mensagem.matterId) {
      salvar.disabled = true;
      salvar.textContent = 'Rascunho salvo';
      salvar.classList.add('opacity-60');
      const link = document.createElement('a');
      link.href = `/materias-ia/${mensagem.matterId}`;
      link.target = '_blank';
      link.rel = 'noopener';
      link.className = 'text-emerald-300 underline hover:text-emerald-200';
      link.textContent = `Rascunho #${mensagem.matterId} — abrir`;
      aviso.appendChild(link);
    }

    container.appendChild(box);
  }

  /** Avisos de checagem ficam visíveis, fora do bloco recolhido. */
  function blocoAvisos(passos = []) {
    const avisos = passos.filter((p) => p?.kind === 'aviso');
    if (!avisos.length) return null;
    const box = document.createElement('div');
    box.className = 'rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200';
    for (const a of avisos) {
      const p = document.createElement('p');
      p.textContent = a.texto || '';
      box.appendChild(p);
    }
    return box;
  }

  /**
   * Cartões das matérias encontradas no modo "Pesquisar pautas".
   * Escolher uma monta o pedido de reescrita com furo e já envia.
   */
  function blocoPautas(pautas = []) {
    if (!Array.isArray(pautas) || !pautas.length) return null;

    const box = document.createElement('div');
    box.className = 'space-y-2';

    const titulo = document.createElement('p');
    titulo.className = 'text-[11px] font-semibold uppercase tracking-wider text-emerald-400/80';
    titulo.textContent = `Escolha a matéria para reescrever (${pautas.length})`;
    box.appendChild(titulo);

    pautas.forEach((pauta, indice) => {
      const card = document.createElement('article');
      card.className =
        'rounded-xl border border-slate-800 bg-slate-950/60 p-3 transition hover:border-emerald-500/40';

      const meta = document.createElement('div');
      meta.className = 'flex items-center gap-2';
      const num = document.createElement('span');
      num.className =
        'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-800 text-[10px] font-bold text-slate-300';
      num.textContent = String(indice + 1);
      meta.appendChild(num);
      const veiculo = document.createElement('span');
      veiculo.className = 'truncate text-[11px] font-medium text-slate-400';
      veiculo.textContent = pauta.veiculo || 'Web';
      meta.appendChild(veiculo);
      card.appendChild(meta);

      const h = document.createElement('p');
      h.className = 'mt-1.5 text-sm font-semibold leading-snug text-white';
      h.textContent = pauta.titulo || 'Sem título';
      card.appendChild(h);

      if (pauta.resumo) {
        const r = document.createElement('p');
        r.className = 'mt-1 text-xs leading-relaxed text-slate-400';
        r.textContent = pauta.resumo;
        card.appendChild(r);
      }

      const acoes = document.createElement('div');
      acoes.className = 'mt-2.5 flex flex-wrap items-center gap-2';

      const escrever = criarBotao(
        'Reescrever com furo',
        'rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-slate-950 transition hover:bg-emerald-400'
      );
      escrever.addEventListener('click', () => {
        if (state.enviando) return;
        definirModo('escrever');
        el.input.value = [
          'Reescreva esta matéria com furo de reportagem, texto totalmente original e sem plagiar:',
          `Título: ${pauta.titulo || ''}`,
          `Veículo: ${pauta.veiculo || ''}`,
          `Link: ${pauta.url || ''}`,
          'Pesquise também mais informações recentes sobre esse assunto para acrescentar contexto e dados novos.',
        ].join('\n');
        enviar();
      });
      acoes.appendChild(escrever);

      if (pauta.url) {
        const abrir = document.createElement('a');
        abrir.href = pauta.url;
        abrir.target = '_blank';
        abrir.rel = 'noopener';
        abrir.className =
          'rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 transition hover:border-emerald-500 hover:text-white';
        abrir.textContent = 'Ler original ↗';
        acoes.appendChild(abrir);
      }

      card.appendChild(acoes);
      box.appendChild(card);
    });

    return box;
  }

  function blocoAssistente(mensagem) {
    const wrap = document.createElement('div');
    wrap.className = 'space-y-2';

    if (Array.isArray(mensagem.passos) && mensagem.passos.length) {
      const passos = criarPassos(mensagem.passos);
      passos.open = false;
      wrap.appendChild(passos);
      const avisos = blocoAvisos(mensagem.passos);
      if (avisos) wrap.appendChild(avisos);
    }

    const corpo = document.createElement('div');
    corpo.className = 'space-y-3';
    renderTexto(corpo, mensagem.content);
    wrap.appendChild(corpo);

    const pautas = blocoPautas(mensagem.pautas || []);
    if (pautas) wrap.appendChild(pautas);

    const fontes = blocoFontes(mensagem.fontes || []);
    if (fontes) wrap.appendChild(fontes);

    if (mensagem.ehMateria) areaSalvar(mensagem, wrap);

    return wrap;
  }

  function renderMensagens(mensagens) {
    limparMensagens();
    if (!mensagens.length) return;
    esconderVazio();
    for (const m of mensagens) {
      el.mensagens.appendChild(m.role === 'user' ? blocoUsuario(m) : blocoAssistente(m));
    }
    scrollFim();
  }

  /* ------------------------------ conversas ------------------------------ */

  function novaConversa() {
    state.chatId = null;
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    el.titulo.textContent = 'Nova conversa';
    el.renomear?.classList.add('hidden');
    limparMensagens();
    renderConversas();
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
      state.pesquisarWeb = chat.pesquisarWeb !== false;
      aplicarToggleWeb();
      if (el.tom) el.tom.value = chat.tom || 'natural';
      if (el.periodo) el.periodo.value = chat.periodo || '7d';
      renderMensagens(chat.mensagens || []);
      renderConversas();
      setStatus('');
    } catch (err) {
      setStatus(err.message);
    }
  }

  /* ------------------------------ envio ------------------------------ */

  function aplicarToggleWeb() {
    if (!el.toggleWeb) return;
    const on = state.pesquisarWeb;
    el.toggleWeb.setAttribute('aria-pressed', on ? 'true' : 'false');
    el.toggleWeb.className = on
      ? 'flex items-center gap-1.5 rounded-full border border-emerald-500/60 bg-emerald-500/15 px-3 py-1 text-xs font-medium text-emerald-200'
      : 'flex items-center gap-1.5 rounded-full border border-slate-700 px-3 py-1 text-xs font-medium text-slate-400';
    el.toggleWeb.firstElementChild.className = on
      ? 'h-1.5 w-1.5 rounded-full bg-emerald-400'
      : 'h-1.5 w-1.5 rounded-full bg-slate-600';
    // Período só faz sentido com a busca ligada
    el.periodo?.classList.toggle('hidden', !on);
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
        ? 'chat-modo-btn rounded-lg bg-emerald-500 px-3 py-1 text-xs font-semibold text-slate-950'
        : 'chat-modo-btn rounded-lg px-3 py-1 text-xs font-medium text-slate-400 hover:text-white';
    });
    // Pesquisar pautas depende da busca na web
    if (state.modo === 'pautas' && !state.pesquisarWeb) {
      state.pesquisarWeb = true;
      aplicarToggleWeb();
    }
    if (el.input) {
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
  }

  async function enviar() {
    if (state.enviando) return;
    const texto = String(el.input.value || '').trim();
    if (texto.length < 3) {
      setStatus('Escreva o que você quer que a IA faça');
      return;
    }

    esconderVazio();
    el.input.value = '';
    setEnviando(true);
    const janela = el.periodo?.selectedOptions?.[0]?.textContent?.trim() || '';
    setStatus(
      state.modo === 'pautas'
        ? `Procurando matérias sobre o tema${janela ? ` — ${janela.toLowerCase()}` : ''}…`
        : state.pesquisarWeb
          ? `Pesquisando na internet${janela ? ` — ${janela.toLowerCase()}` : ''}…`
          : 'Escrevendo…'
    );

    el.mensagens.appendChild(blocoUsuario({ content: texto }));
    scrollFim();

    const wrap = document.createElement('div');
    wrap.className = 'space-y-2';
    const passos = criarPassos([]);
    wrap.appendChild(passos);
    const corpo = document.createElement('div');
    corpo.className = 'space-y-3';
    wrap.appendChild(corpo);
    el.mensagens.appendChild(wrap);
    scrollFim();

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
          tom: el.tom?.value || 'natural',
          periodo: el.periodo?.value || '7d',
          modo: state.modo,
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
        } else if (evento.tipo === 'passo') {
          passos.addPasso(evento.passo);
          if (evento.passo?.texto) setStatus(evento.passo.texto);
        } else if (evento.tipo === 'delta') {
          parcial += evento.texto || '';
          renderTexto(corpo, parcial);
          scrollFim();
        } else if (evento.tipo === 'pautas') {
          const cartoes = blocoPautas(evento.pautas || []);
          if (cartoes) {
            wrap.appendChild(cartoes);
            scrollFim();
          }
        } else if (evento.tipo === 'fim') {
          state.chatId = evento.chatId;
          const pronto = blocoAssistente(evento.mensagem);
          wrap.replaceWith(pronto);
          setStatus('');
          scrollFim();
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
        setStatus(err.message);
        const p = document.createElement('p');
        p.className = 'text-sm text-rose-300';
        p.textContent = err.message;
        corpo.appendChild(p);
      }
    } finally {
      state.controller = null;
      setEnviando(false);
    }
  }

  /* ------------------------------ eventos ------------------------------ */

  el.enviar.addEventListener('click', enviar);
  el.parar?.addEventListener('click', () => state.controller?.abort());
  el.nova?.addEventListener('click', novaConversa);
  el.busca?.addEventListener('input', renderConversas);
  el.toggleWeb?.addEventListener('click', () => {
    state.pesquisarWeb = !state.pesquisarWeb;
    aplicarToggleWeb();
    // Sem busca não há como listar pautas
    if (!state.pesquisarWeb && state.modo === 'pautas') definirModo('escrever');
  });

  el.modoBtns?.forEach((btn) => {
    btn.addEventListener('click', () => definirModo(btn.dataset.chatModo));
  });

  el.input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      enviar();
    }
  });

  el.renomear?.addEventListener('click', async () => {
    if (!state.chatId) return;
    const atual = el.titulo.textContent || '';
    const novo = prompt('Novo nome da conversa:', atual);
    if (!novo || !novo.trim()) return;
    try {
      const data = await api(`${API}/conversas/${state.chatId}`, {
        method: 'PATCH',
        body: JSON.stringify({ titulo: novo.trim() }),
      });
      el.titulo.textContent = data.chat.titulo;
      await carregarConversas();
    } catch (err) {
      alert(err.message);
    }
  });

  document.querySelectorAll('.chat-exemplo').forEach((btn) => {
    btn.addEventListener('click', () => {
      el.input.value = btn.textContent.trim();
      el.input.focus();
    });
  });

  async function iniciar() {
    if (state.iniciado) return;
    state.iniciado = true;
    aplicarToggleWeb();
    definirModo(state.modo);
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
