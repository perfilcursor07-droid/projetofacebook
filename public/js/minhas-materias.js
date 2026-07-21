(function initMinhasMaterias() {
  const list = document.getElementById('mia-matters-list');
  if (!list) return;

  function formatViews(n) {
    const v = Number(n);
    if (!Number.isFinite(v) || v < 0) return null;
    if (v >= 1000000) return (v / 1000000).toFixed(1).replace(/\.0$/, '') + ' mi';
    if (v >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + ' mil';
    return String(Math.round(v));
  }

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
      window.location.reload();
    } catch (err) {
      removeBtn.disabled = false;
      removeBtn.textContent = '×';
      alert(err.message || 'Erro ao remover');
    }
  });
})();
