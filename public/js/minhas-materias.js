(function initMinhasMaterias() {
  const list = document.getElementById('mia-matters-list');
  const tabs = document.getElementById('mia-status-tabs');
  const emptyTab = document.getElementById('mia-empty-tab');
  const visibleCountEl = document.getElementById('mia-visible-count');
  let currentStatus = window.__MIA_STATUS__ || 'all';

  function formatViews(n) {
    const v = Number(n);
    if (!Number.isFinite(v) || v < 0) return null;
    if (v >= 1000000) return (v / 1000000).toFixed(1).replace(/\.0$/, '') + ' mi';
    if (v >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + ' mil';
    return String(Math.round(v));
  }

  function rows() {
    return list ? Array.from(list.querySelectorAll('.mia-matter-row')) : [];
  }

  function recountTabs() {
    if (!tabs) return;
    const all = rows();
    const byStatus = { all: all.length };
    all.forEach((row) => {
      const st = row.dataset.status || 'rascunho';
      byStatus[st] = (byStatus[st] || 0) + 1;
    });
    tabs.querySelectorAll('.mia-status-tab').forEach((tab) => {
      const key = tab.dataset.status;
      const countEl = tab.querySelector('.mia-tab-count');
      if (countEl) countEl.textContent = String(byStatus[key] || 0);
      if (key !== 'all' && key !== currentStatus && !(byStatus[key] > 0)) {
        tab.classList.add('hidden');
      } else {
        tab.classList.remove('hidden');
      }
    });
  }

  function applyFilter(status) {
    currentStatus = status || 'all';
    if (!list) return;

    let visible = 0;
    rows().forEach((row) => {
      const st = row.dataset.status || 'rascunho';
      const show = currentStatus === 'all' || currentStatus === st;
      row.classList.toggle('hidden', !show);
      if (show) visible += 1;
    });

    if (visibleCountEl) visibleCountEl.textContent = String(visible);
    if (emptyTab) emptyTab.classList.toggle('hidden', visible > 0 || rows().length === 0);

    if (tabs) {
      tabs.querySelectorAll('.mia-status-tab').forEach((tab) => {
        const active = tab.dataset.status === currentStatus;
        tab.setAttribute('aria-selected', active ? 'true' : 'false');
        tab.classList.toggle('bg-emerald-500', active);
        tab.classList.toggle('text-slate-950', active);
        tab.classList.toggle('border', !active);
        tab.classList.toggle('border-slate-800', !active);
        tab.classList.toggle('bg-slate-900/50', !active);
        tab.classList.toggle('text-slate-400', !active);
        const countEl = tab.querySelector('.mia-tab-count');
        if (countEl) {
          countEl.className =
            'mia-tab-count rounded-md px-1.5 py-0.5 text-[10px] tabular-nums ' +
            (active ? 'bg-slate-950/20 text-slate-900' : 'bg-slate-800 text-slate-400');
        }
      });
    }

    try {
      const url = new URL(window.location.href);
      if (currentStatus === 'all') url.searchParams.delete('status');
      else url.searchParams.set('status', currentStatus);
      window.history.replaceState({}, '', url.pathname + url.search);
    } catch (_) {}
  }

  if (tabs) {
    tabs.addEventListener('click', (e) => {
      const tab = e.target.closest('.mia-status-tab');
      if (!tab || !list) return;
      e.preventDefault();
      applyFilter(tab.dataset.status || 'all');
    });
  }

  if (list) {
    list.addEventListener('click', async (e) => {
      const removeBtn = e.target.closest('.mia-matter-remove');
      const variacaoBtn = e.target.closest('.mia-matter-variacao');
      const viewsBtn = e.target.closest('.mia-matter-views');

      if (viewsBtn) {
        e.preventDefault();
        const id = viewsBtn.dataset.id;
        const label = viewsBtn.querySelector('.mia-views-label');
        if (!id || !label) return;
        const prev = label.textContent;
        label.textContent = '…';
        viewsBtn.disabled = true;
        try {
          const res = await fetch('/api/materias-ia/matters/' + id + '/views?force=1', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'Falha ao buscar views');
          if (data.views != null) {
            label.textContent = formatViews(data.views) + ' views';
          } else {
            label.textContent = prev.includes('views') ? prev : 'Sem dado';
            if (data.message) viewsBtn.title = data.message;
          }
        } catch (err) {
          label.textContent = prev;
          alert(err.message || 'Erro ao buscar visualizações');
        } finally {
          viewsBtn.disabled = false;
        }
        return;
      }

      if (variacaoBtn) {
        e.preventDefault();
        const id = variacaoBtn.dataset.id;
        const titulo = variacaoBtn.dataset.titulo || 'esta matéria';
        if (!id) return;
        if (
          !confirm(
            'Criar uma NOVA matéria no tema de "' +
              titulo +
              '"?\n\nA IA busca infos novas (Brave) e reescreve sem plagiar o texto atual.'
          )
        ) {
          return;
        }
        variacaoBtn.disabled = true;
        const old = variacaoBtn.textContent;
        variacaoBtn.textContent = '…';
        try {
          const res = await fetch('/api/materias-ia/matters/' + id + '/variacao', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'Falha ao gerar variação');
          const dest =
            data.redirect || (data.matter?.id ? '/materias-ia/' + data.matter.id : null);
          if (dest) {
            window.location.href = dest;
            return;
          }
          alert('Matéria gerada, mas sem redirecionamento.');
        } catch (err) {
          alert(err.message || 'Erro ao gerar nova matéria');
        } finally {
          variacaoBtn.disabled = false;
          variacaoBtn.textContent = old;
        }
        return;
      }

      if (!removeBtn) return;
      e.preventDefault();
      const id = removeBtn.dataset.id;
      const titulo = removeBtn.dataset.titulo || 'esta matéria';
      if (!id) return;
      if (!confirm('Remover "' + titulo + '"? Essa ação não pode ser desfeita.')) return;

      removeBtn.disabled = true;
      removeBtn.textContent = '…';
      try {
        const res = await fetch('/api/materias-ia/matters/' + id, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Falha ao remover');

        const row = removeBtn.closest('.mia-matter-row');
        if (row) row.remove();

        recountTabs();
        applyFilter(currentStatus);

        if (rows().length === 0) {
          const host = document.querySelector('[data-matters-page]');
          if (list) {
            list.outerHTML =
              '<p class="mt-4 rounded-xl border border-dashed border-slate-700 px-4 py-8 text-center text-sm text-slate-400">' +
              'Nenhuma matéria gerada ainda.' +
              '<a href="/conteudo" class="mt-2 block text-emerald-400 hover:text-emerald-300">Criar conteúdo →</a>' +
              '</p>';
          }
          if (emptyTab) emptyTab.classList.add('hidden');
          const countWrap = document.getElementById('mia-matters-count');
          if (countWrap) countWrap.remove();
          if (tabs) tabs.remove();
          if (host) {
            /* keep page usable */
          }
        }
      } catch (err) {
        removeBtn.disabled = false;
        removeBtn.textContent = '×';
        alert(err.message || 'Erro ao remover');
      }
    });
  }

  applyFilter(currentStatus);
  recountTabs();
})();
