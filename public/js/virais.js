(() => {
  const page = document.getElementById('virais-page');
  if (!page) return;

  const el = {
    form: document.getElementById('virais-search-form'),
    eixo: document.getElementById('virais-eixo'),
    periodo: document.getElementById('virais-periodo'),
    tom: document.getElementById('virais-tom'),
    termo: document.getElementById('virais-termo'),
    status: document.getElementById('virais-status'),
    results: document.getElementById('virais-results'),
    resumo: document.getElementById('virais-resumo'),
    list: document.getElementById('virais-list'),
    selecionar: document.getElementById('virais-selecionar'),
    gerar: document.getElementById('virais-gerar'),
    created: document.getElementById('virais-created'),
    createdMessage: document.getElementById('virais-created-message'),
    createdList: document.getElementById('virais-created-list'),
  };

  const state = { topicos: [], selecionados: new Set(), pesquisando: false, gerando: false };

  function setStatus(texto, erro = false) {
    el.status.textContent = texto || '';
    el.status.className = `mt-3 min-h-5 text-xs ${erro ? 'text-rose-300' : 'text-slate-500'}`;
  }

  async function api(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Falha na requisição (${res.status})`);
    return data;
  }

  async function consultarPesquisa(jobId) {
    const inicio = Date.now();
    while (Date.now() - inicio < 90 * 1000) {
      await new Promise((resolve) => window.setTimeout(resolve, 2500));
      const res = await fetch(`/api/virais/pesquisar/${encodeURIComponent(jobId)}`, {
        headers: { Accept: 'application/json' },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok && res.status !== 202) {
        throw new Error(data.error || `Falha ao acompanhar a pesquisa (${res.status})`);
      }
      if (res.status === 200 && data.status === 'concluido') return data;
      const segundos = Math.max(1, Math.round((Number(data.decorridoMs) || Date.now() - inicio) / 1000));
      setStatus(`Pesquisando fontes recentes e avaliando as pautas… ${segundos}s`);
    }
    throw new Error('A pesquisa não concluiu em 90 segundos. Tente novamente.');
  }

  function formatarData(topico) {
    const ts = Number(topico?.dataTimestamp) || Date.parse(String(topico?.data || ''));
    if (!Number.isFinite(ts) || ts <= 0) return '';
    return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(ts));
  }

  function atualizarAcoes() {
    const total = state.selecionados.size;
    el.gerar.disabled = total === 0 || state.gerando;
    el.gerar.textContent = state.gerando
      ? 'Claude está escrevendo…'
      : total
        ? `Criar ${total} com Claude`
        : 'Criar com Claude';
    el.selecionar.textContent = total ? 'Limpar seleção' : 'Selecionar 3 melhores';
  }

  function criarElemento(tag, classe, texto) {
    const node = document.createElement(tag);
    if (classe) node.className = classe;
    if (texto != null) node.textContent = texto;
    return node;
  }

  function renderTopicos(data) {
    state.topicos = Array.isArray(data.topicos) ? data.topicos : [];
    state.selecionados.clear();
    el.list.replaceChildren();
    el.results.classList.remove('hidden');
    el.resumo.textContent = `${state.topicos.length} pauta(s) selecionadas entre ${data.totalColetado || data.totalAnalisado || 0} coletadas` +
      (data.totalDescartado ? ` · ${data.totalDescartado} fora do perfil` : '') +
      (data.totalJaUsado ? ` · ${data.totalJaUsado} já usada(s)` : '') +
      (data.totalClaude ? ` · ${data.totalClaude} encontrada(s) pelo Claude` : '') +
      (data.complementoPublico ? ` · ${data.complementoPublico} a partir do histórico da Página` : '') +
      (state.topicos.length > 0 && state.topicos.length < 10 ? ' · a lista não foi completada com pautas fracas' : '');

    if (!state.topicos.length) {
      const vazio = criarElemento('div', 'rounded-xl border border-dashed border-slate-700 p-8 text-center text-sm text-slate-400', 'Nenhuma pauta nova desse segmento foi encontrada no período. Tente outro eixo ou aumente o período.');
      el.list.appendChild(vazio);
      atualizarAcoes();
      return;
    }

    state.topicos.forEach((topico, index) => {
      const card = criarElemento('article', 'virais-card rounded-xl border border-slate-800 bg-slate-900/55 p-3.5 transition hover:border-slate-700');
      card.dataset.index = String(index);
      const row = criarElemento('div', 'flex gap-3');
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.className = 'virais-check mt-1 h-4 w-4 shrink-0 rounded border-slate-600 bg-slate-950 text-emerald-500 focus:ring-emerald-500/40';
      check.setAttribute('aria-label', `Selecionar pauta ${index + 1}`);
      row.appendChild(check);

      const body = criarElemento('div', 'min-w-0 flex-1');
      const meta = criarElemento('div', 'flex flex-wrap items-center gap-1.5 text-[10px]');
      const eixo = criarElemento('span', `rounded px-1.5 py-0.5 font-semibold ${topico.grupo === 'principal' ? 'bg-emerald-500/10 text-emerald-300' : 'bg-sky-500/10 text-sky-300'}`, topico.eixoNome || 'Pauta');
      const score = criarElemento('span', `rounded px-1.5 py-0.5 font-semibold ${Number(topico.potencialCompartilhamento) >= 8 ? 'bg-orange-500/15 text-orange-300' : 'bg-slate-800 text-slate-400'}`, `${topico.potencialCompartilhamento || 0}/10 compartilhamento`);
      meta.append(eixo, score);
      if (topico.origemPesquisa === 'claude') {
        meta.appendChild(criarElemento('span', 'rounded bg-violet-500/10 px-1.5 py-0.5 font-semibold text-violet-300', 'Pesquisa Claude'));
      }
      const dataLabel = formatarData(topico);
      if (dataLabel) meta.appendChild(criarElemento('span', 'text-slate-600', dataLabel));
      body.appendChild(meta);
      body.appendChild(criarElemento('h3', 'mt-1.5 text-sm font-semibold leading-5 text-white', topico.titulo || 'Sem título'));
      if (topico.resumo) body.appendChild(criarElemento('p', 'mt-1.5 text-xs leading-5 text-slate-400', topico.resumo));
      body.appendChild(criarElemento('p', 'mt-1.5 text-[10px] text-slate-600', topico.motivo || 'Afinidade com o público'));

      const actions = criarElemento('div', 'mt-2.5 flex flex-wrap items-center gap-2');
      if (topico.url) {
        const fonte = criarElemento('a', 'rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-400 hover:border-slate-500 hover:text-white', `Fonte: ${topico.veiculo || 'abrir'} ↗`);
        fonte.href = topico.url;
        fonte.target = '_blank';
        fonte.rel = 'noopener';
        actions.appendChild(fonte);
      }
      const criar = criarElemento('button', 'virais-create-one rounded-md border border-orange-500/35 bg-orange-500/10 px-2.5 py-1 text-[11px] font-semibold text-orange-200 hover:bg-orange-500/20', 'Criar com Claude');
      criar.type = 'button';
      criar.addEventListener('click', () => gerarSelecionados([index]));
      actions.appendChild(criar);
      body.appendChild(actions);
      row.appendChild(body);
      card.appendChild(row);

      check.addEventListener('change', () => {
        if (check.checked && state.selecionados.size >= 3) {
          check.checked = false;
          setStatus('Escolha no máximo 3 pautas por vez para não sobrecarregar o Claude.', true);
          return;
        }
        if (check.checked) state.selecionados.add(index);
        else state.selecionados.delete(index);
        card.classList.toggle('border-emerald-500/50', check.checked);
        card.classList.toggle('bg-emerald-500/5', check.checked);
        atualizarAcoes();
      });
      el.list.appendChild(card);
    });
    atualizarAcoes();
  }

  function renderLoading() {
    el.results.classList.remove('hidden');
    el.resumo.textContent = 'Pesquisando fontes recentes e separando as pautas do perfil…';
    el.list.replaceChildren();
    for (let i = 0; i < 5; i += 1) {
      el.list.appendChild(criarElemento('div', 'h-28 animate-pulse rounded-xl border border-slate-800 bg-slate-900/60'));
    }
  }

  async function pesquisar(event) {
    event?.preventDefault();
    if (state.pesquisando || !page.dataset.paginaId) return;
    state.pesquisando = true;
    const submit = el.form.querySelector('button[type="submit"]');
    submit.disabled = true;
    renderLoading();
    setStatus('Pesquisando e selecionando fatos recentes para o público da JM Notícia…');
    try {
      const inicio = await api('/api/virais/pesquisar/iniciar', {
        eixo: el.eixo.value,
        periodo: el.periodo.value,
        termo: el.termo.value,
        limite: el.eixo.value === 'all' ? 10 : 20,
      });
      if (!inicio.jobId) throw new Error('O servidor não iniciou a pesquisa do Claude.');
      const data = await consultarPesquisa(inicio.jobId);
      renderTopicos(data);
      setStatus(
        `${(data.topicos || []).length} pauta(s) nova(s) prontas para avaliação${data.doCache ? ' · resultado recente reutilizado' : ''}.` +
        (data.avisoClaude ? ` Pesquisa nativa indisponível (${data.avisoClaude}); usei os buscadores de apoio.` : ''),
        false
      );
    } catch (err) {
      el.results.classList.add('hidden');
      setStatus(err.message || 'Não foi possível pesquisar as pautas.', true);
    } finally {
      state.pesquisando = false;
      submit.disabled = false;
    }
  }

  function renderCriados(data) {
    el.created.classList.remove('hidden');
    el.createdMessage.textContent = data.mensagem || 'Rascunhos criados.';
    el.createdList.replaceChildren();
    (data.gerados || []).forEach((item) => {
      const card = criarElemento('article', 'rounded-lg border border-emerald-500/20 bg-slate-950/50 p-3');
      card.appendChild(criarElemento('h3', 'text-sm font-semibold text-white', item.titulo || 'Matéria criada'));
      if (Array.isArray(item.titulosAlternativos) && item.titulosAlternativos.length) {
        card.appendChild(criarElemento('p', 'mt-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500', '3 sugestões de título do Claude'));
        const lista = criarElemento('ol', 'mt-1 list-decimal space-y-1 pl-5 text-xs leading-5 text-slate-300');
        item.titulosAlternativos.forEach((titulo) => lista.appendChild(criarElemento('li', '', titulo)));
        card.appendChild(lista);
      }
      if (Array.isArray(item.hashtags) && item.hashtags.length) {
        card.appendChild(criarElemento('p', 'mt-2 text-xs text-emerald-300/80', item.hashtags.map((tag) => `#${String(tag).replace(/^#/, '')}`).join(' ')));
      }
      const abrir = criarElemento('a', 'mt-3 inline-flex rounded-md bg-emerald-500 px-2.5 py-1.5 text-xs font-semibold text-slate-950 hover:bg-emerald-400', 'Revisar e publicar →');
      abrir.href = item.redirect || `/materias-ia/${item.matterId}`;
      card.appendChild(abrir);
      el.createdList.appendChild(card);
    });
    el.created.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function gerarSelecionados(indices = null) {
    if (state.gerando) return;
    const escolhidos = Array.isArray(indices) ? indices : [...state.selecionados];
    const pautas = escolhidos.map((index) => state.topicos[index]).filter(Boolean).slice(0, 3);
    if (!pautas.length) return;
    state.gerando = true;
    atualizarAcoes();
    el.list.querySelectorAll('button').forEach((button) => { button.disabled = true; });
    setStatus(`Claude está apurando e escrevendo ${pautas.length} matéria(s). Isso pode levar alguns minutos…`);
    try {
      const data = await api('/api/virais/gerar', {
        pautas,
        periodo: el.periodo.value,
        tom: el.tom.value,
      });
      renderCriados(data);
      setStatus(data.mensagem || 'Matérias criadas como rascunho.');
    } catch (err) {
      setStatus(err.message || 'Não foi possível criar as matérias.', true);
    } finally {
      state.gerando = false;
      el.list.querySelectorAll('button').forEach((button) => { button.disabled = false; });
      atualizarAcoes();
    }
  }

  el.form?.addEventListener('submit', pesquisar);
  el.gerar?.addEventListener('click', () => gerarSelecionados());
  el.selecionar?.addEventListener('click', () => {
    const checks = [...el.list.querySelectorAll('.virais-check')];
    if (state.selecionados.size) {
      checks.forEach((check) => { if (check.checked) check.click(); });
      return;
    }
    checks.slice(0, 3).forEach((check) => { if (!check.checked) check.click(); });
  });
})();
