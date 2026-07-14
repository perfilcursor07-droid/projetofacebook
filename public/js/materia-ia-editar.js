(function initMatterEdit() {
  const cfg = window.__MATTER_EDIT__;
  if (!cfg?.id) return;

  const statusEl = document.getElementById('matter-status');
  const pageSelect = document.getElementById('matter-page');
  const tituloEl = document.getElementById('matter-titulo');
  const materiaEl = document.getElementById('matter-materia');
  const tipoEl = document.getElementById('matter-tipo');
  const imgEl = document.getElementById('matter-img');
  const imgWrap = document.getElementById('matter-img-wrap');

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
      pageSelect.innerHTML = pages
        .map((p) => {
          const selected = Number(p.id) === Number(cfg.pageId) ? ' selected' : '';
          return `<option value="${p.id}"${selected}>${escapeHtml(p.page_name)}</option>`;
        })
        .join('');
    } catch {
      pageSelect.innerHTML = '<option value="">Erro ao carregar páginas</option>';
    }
  }

  async function salvar() {
    const res = await fetch('/api/materias-ia/matters/' + cfg.id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        titulo: tituloEl.value,
        materia: materiaEl.value,
        tipoPublicacao: tipoEl.value,
        facebookPageId: pageSelect.value ? Number(pageSelect.value) : null,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Falha ao salvar');
    if (data.imagemUrl && imgEl) {
      imgEl.src = data.imagemUrl + (data.imagemUrl.includes('?') ? '&' : '?') + 't=' + Date.now();
      imgWrap?.classList.remove('hidden');
    }
    if (data.aviso) setStatus(data.aviso);
    else setStatus('Alterações salvas ✓');
    return data;
  }

  document.getElementById('btn-salvar')?.addEventListener('click', async () => {
    setStatus('Salvando…');
    try {
      await salvar();
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  document.getElementById('btn-publicar')?.addEventListener('click', async () => {
    if (!pageSelect.value) {
      setStatus('Selecione a Página do Facebook', true);
      return;
    }
    setStatus('Salvando e publicando…');
    try {
      await salvar();
      const res = await fetch('/api/materias-ia/matters/' + cfg.id + '/publicar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          facebookPageId: Number(pageSelect.value),
          tipoPublicacao: tipoEl.value,
          titulo: tituloEl.value,
          materia: materiaEl.value,
          sync: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Falha ao publicar');
      if (data.imagemUrl && imgEl) {
        imgEl.src = data.imagemUrl + (data.imagemUrl.includes('?') ? '&' : '?') + 't=' + Date.now();
        imgWrap?.classList.remove('hidden');
      }
      if (data.link) {
        statusEl.innerHTML =
          'Publicado ✓ <a class="text-sky-400 hover:underline" href="' +
          escapeHtml(data.link) +
          '" target="_blank" rel="noopener">Ver post</a>';
        statusEl.className = 'mt-4 text-sm text-emerald-300';
        setTimeout(() => window.location.reload(), 1200);
      } else {
        setStatus('Na fila de publicação ✓');
      }
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  document.getElementById('btn-agendar')?.addEventListener('click', async () => {
    const runAt = document.getElementById('matter-schedule')?.value;
    if (!runAt) {
      setStatus('Escolha data e hora', true);
      return;
    }
    setStatus('Salvando e agendando…');
    try {
      const res = await fetch('/api/materias-ia/matters/' + cfg.id + '/agendar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          run_at: new Date(runAt).toISOString(),
          titulo: tituloEl.value,
          materia: materiaEl.value,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Falha ao agendar');
      setStatus('Agendada ✓');
      setTimeout(() => window.location.reload(), 800);
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  loadPages();
})();
