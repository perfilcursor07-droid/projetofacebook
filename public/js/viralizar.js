(function initViralizar() {
  const pageSelect = document.getElementById('vir-page');
  const statusEl = document.getElementById('vir-status');
  const listaEl = document.getElementById('vir-lista');
  const tabsEl = document.getElementById('vir-tabs');
  const excluidosWrap = document.getElementById('vir-excluidos-wrap');
  const excluidosEl = document.getElementById('vir-excluidos');
  const btnCurar = document.getElementById('vir-btn-curar');
  const btnGerar = document.getElementById('vir-btn-gerar');
  const autoPub = document.getElementById('vir-auto-pub');
  const tipoEl = document.getElementById('vir-tipo');
  const generatingEl = document.getElementById('vir-generating');
  const generatingText = document.getElementById('vir-generating-text');
  if (!pageSelect || !listaEl) return;

  let topicos = [];
  let abaAtiva = 'todos';
  let excluidosAtuais = [];
  let metaUltimaBusca = null;

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
    if (!generatingEl) return;
    if (message && generatingText) generatingText.textContent = message;
    generatingEl.classList.toggle('hidden', !on);
    document.body.style.overflow = on ? 'hidden' : '';
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
        facebookPageId: pageSelect.value ? Number(pageSelect.value) : null,
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
      // Descarta cache muito antigo (7 dias)
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

    if (cached.facebookPageId && pageSelect.querySelector(`option[value="${cached.facebookPageId}"]`)) {
      pageSelect.value = String(cached.facebookPageId);
    }
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

  /**
   * Sem consumir ScrapeCreators/News: só confere no banco o que já virou matéria
   * (rascunho, agendada ou publicada) e move para “já usadas”.
   */
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
          facebookPageId: pageSelect.value ? Number(pageSelect.value) : null,
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
      if (!silencioso) {
        console.warn('viralizar sync:', err.message);
      }
    }
  }

  function atualizarTabs() {
    if (!tabsEl) return;
    const c = contagens();
    tabsEl.classList.toggle('hidden', !topicos.length);
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

  async function loadPages() {
    try {
      const res = await fetch('/api/facebook/pages');
      const data = await res.json();
      const pages = data.pages || [];
      const preferred =
        Number(data.default_facebook_page_id) ||
        (pages.find((p) => p.is_default)?.id) ||
        null;
      pageSelect.innerHTML = !pages.length
        ? '<option value="">Conecte uma página em /paginas</option>'
        : pages
            .map((p) => {
              const selected = Number(p.id) === Number(preferred) ? ' selected' : '';
              const tag = p.is_default ? ' · padrão' : '';
              return `<option value="${p.id}"${selected}>${escapeHtml(p.page_name)}${tag}</option>`;
            })
            .join('');
    } catch {
      pageSelect.innerHTML = '<option value="">Erro ao carregar páginas</option>';
    }
  }

  function renderLista() {
    atualizarTabs();

    if (!topicos.length) {
      listaEl.innerHTML =
        '<p class="rounded-xl border border-dashed border-slate-700 px-4 py-10 text-center text-sm text-slate-500">Clique em “Buscar pautas virais agora” — a IA encontra sozinha o que mais engaja o público da página.</p>';
      btnGerar.disabled = true;
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
      btnGerar.disabled = true;
      return;
    }

    listaEl.innerHTML = filtrados
      .map(({ t, idx }) => {
        const titulo = escapeHtml(t.titulo);
        const resumo = escapeHtml(String(t.resumo || '').slice(0, 200));
        const tema = escapeHtml(t.temaLabel || 'Geral');
        const pot = t.potencial || 'medio';
        const eng = engajamentoMeta(t);
        const meta = [
          tema,
          'score ' + (t.scoreViral || 0),
          t.fonte || t.veiculo || '',
          eng,
          t.contagemFontes ? t.contagemFontes + ' fontes' : '',
        ]
          .filter(Boolean)
          .join(' · ');
        return `
        <label class="flex gap-3 rounded-xl border border-slate-800 bg-slate-950/50 p-4 cursor-pointer hover:border-rose-500/40">
          <input type="checkbox" class="vir-check mt-1 accent-rose-500" data-idx="${idx}" ${pot === 'alto' ? 'checked' : ''} />
          <span class="min-w-0 flex-1">
            <span class="flex flex-wrap items-center gap-2">
              <span class="text-sm font-medium text-white">${titulo}</span>
              <span class="rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ${potencialBadge(pot)}">${escapeHtml(pot)}</span>
              ${origemBadge(t)}
            </span>
            <span class="mt-1 block text-xs text-slate-500">${escapeHtml(meta)}</span>
            ${resumo ? `<span class="mt-1 block text-xs text-slate-400">${resumo}${String(t.resumo || '').length > 200 ? '…' : ''}</span>` : ''}
            ${t.link ? `<a href="${escapeHtml(t.link)}" target="_blank" rel="noopener" class="mt-2 inline-block text-xs text-sky-400 hover:text-sky-300">Abrir fonte →</a>` : ''}
          </span>
        </label>`;
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

  function syncGerarBtn() {
    const n = listaEl.querySelectorAll('.vir-check:checked').length;
    btnGerar.disabled = n < 1;
    btnGerar.textContent = n
      ? autoPub.checked
        ? `Gerar e publicar (${n})`
        : `Gerar rascunhos (${n})`
      : 'Gerar selecionados';
  }

  function selecionados() {
    return [...listaEl.querySelectorAll('.vir-check:checked')]
      .map((c) => topicos[Number(c.dataset.idx)])
      .filter(Boolean);
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
    if (cacheInfoEl) {
      cacheInfoEl.classList.add('hidden');
    }
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
          facebookPageId: pageSelect.value ? Number(pageSelect.value) : null,
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

  btnGerar.addEventListener('click', async () => {
    const sel = selecionados();
    if (!sel.length) {
      statusEl.textContent = 'Marque ao menos 1 pauta';
      return;
    }
    if (!pageSelect.value) {
      statusEl.textContent = 'Selecione a página do Facebook';
      return;
    }

    const publicar = Boolean(autoPub.checked);
    const qtd = Math.min(sel.length, 20);
    setGenerating(
      true,
      publicar
        ? `Gerando e publicando ${qtd} matéria(s)… Isso pode levar vários minutos.`
        : `Gerando ${qtd} rascunho(s) em Matérias salvas… Pode demorar.`
    );
    btnGerar.disabled = true;
    statusEl.textContent = `Gerando ${qtd} de ${sel.length} selecionada(s)…`;

    try {
      const res = await fetch('/api/viralizar/gerar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          facebookPageId: Number(pageSelect.value),
          tipoPublicacao: tipoEl?.value || 'foto',
          publicar,
          topicos: sel,
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
          ? '<br/><span class="text-xs text-amber-300">' +
            data.erros.length +
            ' falha(s)</span>'
          : '');
      statusEl.innerHTML = msgOk;

      if (!publicar && data.gerados?.[0]?.redirect) {
        window.open(data.gerados[0].redirect, '_blank', 'noopener');
      }

      // Atualiza lista salva sem apagar a mensagem de sucesso
      await sincronizarUsadosDoServidor({ silencioso: true, preservarStatusHtml: msgOk });
    } catch (err) {
      setGenerating(false);
      statusEl.textContent = err.message;
    } finally {
      syncGerarBtn();
    }
  });

  listaEl.addEventListener('change', (e) => {
    if (e.target.classList.contains('vir-check')) syncGerarBtn();
  });
  autoPub.addEventListener('change', syncGerarBtn);

  loadPages().then(async () => {
    if (restaurarCache()) {
      await sincronizarUsadosDoServidor({ silencioso: true });
      atualizarCacheInfo(lerCache()?.salvoEm, true);
    } else {
      renderLista();
    }
  });
})();
