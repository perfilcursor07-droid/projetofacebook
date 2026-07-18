(function () {
  const form = document.getElementById('bib-form');
  const msg = document.getElementById('bib-form-msg');
  const busy = document.getElementById('bib-busy');
  const busyText = document.getElementById('bib-busy-text');
  const fonteApp = document.getElementById('biblioteca-fonte-app');
  const fonteId = fonteApp?.dataset?.fonteId ? Number(fonteApp.dataset.fonteId) : null;

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

  function recommendationPageId() {
    const el = document.getElementById('bib-melhores-page');
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

  const autoForm = document.getElementById('bib-auto-form');
  const autoMsg = document.getElementById('bib-auto-msg');
  if (autoForm) {
    autoForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const ativo = Boolean(document.getElementById('bib-auto-ativo')?.checked);
      const page = document.getElementById('bib-auto-page')?.value || '';
      const posts = Number(document.getElementById('bib-auto-posts')?.value || 1);
      const intervalo = Number(document.getElementById('bib-auto-intervalo')?.value || 30);
      if (ativo && !page) {
        if (autoMsg) {
          autoMsg.textContent = 'Selecione a Página do Facebook para ativar o piloto.';
          autoMsg.className = 'mt-2 text-sm text-rose-300 sm:col-span-2 lg:col-span-12';
          autoMsg.classList.remove('hidden');
        }
        return;
      }
      try {
        setBusy(true, 'Salvando piloto automático…');
        await api('/api/biblioteca/autopilot', {
          method: 'PUT',
          body: JSON.stringify({
            ativo,
            facebook_page_id: page || null,
            posts_por_ciclo: posts,
            intervalo_minutos: intervalo,
          }),
        });
        location.reload();
      } catch (err) {
        if (autoMsg) {
          autoMsg.textContent = err.message;
          autoMsg.className = 'mt-2 text-sm text-rose-300 sm:col-span-2 lg:col-span-12';
          autoMsg.classList.remove('hidden');
        } else {
          alert(err.message);
        }
      } finally {
        setBusy(false);
      }
    });
  }

  document.getElementById('bib-fontes')?.addEventListener('click', async (e) => {
    const scan = e.target.closest('.bib-scan');
    const toggle = e.target.closest('.bib-toggle-mon');
    const del = e.target.closest('.bib-del');

    try {
      if (scan) {
        e.preventDefault();
        setBusy(true, 'Escaneando fonte…');
        const data = await api(`/api/biblioteca/fontes/${scan.dataset.id}/escanear`, {
          method: 'POST',
          body: '{}',
        });
        const n = data.novos?.length || 0;
        const t = data.itens || 0;
        alert(
          t
            ? `Encontrados ${t} item(ns), ${n} novo(s) salvos. Abra a fonte para ver os posts.`
            : 'Nenhum item encontrado nesta fonte.'
        );
        location.href = `/biblioteca/fontes/${scan.dataset.id}`;
        return;
      }
      if (toggle) {
        e.preventDefault();
        const on = toggle.dataset.on === '1';
        await api(`/api/biblioteca/fontes/${toggle.dataset.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ monitorar: !on }),
        });
        location.reload();
        return;
      }
      if (del) {
        e.preventDefault();
        if (!confirm('Excluir esta fonte e seus posts/alertas?')) return;
        await api(`/api/biblioteca/fontes/${del.dataset.id}`, { method: 'DELETE' });
        location.reload();
      }
    } catch (err) {
      alert(err.message);
    } finally {
      setBusy(false);
    }
  });

  // Página da fonte
  document.getElementById('bib-fonte-scan')?.addEventListener('click', async () => {
    if (!fonteId) return;
    try {
      setBusy(true, 'Escaneando fonte…');
      const data = await api(`/api/biblioteca/fontes/${fonteId}/escanear`, {
        method: 'POST',
        body: '{}',
      });
      const n = data.novos?.length || 0;
      const t = data.itens || 0;
      alert(t ? `Encontrados ${t} item(ns), ${n} novo(s) salvos.` : 'Nenhum item encontrado nesta fonte.');
      location.reload();
    } catch (err) {
      alert(err.message);
    } finally {
      setBusy(false);
    }
  });

  document.getElementById('bib-fonte-toggle-mon')?.addEventListener('click', async () => {
    if (!fonteId) return;
    const btn = document.getElementById('bib-fonte-toggle-mon');
    try {
      const on = btn?.dataset.on === '1';
      await api(`/api/biblioteca/fontes/${fonteId}`, {
        method: 'PATCH',
        body: JSON.stringify({ monitorar: !on }),
      });
      location.reload();
    } catch (err) {
      alert(err.message);
    }
  });

  async function gerarTexto(id, { tipo = 'texto', facebookPageId = pageId() } = {}) {
    setBusy(true, tipo === 'foto' ? 'IA preparando matéria e capa…' : 'IA gerando texto…');
    try {
      const data = await api(`/api/biblioteca/posts/${id}/gerar-texto`, {
        method: 'POST',
        body: JSON.stringify({
          facebook_page_id: facebookPageId,
          tipoPublicacao: tipo,
        }),
      });
      if (data.redirect) location.href = data.redirect;
      else location.href = '/minhas-materias';
    } catch (err) {
      alert(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function gerarVideo(id, facebookPageId = recommendationPageId() || pageId()) {
    setBusy(true, 'Baixando e preparando o Reel…');
    try {
      const data = await api(`/api/biblioteca/posts/${id}/gerar-video`, {
        method: 'POST',
        body: JSON.stringify({ facebook_page_id: facebookPageId }),
      });
      if (data.redirect) location.href = data.redirect;
      else location.href = '/fila';
    } catch (err) {
      alert(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function publicarMelhor(id, mediaType) {
    const destinationPage = recommendationPageId();
    if (!destinationPage) {
      alert('Selecione a Página do Facebook no topo de “Melhores para publicar”.');
      document.getElementById('bib-melhores-page')?.focus();
      return;
    }

    const isVideo = mediaType === 'video';
    const confirmation = isVideo
      ? 'Processar este Reel e publicar automaticamente quando vídeo, transcrição, matéria e capa estiverem prontos?'
      : 'Gerar a matéria e a capa e publicar agora na Página do Facebook selecionada?';
    if (!confirm(confirmation)) return;

    try {
      setBusy(
        true,
        isVideo
          ? 'Preparando Reel para publicação automática…'
          : 'IA gerando matéria, capa e publicando…'
      );
      const data = await api(`/api/biblioteca/posts/${id}/publicar`, {
        method: 'POST',
        body: JSON.stringify({ facebook_page_id: destinationPage }),
      });
      const warnings = Array.isArray(data.avisos) && data.avisos.length
        ? `\n\nAvisos: ${data.avisos.join(' ')}`
        : '';
      alert(`${data.message || (data.published ? 'Publicado com sucesso.' : 'Processamento iniciado.')}${warnings}`);
      location.reload();
    } catch (err) {
      alert(err.message);
    } finally {
      setBusy(false);
    }
  }

  document.body.addEventListener('click', (e) => {
    const publicar = e.target.closest('.bib-publicar-melhor');
    const preparar = e.target.closest('.bib-preparar-melhor');
    const t = e.target.closest('.bib-gen-texto');
    const v = e.target.closest('.bib-gen-video');
    if (publicar) {
      publicarMelhor(publicar.dataset.id, publicar.dataset.media);
      return;
    }
    if (preparar) {
      const id = preparar.dataset.id;
      const destinationPage = recommendationPageId();
      if (preparar.dataset.media === 'video') gerarVideo(id, destinationPage);
      else gerarTexto(id, { tipo: 'foto', facebookPageId: destinationPage });
      return;
    }
    if (t) gerarTexto(t.dataset.id);
    if (v) gerarVideo(v.dataset.id);
  });

  document.getElementById('bib-analisar-melhores')?.addEventListener('click', async () => {
    try {
      setBusy(true, 'IA analisando conteúdos de todas as fontes…');
      const data = await api('/api/biblioteca/melhores/analisar', {
        method: 'POST',
        body: JSON.stringify({ limit: 5 }),
      });
      if (!data.melhores?.length) {
        alert('Nenhum conteúdo pendente encontrado. Escaneie suas fontes primeiro.');
      }
      location.reload();
    } catch (err) {
      alert(err.message);
    } finally {
      setBusy(false);
    }
  });

  document.getElementById('bib-mark-all')?.addEventListener('click', async () => {
    try {
      await api('/api/biblioteca/alertas/lidos', { method: 'POST', body: '{}' });
      location.reload();
    } catch (err) {
      alert(err.message);
    }
  });

  document.querySelectorAll('a[href="#bib-secao-alertas"], #bib-btn-alertas').forEach((el) => {
    el.addEventListener('click', (e) => {
      const target = document.getElementById('bib-secao-alertas');
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
})();
