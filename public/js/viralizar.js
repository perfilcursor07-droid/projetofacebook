(function initViralizar() {
  const pageSelect = document.getElementById('vir-page');
  const statusEl = document.getElementById('vir-status');
  const listaEl = document.getElementById('vir-lista');
  const btnCurar = document.getElementById('vir-btn-curar');
  const btnGerar = document.getElementById('vir-btn-gerar');
  const autoPub = document.getElementById('vir-auto-pub');
  const tipoEl = document.getElementById('vir-tipo');
  const generatingEl = document.getElementById('vir-generating');
  const generatingText = document.getElementById('vir-generating-text');
  if (!pageSelect || !listaEl) return;

  let topicos = [];

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
    if (!topicos.length) {
      listaEl.innerHTML =
        '<p class="rounded-xl border border-dashed border-slate-700 px-4 py-10 text-center text-sm text-slate-500">Clique em “Buscar pautas virais agora” — a IA encontra sozinha o que mais engaja o público da página.</p>';
      btnGerar.disabled = true;
      return;
    }

    listaEl.innerHTML = topicos
      .map((t, i) => {
        const titulo = escapeHtml(t.titulo);
        const resumo = escapeHtml(String(t.resumo || '').slice(0, 200));
        const tema = escapeHtml(t.temaLabel || 'Geral');
        const pot = t.potencial || 'medio';
        const meta = [
          tema,
          'score ' + (t.scoreViral || 0),
          t.fonte || t.veiculo || '',
          t.contagemFontes ? t.contagemFontes + ' fontes' : '',
        ]
          .filter(Boolean)
          .join(' · ');
        return `
        <label class="flex gap-3 rounded-xl border border-slate-800 bg-slate-950/50 p-4 cursor-pointer hover:border-rose-500/40">
          <input type="checkbox" class="vir-check mt-1 accent-rose-500" data-idx="${i}" ${pot === 'alto' ? 'checked' : ''} />
          <span class="min-w-0 flex-1">
            <span class="flex flex-wrap items-center gap-2">
              <span class="text-sm font-medium text-white">${titulo}</span>
              <span class="rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ${potencialBadge(pot)}">${escapeHtml(pot)}</span>
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

  btnCurar.addEventListener('click', async () => {
    btnCurar.disabled = true;
    statusEl.textContent = 'Buscando pautas alinhadas ao público da página…';
    listaEl.innerHTML = '';
    topicos = [];
    try {
      const res = await fetch('/api/viralizar/curar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          facebookPageId: pageSelect.value ? Number(pageSelect.value) : null,
          limit: 12,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Falha na curadoria');
      topicos = data.topicos || [];
      const avisos = (data.avisos || []).filter(Boolean);
      const slot = data.slotSugerido?.label ? ' · sugerido: ' + data.slotSugerido.label : '';
      statusEl.textContent =
        topicos.length +
        ' pauta(s) ranqueada(s) · analisadas ' +
        (data.totalAnalisado || 0) +
        slot +
        (avisos.length ? ' — ' + avisos.join(' ') : '');
      renderLista();
    } catch (err) {
      statusEl.textContent = err.message;
      renderLista();
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
    setGenerating(
      true,
      publicar
        ? 'Gerando e publicando… Isso pode levar alguns minutos.'
        : 'Gerando rascunhos em Matérias salvas…'
    );
    btnGerar.disabled = true;
    statusEl.textContent = 'Gerando…';

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
      statusEl.innerHTML =
        escapeHtml(data.mensagem || 'Pronto.') +
        (links ? '<br/><span class="text-xs">Abrir: ' + links + '</span>' : '') +
        (data.erros?.length
          ? '<br/><span class="text-xs text-amber-300">' +
            data.erros.length +
            ' falha(s)</span>'
          : '');

      if (!publicar && data.gerados?.[0]?.redirect) {
        window.open(data.gerados[0].redirect, '_blank', 'noopener');
      }
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

  loadPages();
  renderLista();
})();
