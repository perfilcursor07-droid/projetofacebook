(function initViralizar() {
  const statusEl = document.getElementById('vir-status');
  const listaEl = document.getElementById('vir-lista');
  const tabsEl = document.getElementById('vir-tabs');
  const loteBar = document.getElementById('vir-lote-bar');
  const selCountEl = document.getElementById('vir-sel-count');
  const excluidosWrap = document.getElementById('vir-excluidos-wrap');
  const excluidosEl = document.getElementById('vir-excluidos');
  const btnCurar = document.getElementById('vir-btn-curar');
  const btnGerar = document.getElementById('vir-btn-gerar');
  const btnSelTodos = document.getElementById('vir-btn-sel-todos');
  const btnSelLimpar = document.getElementById('vir-btn-sel-limpar');
  const autoPub = document.getElementById('vir-auto-pub');
  const tipoEl = document.getElementById('vir-tipo');
  const generatingEl = document.getElementById('vir-generating');
  const generatingText = document.getElementById('vir-generating-text');
  if (!listaEl) return;

  let topicos = [];
  let abaAtiva = 'todos';
  let excluidosAtuais = [];
  let metaUltimaBusca = null;
  let gerando = false;

  const CACHE_KEY = 'viralizar_curadoria_v1';
  const cacheInfoEl = document.getElementById('vir-cache-info');

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function setGenerating(on, message) {
    gerando = Boolean(on);
    if (!generatingEl) return;
    if (message && generatingText) generatingText.textContent = message;
    generatingEl.classList.toggle('hidden', !on);
    document.body.style.overflow = on ? 'hidden' : '';
    document.querySelectorAll('.vir-btn-one').forEach((b) => {
      b.disabled = on;
    });
    if (btnGerar) btnGerar.disabled = on || selecionados().length < 1;
  }

  function potencialBadge(p) {
    if (p === 'alto') return 'bg-rose-500/20 text-rose-200 ring-rose-500/30';
    if (p === 'baixo') return 'bg-slate-700/40 text-slate-400 ring-slate-600/40';
    return 'bg-amber-500/15 text-amber-200 ring-amber-500/25';
  }

  function origemDoTopico(t) {
    const o = String(t.origemSocial || t.plataforma || '').toLowerCase();
    const fonte = String(t.fonte || '');
    const link = String(t.link || '');
    if (o === 'instagram' || /instagram/i.test(fonte) || /instagram\.com/i.test(link)) {
      return 'instagram';
    }
    if (o === 'facebook' || /facebook/i.test(fonte) || /facebook\.com|fb\.watch/i.test(link)) {
      return 'facebook';
    }
    if (t.redeSocial || t.tipoFonte === 'rede_social') {
      return 'redes';
    }
    return 'noticia';
  }

  function origemBadge(t) {
    const origem = origemDoTopico(t);
    if (origem === 'instagram') {
      return '<span class="rounded-md bg-fuchsia-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-fuchsia-200 ring-1 ring-fuchsia-500/30">Instagram</span>';
    }
    if (origem === 'facebook') {
      return '<span class="rounded-md bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-200 ring-1 ring-sky-500/30">Facebook</span>';
    }
    if (origem === 'redes') {
      return '<span class="rounded-md bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-200 ring-1 ring-violet-500/30">Redes</span>';
    }
    return '<span class="rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-200/90 ring-1 ring-emerald-500/25">Notícia</span>';
  }

  function engajamentoMeta(t) {
    const parts = [];
    if (t.likes) parts.push(t.likes + ' curtidas');
    if (t.comments) parts.push(t.comments + ' coment.');
    if (t.views) parts.push(t.views + ' views');
    return parts.join(' · ');
  }

  function contagens() {
    const c = { todos: topicos.length, noticia: 0, instagram: 0, facebook: 0, redes: 0, alto: 0 };
    for (const t of topicos) {
      const o = origemDoTopico(t);
      if (c[o] != null) c[o] += 1;
      if (t.potencial === 'alto') c.alto += 1;
    }
    return c;
  }

  function topicosFiltrados() {
    return topicos
      .map((t, idx) => ({ t, idx }))
      .filter(({ t }) => {
        if (abaAtiva === 'todos') return true;
        if (abaAtiva === 'alto') return t.potencial === 'alto';
        return origemDoTopico(t) === abaAtiva;
      });
  }

  function formatarQuando(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const diffMs = Date.now() - d.getTime();
    const min = Math.floor(diffMs / 60000);
    if (min < 1) return 'agora';
    if (min < 60) return `há ${min} min`;
    const h = Math.floor(min / 60);
    if (h < 24) return `há ${h}h`;
    const dias = Math.floor(h / 24);
    if (dias < 7) return `há ${dias} dia${dias > 1 ? 's' : ''}`;
    return d.toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function salvarCache() {
    try {
      const payload = {
        v: 1,
        salvoEm: new Date().toISOString(),
        abaAtiva,
        topicos,
        excluidos: excluidosAtuais,
        meta: metaUltimaBusca,
        statusText: statusEl.textContent || '',
      };
      localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
      atualizarCacheInfo(payload.salvoEm, false);
      if (btnCurar) btnCurar.textContent = 'Atualizar busca';
    } catch (err) {
      console.warn('viralizar cache save:', err.message);
    }
  }

  function lerCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || data.v !== 1 || !Array.isArray(data.topicos)) return null;
      if (data.salvoEm) {
        const age = Date.now() - new Date(data.salvoEm).getTime();
        if (age > 7 * 24 * 60 * 60 * 1000) {
          localStorage.removeItem(CACHE_KEY);
          return null;
        }
      }
      return data;
    } catch {
      return null;
    }
  }

  function atualizarCacheInfo(salvoEm, fromCache) {
    if (!cacheInfoEl) return;
    if (!salvoEm && !topicos.length) {
      cacheInfoEl.classList.add('hidden');
      cacheInfoEl.textContent = '';
      return;
    }
    const quando = formatarQuando(salvoEm);
    cacheInfoEl.classList.remove('hidden');
    cacheInfoEl.textContent = fromCache
      ? `Mostrando última busca salva (${quando}) — sem consumir API. Clique em “Atualizar busca” para pesquisar de novo.`
      : `Resultado salvo neste navegador (${quando}).`;
  }

  function montarStatusResumo(data) {
    const c = contagens();
    const avisos = (data?.avisos || []).filter(Boolean);
    const slot = data?.slotSugerido?.label ? ' · sugerido: ' + data.slotSugerido.label : '';
    const excl = excluidosAtuais || [];
    return (
      topicos.length +
      ' pauta(s) · ' +
      c.noticia +
      ' notícia · ' +
      c.instagram +
      ' IG · ' +
      c.facebook +
      ' FB' +
      (data?.totalGospel != null ? ' · ' + data.totalGospel + ' gospel' : '') +
      (data?.totalAnalisado != null ? ' · analisadas ' + data.totalAnalisado : '') +
      (excl.length ? ' · ' + excl.length + ' já usadas ocultas' : '') +
      slot +
      (avisos.length ? ' — ' + avisos.join(' ') : '')
    );
  }

  function aplicarResultado({ topicosNovos, excluidos, meta, statusOverride, fromCache }) {
    topicos = Array.isArray(topicosNovos) ? topicosNovos : [];
    excluidosAtuais = Array.isArray(excluidos) ? excluidos : [];
    metaUltimaBusca = meta || null;
    if (!fromCache) abaAtiva = 'todos';
    statusEl.textContent = statusOverride || montarStatusResumo(meta);
    renderLista();
    renderExcluidos(excluidosAtuais);
  }

  function restaurarCache() {
    const cached = lerCache();
    if (!cached || !cached.topicos.length) return false;

    if (cached.abaAtiva) abaAtiva = cached.abaAtiva;

    aplicarResultado({
      topicosNovos: cached.topicos,
      excluidos: cached.excluidos || [],
      meta: cached.meta || null,
      statusOverride: cached.statusText || null,
      fromCache: true,
    });
    atualizarCacheInfo(cached.salvoEm, true);
    if (btnCurar) btnCurar.textContent = 'Atualizar busca';
    return true;
  }

  async function sincronizarUsadosDoServidor({ silencioso = false, preservarStatusHtml = null } = {}) {
    if (!topicos.length) return;
    if (!silencioso) {
      statusEl.textContent = (statusEl.textContent || '') + ' · conferindo já usadas…';
    }
    try {
      const res = await fetch('/api/viralizar/sincronizar-usados', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topicos,
          excluidos: excluidosAtuais,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Falha ao sincronizar');

      const movidos = Number(data.novosExcluidos) || 0;
      aplicarResultado({
        topicosNovos: data.topicos || [],
        excluidos: data.excluidos || [],
        meta: metaUltimaBusca,
        statusOverride: null,
        fromCache: true,
      });
      if (preservarStatusHtml) {
        statusEl.innerHTML =
          preservarStatusHtml +
          (movidos
            ? `<br/><span class="text-xs text-slate-500">${movidos} pauta(s) movida(s) para “já usadas”.</span>`
            : '');
      } else {
        statusEl.textContent =
          montarStatusResumo(metaUltimaBusca) +
          (movidos
            ? ` · ${movidos} já gerada(s)/agendada(s)/publicada(s) movida(s) para abaixo`
            : '');
      }
      salvarCache();
    } catch (err) {
      if (!silencioso) console.warn('viralizar sync:', err.message);
    }
  }

  function atualizarTabs() {
    if (!tabsEl) return;
    const c = contagens();
    const show = topicos.length > 0;
    tabsEl.classList.toggle('hidden', !show);
    if (loteBar) loteBar.classList.toggle('hidden', !show);
    tabsEl.querySelectorAll('[data-count-for]').forEach((el) => {
      const key = el.getAttribute('data-count-for');
      const n = c[key] || 0;
      el.textContent = n ? `(${n})` : '(0)';
    });
    tabsEl.querySelectorAll('.vir-tab-btn').forEach((btn) => {
      const on = btn.dataset.virTab === abaAtiva;
      btn.classList.toggle('bg-rose-500', on);
      btn.classList.toggle('text-white', on);
      btn.classList.toggle('font-semibold', on);
      btn.classList.toggle('text-slate-300', !on);
    });
  }

  function renderLista() {
    atualizarTabs();

    if (!topicos.length) {
      listaEl.innerHTML =
        '<p class="rounded-xl border border-dashed border-slate-700 px-4 py-10 text-center text-sm text-slate-500">Clique em “Buscar pautas virais agora” — a IA encontra sozinha o que mais engaja o público da página.</p>';
      syncGerarBtn();
      return;
    }

    const filtrados = topicosFiltrados();
    if (!filtrados.length) {
      const labels = {
        noticia: 'notícias',
        instagram: 'Instagram',
        facebook: 'Facebook',
        alto: 'alto potencial',
      };
      listaEl.innerHTML = `<p class="rounded-xl border border-dashed border-slate-700 px-4 py-8 text-center text-sm text-slate-500">Nenhuma pauta nesta aba (${labels[abaAtiva] || abaAtiva}). Troque de aba ou busque de novo.</p>`;
      syncGerarBtn();
      return;
    }

    listaEl.innerHTML = filtrados
      .map(({ t, idx }) => {
        const titulo = escapeHtml(t.titulo);
        const resumo = escapeHtml(String(t.resumo || '').slice(0, 220));
        const tema = escapeHtml(t.temaLabel || 'Geral');
        const pot = t.potencial || 'medio';
        const eng = engajamentoMeta(t);
        const meta = [
          tema,
          'score ' + (t.scoreViral || 0),
          t.fonte || t.veiculo || '',
          eng,
        ]
          .filter(Boolean)
          .join(' · ');
        return `
        <article class="rounded-xl border border-slate-800 bg-slate-950/50 p-4 transition hover:border-rose-500/35">
          <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-4">
            <label class="flex min-w-0 flex-1 cursor-pointer gap-3">
              <input type="checkbox" class="vir-check mt-1 shrink-0 accent-rose-500" data-idx="${idx}" />
              <span class="min-w-0 flex-1">
                <span class="flex flex-wrap items-center gap-2">
                  <span class="text-sm font-medium leading-snug text-white">${titulo}</span>
                  <span class="rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ${potencialBadge(pot)}">${escapeHtml(pot)}</span>
                  ${origemBadge(t)}
                </span>
                <span class="mt-1.5 block text-xs text-slate-500">${escapeHtml(meta)}</span>
                ${resumo ? `<span class="mt-1.5 block text-xs leading-relaxed text-slate-400">${resumo}${String(t.resumo || '').length > 220 ? '…' : ''}</span>` : ''}
                ${t.link ? `<a href="${escapeHtml(t.link)}" target="_blank" rel="noopener" class="mt-2 inline-block text-xs text-sky-400 hover:text-sky-300" onclick="event.stopPropagation()">Abrir fonte →</a>` : ''}
              </span>
            </label>
            <div class="flex shrink-0 flex-row gap-2 sm:flex-col sm:items-stretch">
              <button type="button"
                class="vir-btn-one rounded-lg bg-rose-500 px-3.5 py-2 text-sm font-semibold text-white hover:bg-rose-400 disabled:opacity-50"
                data-idx="${idx}">
                Gerar
              </button>
              ${t.link ? `<a href="${escapeHtml(t.link)}" target="_blank" rel="noopener" class="rounded-lg border border-slate-600 px-3 py-2 text-center text-xs text-slate-300 hover:border-slate-400 hover:text-white">Fonte</a>` : ''}
            </div>
          </div>
        </article>`;
      })
      .join('');

    syncGerarBtn();
  }

  function renderExcluidos(excluidos) {
    if (!excluidosWrap || !excluidosEl) return;
    if (!excluidos || !excluidos.length) {
      excluidosWrap.classList.add('hidden');
      excluidosEl.innerHTML = '';
      return;
    }
    excluidosWrap.classList.remove('hidden');
    excluidosEl.innerHTML = excluidos
      .map((t) => {
        const titulo = escapeHtml(t.titulo || 'Sem título');
        const fonte = escapeHtml(t.fonte || '');
        return `
        <div class="flex items-start gap-2 rounded-lg border border-slate-800/80 bg-slate-950/40 px-3 py-2 opacity-75">
          <span class="mt-0.5 shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-300">já usada</span>
          <span class="min-w-0 flex-1">
            <span class="block text-xs text-slate-300">${titulo}</span>
            ${fonte ? `<span class="block text-[10px] text-slate-600">${fonte}</span>` : ''}
            ${t.link ? `<a href="${escapeHtml(t.link)}" target="_blank" rel="noopener" class="text-[10px] text-sky-500 hover:text-sky-400">fonte →</a>` : ''}
          </span>
        </div>`;
      })
      .join('');
  }

  function selecionados() {
    return [...listaEl.querySelectorAll('.vir-check:checked')]
      .map((c) => topicos[Number(c.dataset.idx)])
      .filter(Boolean);
  }

  function syncGerarBtn() {
    const n = listaEl.querySelectorAll('.vir-check:checked').length;
    if (btnGerar) {
      btnGerar.disabled = gerando || n < 1;
      btnGerar.textContent = n
        ? autoPub.checked
          ? `Gerar e publicar (${n})`
          : `Gerar selecionados (${n})`
        : 'Gerar selecionados';
    }
    if (selCountEl) {
      selCountEl.textContent = n ? `${n} marcada(s)` : 'Nenhuma marcada';
    }
  }

  async function gerarTopicos(lista, { abrirPrimeira = true } = {}) {
    const sel = (Array.isArray(lista) ? lista : []).filter((t) => t && t.titulo);
    if (!sel.length) {
      statusEl.textContent = 'Nenhuma pauta para gerar';
      return;
    }
    const publicar = Boolean(autoPub.checked);
    const qtd = Math.min(sel.length, 20);
    const uma = qtd === 1;
    setGenerating(
      true,
      publicar
        ? uma
          ? 'Gerando e publicando esta matéria…'
          : `Gerando e publicando ${qtd} matéria(s)…`
        : uma
          ? 'Gerando rascunho desta matéria…'
          : `Gerando ${qtd} rascunho(s)…`
    );
    statusEl.textContent = uma
      ? 'Gerando 1 matéria…'
      : `Gerando ${qtd} de ${sel.length} selecionada(s)…`;

    try {
      const res = await fetch('/api/viralizar/gerar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tipoPublicacao: tipoEl?.value || 'foto',
          publicar,
          topicos: sel.slice(0, 20),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Falha ao gerar');

      setGenerating(false);
      const links = (data.gerados || [])
        .filter((g) => g.redirect)
        .map(
          (g) =>
            `<a class="text-emerald-400 underline" href="${escapeHtml(g.redirect)}" target="_blank" rel="noopener">${escapeHtml(g.titulo || 'Matéria')}</a>`
        )
        .join(' · ');
      const msgOk =
        escapeHtml(data.mensagem || 'Pronto.') +
        (links ? '<br/><span class="text-xs">Abrir: ' + links + '</span>' : '') +
        (data.erros?.length
          ? '<br/><span class="text-xs text-amber-300">' + data.erros.length + ' falha(s)</span>'
          : '');
      statusEl.innerHTML = msgOk;

      if (abrirPrimeira && !publicar && data.gerados?.[0]?.redirect) {
        window.open(data.gerados[0].redirect, '_blank', 'noopener');
      }

      await sincronizarUsadosDoServidor({ silencioso: true, preservarStatusHtml: msgOk });
    } catch (err) {
      setGenerating(false);
      statusEl.textContent = err.message;
    } finally {
      syncGerarBtn();
    }
  }

  tabsEl?.addEventListener('click', (e) => {
    const btn = e.target.closest('.vir-tab-btn');
    if (!btn) return;
    abaAtiva = btn.dataset.virTab || 'todos';
    renderLista();
    if (topicos.length) salvarCache();
  });

  btnCurar.addEventListener('click', async () => {
    btnCurar.disabled = true;
    statusEl.textContent = 'Buscando pautas alinhadas ao público da página…';
    if (cacheInfoEl) cacheInfoEl.classList.add('hidden');
    listaEl.innerHTML = '';
    topicos = [];
    excluidosAtuais = [];
    abaAtiva = 'todos';
    renderExcluidos([]);
    atualizarTabs();
    try {
      const res = await fetch('/api/viralizar/curar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          limit: 20,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Falha na curadoria');

      excluidosAtuais = data.excluidos || [];
      metaUltimaBusca = {
        avisos: data.avisos || [],
        slotSugerido: data.slotSugerido || null,
        totalGospel: data.totalGospel,
        totalAnalisado: data.totalAnalisado,
        totalScrapeCreators: data.totalScrapeCreators,
      };
      aplicarResultado({
        topicosNovos: data.topicos || [],
        excluidos: excluidosAtuais,
        meta: metaUltimaBusca,
        fromCache: false,
      });
      salvarCache();
    } catch (err) {
      statusEl.textContent = err.message;
      renderLista();
      renderExcluidos([]);
    } finally {
      btnCurar.disabled = false;
    }
  });

  btnGerar?.addEventListener('click', () => gerarTopicos(selecionados()));

  btnSelTodos?.addEventListener('click', () => {
    listaEl.querySelectorAll('.vir-check').forEach((c) => {
      c.checked = true;
    });
    syncGerarBtn();
  });

  btnSelLimpar?.addEventListener('click', () => {
    listaEl.querySelectorAll('.vir-check').forEach((c) => {
      c.checked = false;
    });
    syncGerarBtn();
  });

  listaEl.addEventListener('change', (e) => {
    if (e.target.classList.contains('vir-check')) syncGerarBtn();
  });

  listaEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.vir-btn-one');
    if (!btn || gerando) return;
    e.preventDefault();
    e.stopPropagation();
    const idx = Number(btn.dataset.idx);
    const topico = topicos[idx];
    if (!topico) return;
    gerarTopicos([topico]);
  });

  autoPub?.addEventListener('change', syncGerarBtn);

  // ---- Abas principais: pautas x desempenho da página ----
  const paneP = document.getElementById('vir-pane-pautas');
  const paneD = document.getElementById('vir-pane-desempenho');
  const dStatus = document.getElementById('vir-desempenho-status');
  const dResumo = document.getElementById('vir-desempenho-resumo');
  const dLista = document.getElementById('vir-desempenho-lista');
  let desempenhoCarregado = false;

  function formatNum(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '—';
    if (v >= 1000000) return (v / 1000000).toFixed(1).replace(/\.0$/, '') + ' mi';
    if (v >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + ' mil';
    return String(Math.round(v));
  }

  function trocarView(view) {
    const ehDesempenho = view === 'desempenho';
    paneP?.classList.toggle('hidden', ehDesempenho);
    paneD?.classList.toggle('hidden', !ehDesempenho);
    document.querySelectorAll('.vir-view-btn').forEach((b) => {
      const on = b.dataset.virView === view;
      b.classList.toggle('bg-rose-500', on);
      b.classList.toggle('text-white', on);
      b.classList.toggle('font-semibold', on);
      b.classList.toggle('text-slate-300', !on);
    });
    if (ehDesempenho && !desempenhoCarregado) carregarDesempenho(false);
  }

  function cardResumo(label, valor, extra) {
    return `
      <div class="rounded-xl border border-slate-800 bg-slate-900/50 px-4 py-3">
        <p class="text-[11px] uppercase tracking-wide text-slate-500">${escapeHtml(label)}</p>
        <p class="mt-1 text-lg font-semibold text-white">${escapeHtml(String(valor))}</p>
        ${extra ? `<p class="text-[11px] text-slate-500">${escapeHtml(extra)}</p>` : ''}
      </div>`;
  }

  async function carregarDesempenho(atualizar) {
    if (!dLista) return;
    const btns = [
      document.getElementById('vir-btn-desempenho'),
      document.getElementById('vir-btn-desempenho-refresh'),
    ].filter(Boolean);
    btns.forEach((b) => {
      b.disabled = true;
    });
    if (dStatus) {
      dStatus.textContent = atualizar
        ? 'Lendo visualizações no Facebook…'
        : 'Analisando publicações da página…';
    }
    try {
      const url = '/api/viralizar/desempenho?limit=30' + (atualizar ? '&atualizar=1' : '');
      const res = await fetch(url);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Falha ao analisar');

      desempenhoCarregado = true;
      if (dResumo) {
        dResumo.classList.remove('hidden');
        dResumo.innerHTML = [
          cardResumo('Página', data.pagina?.nome || '—', 'padrão em /paginas'),
          cardResumo('Publicadas', data.total || 0, `${data.comViews || 0} com views`),
          cardResumo('Média de views', formatNum(data.mediaViews), `mediana ${formatNum(data.medianaViews)}`),
          cardResumo('Viralizaram', data.viralizaram || 0, data.limiarViral ? `≥ ${formatNum(data.limiarViral)} views` : 'sem base ainda'),
        ].join('');
      }

      const itens = data.itens || [];
      if (!itens.length) {
        dLista.innerHTML =
          '<p class="rounded-xl border border-dashed border-slate-700 px-4 py-8 text-center text-sm text-slate-500">Nenhuma matéria publicada nesta página ainda.</p>';
      } else {
        dLista.innerHTML = itens
          .map((i, pos) => {
            const badge = i.viralizou
              ? '<span class="rounded-md bg-rose-500/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-rose-200 ring-1 ring-rose-500/30">viralizou</span>'
              : i.acimaDaMedia
                ? '<span class="rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-200 ring-1 ring-emerald-500/25">acima da média</span>'
                : '';
            const quando = i.publicadoEm ? formatarQuando(i.publicadoEm) : '';
            return `
            <article class="flex flex-wrap items-center gap-3 rounded-xl border border-slate-800 bg-slate-950/50 px-4 py-3">
              <span class="w-6 shrink-0 text-xs text-slate-600">${pos + 1}</span>
              <span class="min-w-0 flex-1">
                <span class="flex flex-wrap items-center gap-2">
                  <a href="${escapeHtml(i.editarUrl)}" class="text-sm font-medium text-white hover:text-emerald-300">${escapeHtml(i.titulo || 'Sem título')}</a>
                  ${badge}
                </span>
                <span class="mt-0.5 block text-[11px] text-slate-500">${escapeHtml([i.tipo, quando].filter(Boolean).join(' · '))}</span>
              </span>
              <span class="shrink-0 text-right">
                <span class="block text-sm font-semibold text-slate-100">${escapeHtml(formatNum(i.views))}</span>
                <span class="block text-[10px] text-slate-600">views</span>
              </span>
              ${i.postUrl ? `<a href="${escapeHtml(i.postUrl)}" target="_blank" rel="noopener" class="shrink-0 rounded-lg border border-slate-600 px-2.5 py-1.5 text-[11px] text-slate-300 hover:border-slate-400 hover:text-white">Ver post</a>` : ''}
            </article>`;
          })
          .join('');
      }

      if (dStatus) {
        dStatus.textContent = (data.avisos || []).filter(Boolean).join(' ') || '';
      }
    } catch (err) {
      if (dStatus) dStatus.textContent = err.message;
    } finally {
      btns.forEach((b) => {
        b.disabled = false;
      });
    }
  }

  document.querySelectorAll('.vir-view-btn').forEach((b) => {
    b.addEventListener('click', () => trocarView(b.dataset.virView || 'pautas'));
  });
  document
    .getElementById('vir-btn-desempenho')
    ?.addEventListener('click', () => carregarDesempenho(false));
  document
    .getElementById('vir-btn-desempenho-refresh')
    ?.addEventListener('click', () => carregarDesempenho(true));

  (async () => {
    if (restaurarCache()) {
      await sincronizarUsadosDoServidor({ silencioso: true });
      atualizarCacheInfo(lerCache()?.salvoEm, true);
    } else {
      renderLista();
    }
  })();
})();
