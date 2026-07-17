(function () {
  const form = document.getElementById('bib-form');
  const msg = document.getElementById('bib-form-msg');
  const busy = document.getElementById('bib-busy');
  const busyText = document.getElementById('bib-busy-text');

  function setBusy(on, text) {
    if (!busy) return;
    busy.classList.toggle('hidden', !on);
    if (busyText && text) busyText.textContent = text;
  }

  function showMsg(text, ok) {
    if (!msg) return;
    msg.textContent = text;
    msg.className = `mt-2 text-sm ${ok ? 'text-emerald-300' : 'text-rose-300'}`;
    msg.classList.remove('hidden');
  }

  async function api(url, opts = {}) {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      ...opts,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || data.message || `Erro ${res.status}`);
    return data;
  }

  function pageId() {
    const el = document.getElementById('bib-page');
    return el && el.value ? Number(el.value) : null;
  }

  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        setBusy(true, 'Salvando fonte…');
        await api('/api/biblioteca/fontes', {
          method: 'POST',
          body: JSON.stringify({
            url: document.getElementById('bib-url').value,
            nome: document.getElementById('bib-nome').value || null,
            facebook_page_id: pageId(),
            monitorar: document.getElementById('bib-monitorar').checked,
            intervalo_minutos: 60,
          }),
        });
        location.reload();
      } catch (err) {
        showMsg(err.message, false);
      } finally {
        setBusy(false);
      }
    });
  }

  document.getElementById('bib-fontes')?.addEventListener('click', async (e) => {
    const scan = e.target.closest('.bib-scan');
    const toggle = e.target.closest('.bib-toggle-mon');
    const del = e.target.closest('.bib-del');
    const postsBtn = e.target.closest('.bib-posts-btn');

    try {
      if (scan) {
        setBusy(true, 'Escaneando fonte…');
        const data = await api(`/api/biblioteca/fontes/${scan.dataset.id}/escanear`, { method: 'POST', body: '{}' });
        const n = data.novos?.length || 0;
        const t = data.itens || 0;
        alert(
          t
            ? `Encontrados ${t} item(ns), ${n} novo(s) salvos. Abra “Ver posts” para gerar matéria.`
            : 'Nenhum item encontrado nesta fonte.'
        );
        location.reload();
      }
      if (toggle) {
        const on = toggle.dataset.on === '1';
        await api(`/api/biblioteca/fontes/${toggle.dataset.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ monitorar: !on }),
        });
        location.reload();
      }
      if (del) {
        if (!confirm('Excluir esta fonte e seus posts/alertas?')) return;
        await api(`/api/biblioteca/fontes/${del.dataset.id}`, { method: 'DELETE' });
        location.reload();
      }
      if (postsBtn) {
        const box = document.querySelector(`.bib-posts-box[data-fonte="${postsBtn.dataset.id}"]`);
        if (!box) return;
        if (!box.classList.contains('hidden') && box.dataset.loaded === '1') {
          box.classList.add('hidden');
          return;
        }
        setBusy(true, 'Carregando posts…');
        const data = await api(`/api/biblioteca/fontes/${postsBtn.dataset.id}/posts`);
        box.innerHTML = (data.posts || [])
          .map(
            (p) => `
          <div class="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
            <p class="text-sm text-slate-200">${escapeHtml(p.titulo || 'Sem título')}</p>
            <div class="mt-2 flex flex-wrap gap-2">
              <button type="button" class="bib-gen-texto rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-300" data-id="${p.id}">Gerar texto</button>
              <button type="button" class="bib-gen-video rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-300" data-id="${p.id}">Gerar vídeo</button>
              <a href="${escapeAttr(p.url)}" target="_blank" rel="noopener" class="rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-400">Abrir</a>
            </div>
          </div>`
          )
          .join('') || '<p class="text-xs text-slate-500">Nenhum post nesta fonte.</p>';
        box.dataset.loaded = '1';
        box.classList.remove('hidden');
      }
    } catch (err) {
      alert(err.message);
    } finally {
      setBusy(false);
    }
  });

  async function gerarTexto(id) {
    setBusy(true, 'IA gerando texto…');
    try {
      const data = await api(`/api/biblioteca/posts/${id}/gerar-texto`, {
        method: 'POST',
        body: JSON.stringify({ facebook_page_id: pageId(), tipoPublicacao: 'texto' }),
      });
      if (data.redirect) location.href = data.redirect;
      else location.href = '/minhas-materias';
    } catch (err) {
      alert(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function gerarVideo(id) {
    setBusy(true, 'Enfileirando vídeo…');
    try {
      const data = await api(`/api/biblioteca/posts/${id}/gerar-video`, {
        method: 'POST',
        body: '{}',
      });
      if (data.redirect) location.href = data.redirect;
      else location.href = '/fila';
    } catch (err) {
      alert(err.message);
    } finally {
      setBusy(false);
    }
  }

  document.body.addEventListener('click', (e) => {
    const t = e.target.closest('.bib-gen-texto');
    const v = e.target.closest('.bib-gen-video');
    if (t) gerarTexto(t.dataset.id);
    if (v) gerarVideo(v.dataset.id);
  });

  document.getElementById('bib-mark-all')?.addEventListener('click', async () => {
    try {
      await api('/api/biblioteca/alertas/lidos', { method: 'POST', body: '{}' });
      location.reload();
    } catch (err) {
      alert(err.message);
    }
  });

  document.getElementById('bib-btn-alertas')?.addEventListener('click', () => {
    document.getElementById('bib-alertas')?.scrollIntoView({ behavior: 'smooth' });
  });

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, '&#39;');
  }
})();
