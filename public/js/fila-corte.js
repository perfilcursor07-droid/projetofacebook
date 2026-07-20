(function initClipEdit() {
  const cfg = window.__CLIP_EDIT__;
  if (!cfg?.id || !cfg.canEdit) return;

  const statusEl = document.getElementById('clip-status');
  const pageSelect = document.getElementById('clip-page');
  const materiaEl = document.getElementById('clip-materia');
  const temaEl = document.getElementById('clip-tema');
  const capaTituloEl = document.getElementById('clip-capa-titulo');
  const modoEl = document.getElementById('clip-modo');
  const videoEl = document.getElementById('clip-video');

  function setStatus(msg, isError) {
    if (!statusEl) return;
    statusEl.textContent = msg || '';
    statusEl.className = 'mt-4 text-sm ' + (isError ? 'text-rose-300' : 'text-slate-400');
  }

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function loadPages() {
    if (!pageSelect) return;
    try {
      const res = await fetch('/api/facebook/pages');
      const data = await res.json();
      const pages = data.pages || [];
      if (!pages.length) {
        pageSelect.innerHTML = '<option value="">Conecte uma página em /paginas</option>';
        return;
      }
      const preferred =
        Number(data.default_facebook_page_id) ||
        (pages.find((p) => p.is_default)?.id) ||
        pages[0]?.id ||
        null;
      pageSelect.innerHTML = pages
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

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Falha na operação');
    return data;
  }

  document.getElementById('btn-materia')?.addEventListener('click', async () => {
    setStatus('Gerando matéria…');
    try {
      await postJson('/api/clips/' + cfg.id + '/materia', {
        tema: temaEl ? temaEl.value.trim() : '',
      });
      setStatus('Matéria enfileirada — atualizando em instantes…');
      setTimeout(() => location.reload(), 4000);
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  document.getElementById('btn-capa')?.addEventListener('click', async () => {
    setStatus('Gerando capa…');
    try {
      await postJson('/api/clips/' + cfg.id + '/capa', {
        titulo: capaTituloEl ? capaTituloEl.value.trim() : '',
      });
      setStatus('Capa enfileirada — atualizando…');
      setTimeout(() => location.reload(), 5000);
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  document.getElementById('btn-remover-capa')?.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/clips/' + cfg.id + '/capa', { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Falha ao remover capa');
      location.reload();
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  const modal = document.getElementById('publish-modal');
  const spin = document.getElementById('publish-spin');
  const ok = document.getElementById('publish-ok');
  const title = document.getElementById('publish-title');
  const text = document.getElementById('publish-text');
  const link = document.getElementById('publish-link');

  function showModal() {
    modal?.classList.remove('hidden');
    spin?.classList.remove('hidden');
    ok?.classList.add('hidden');
    ok?.classList.remove('flex');
    if (title) title.textContent = 'Publicando…';
    if (text) text.textContent = 'Enviando o Reel para o Facebook.';
    link?.classList.add('hidden');
  }

  function modalDone(msg, href) {
    spin?.classList.add('hidden');
    ok?.classList.remove('hidden');
    ok?.classList.add('flex');
    if (title) title.textContent = 'Enviado!';
    if (text) text.textContent = msg || 'Publicação enfileirada.';
    if (link) {
      link.classList.remove('hidden');
      if (href) link.href = href;
    }
  }

  function modalError(msg) {
    spin?.classList.add('hidden');
    if (title) title.textContent = 'Erro';
    if (text) text.textContent = msg;
    link?.classList.remove('hidden');
  }

  document.getElementById('btn-publicar')?.addEventListener('click', async () => {
    const legenda = String(materiaEl?.value || '').trim();
    if (!legenda) {
      setStatus('Gere ou escreva a matéria antes de publicar.', true);
      return;
    }
    if (!pageSelect?.value) {
      setStatus('Escolha uma Página do Facebook.', true);
      return;
    }

    showModal();
    try {
      const res = await fetch('/api/clips/' + cfg.id + '/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          facebook_page_id: Number(pageSelect.value),
          legenda,
          modo: modoEl?.value || 'reel',
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Falha ao publicar');
      modalDone(data.message || 'Reel enviado. Pode demorar alguns minutos no Facebook.', '/fila');
      if (videoEl && data.pendingConfirmation) {
        /* ok */
      }
    } catch (err) {
      modalError(err.message);
      setStatus(err.message, true);
    }
  });

  loadPages();

  // Auto-refresh enquanto matéria/capa geram
  if (cfg.materiaStatus === 'gerando' || cfg.capaStatus === 'gerando') {
    setStatus('Aguarde: gerando conteúdo…');
    setTimeout(() => location.reload(), 5000);
  }
})();
