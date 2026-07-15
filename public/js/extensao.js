(function initExtensaoPage() {
  const form = document.getElementById('form-token');
  const statusEl = document.getElementById('token-status');
  const once = document.getElementById('token-once');
  const valueEl = document.getElementById('token-value');
  const queueStatus = document.getElementById('queue-status');
  const pageSelect = document.getElementById('queue-page');
  const checkAll = document.getElementById('check-all');

  function selectedIds() {
    return Array.from(document.querySelectorAll('.js-matter-check:checked')).map((el) => Number(el.value));
  }

  function setQueueMsg(msg, isError) {
    if (!queueStatus) return;
    queueStatus.textContent = msg || '';
    queueStatus.className = isError ? 'text-rose-300' : 'text-emerald-300';
  }

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    statusEl.textContent = 'Gerando…';
    once?.classList.add('hidden');
    try {
      const nome = form.nome_dispositivo.value;
      const res = await fetch('/api/extensao/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nome_dispositivo: nome }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Falha ao gerar token');
      valueEl.textContent = data.token;
      once?.classList.remove('hidden');
      statusEl.textContent = 'Token gerado. Copie e cole na extensão.';
      setTimeout(() => window.location.reload(), 2500);
    } catch (err) {
      statusEl.textContent = err.message;
      statusEl.className = 'mt-3 text-sm text-rose-300';
    }
  });

  document.getElementById('btn-copy-token')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(valueEl.textContent);
      statusEl.textContent = 'Token copiado ✓';
    } catch {
      statusEl.textContent = 'Selecione e copie o token manualmente.';
    }
  });

  document.querySelectorAll('.js-revoke').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Revogar este token? A extensão deixará de funcionar até gerar outro.')) return;
      const id = btn.dataset.id;
      const res = await fetch('/api/extensao/tokens/' + id + '/revogar', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(data.error || 'Falha ao revogar');
        return;
      }
      window.location.reload();
    });
  });

  checkAll?.addEventListener('change', () => {
    document.querySelectorAll('.js-matter-check').forEach((el) => {
      el.checked = checkAll.checked;
    });
  });

  document.getElementById('btn-queue-selected')?.addEventListener('click', async () => {
    const ids = selectedIds();
    if (!ids.length) {
      setQueueMsg('Marque ao menos uma matéria.', true);
      return;
    }
    if (!pageSelect?.value) {
      setQueueMsg('Selecione a Página do Facebook.', true);
      return;
    }
    setQueueMsg('Enfileirando…');
    try {
      const res = await fetch('/api/materias-ia/matters/enfileirar-extensao', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ids,
          facebookPageId: Number(pageSelect.value),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Falha ao enfileirar');
      setQueueMsg(data.message || 'Na fila ✓');
      setTimeout(() => window.location.reload(), 900);
    } catch (err) {
      setQueueMsg(err.message, true);
    }
  });

  document.getElementById('btn-dequeue-selected')?.addEventListener('click', async () => {
    const ids = selectedIds();
    if (!ids.length) {
      setQueueMsg('Marque ao menos uma matéria.', true);
      return;
    }
    setQueueMsg('Removendo da fila…');
    try {
      const res = await fetch('/api/materias-ia/matters/desenfileirar-extensao', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Falha ao tirar da fila');
      setQueueMsg((data.removidas || 0) + ' removida(s) da fila');
      setTimeout(() => window.location.reload(), 900);
    } catch (err) {
      setQueueMsg(err.message, true);
    }
  });
})();
