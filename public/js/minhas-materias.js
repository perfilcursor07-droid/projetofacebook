(function initMinhasMaterias() {
  const list = document.getElementById('mia-matters-list');
  if (!list) return;

  list.addEventListener('click', async (e) => {
    const btn = e.target.closest('.mia-matter-remove');
    if (!btn) return;
    e.preventDefault();
    const id = btn.dataset.id;
    const titulo = btn.dataset.titulo || 'esta matéria';
    if (!id) return;
    if (!confirm('Remover "' + titulo + '"? Essa ação não pode ser desfeita.')) return;

    btn.disabled = true;
    btn.textContent = '…';
    try {
      const res = await fetch('/api/materias-ia/matters/' + id, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Falha ao remover');

      const row = btn.closest('.mia-matter-row');
      if (row) row.remove();

      const remaining = list.querySelectorAll('.mia-matter-row').length;
      const countEl = document.querySelector('main p.text-slate-500');
      if (countEl && countEl.textContent.includes('salva')) {
        countEl.textContent = remaining + ' matéria(s) salva(s)';
      }

      if (remaining === 0) {
        list.outerHTML =
          '<p class="mt-8 rounded-xl border border-dashed border-slate-700 px-4 py-12 text-center text-sm text-slate-400">' +
          'Nenhuma matéria gerada ainda.' +
          '<a href="/materias-ia" class="mt-2 block text-emerald-400 hover:text-emerald-300">Ir para Gerar conteúdo IA →</a>' +
          '</p>';
      }
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Remover';
      alert(err.message || 'Erro ao remover');
    }
  });
})();
