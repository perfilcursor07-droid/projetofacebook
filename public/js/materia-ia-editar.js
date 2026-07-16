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

    const publishBtn = document.getElementById('btn-publicar');
    const isRepublish = Boolean(cfg.canRepublish || publishBtn?.dataset.republicar === '1');
    if (isRepublish) {
      const ok = window.confirm(
        'Republicar esta matéria? Será criado um novo post na Página (o post antigo permanece).'
      );
      if (!ok) return;
    }

    if (publishBtn) publishBtn.disabled = true;

    showPublishModal('publishing');
    setStatus(isRepublish ? 'Republicando…' : 'Salvando e publicando…');

    try {
      if (cfg.canEdit) await salvar();
      const res = await fetch('/api/materias-ia/matters/' + cfg.id + '/publicar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          facebookPageId: Number(pageSelect.value),
          tipoPublicacao: tipoEl.value,
          titulo: tituloEl.value,
          materia: materiaEl.value,
          sync: true,
          forcar: true,
          republicar: isRepublish,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Falha ao publicar');

      if (data.imagemUrl && imgEl) {
        imgEl.src = data.imagemUrl + (data.imagemUrl.includes('?') ? '&' : '?') + 't=' + Date.now();
        imgWrap?.classList.remove('hidden');
      }

      showPublishModal('success', data.link || null);
      setStatus(isRepublish ? 'Republicada com sucesso ✓' : 'Publicado com sucesso ✓');
      setTimeout(() => {
        window.location.href = cfg.listUrl || '/minhas-materias';
      }, 1800);
    } catch (err) {
      hidePublishModal();
      setStatus(err.message, true);
      if (publishBtn) publishBtn.disabled = false;
    }
  });

  function showPublishModal(state, link) {
    const modal = document.getElementById('publish-modal');
    const spin = document.getElementById('publish-modal-spin');
    const ok = document.getElementById('publish-modal-ok');
    const title = document.getElementById('publish-modal-title');
    const text = document.getElementById('publish-modal-text');
    const linkEl = document.getElementById('publish-modal-link');
    if (!modal) return;

    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';

    if (state === 'success') {
      spin?.classList.add('hidden');
      ok?.classList.remove('hidden');
      ok?.classList.add('flex');
      if (title) title.textContent = cfg.canRepublish ? 'Republicada com sucesso' : 'Publicado com sucesso';
      if (text) {
        text.textContent = cfg.canRepublish
          ? 'Um novo post foi enviado para a Página. Voltando para a lista…'
          : 'A matéria foi enviada para a Página. Voltando para a lista…';
      }
      if (linkEl && link) {
        linkEl.href = link;
        linkEl.classList.remove('hidden');
      } else if (linkEl) {
        linkEl.classList.add('hidden');
      }
      return;
    }

    spin?.classList.remove('hidden');
    ok?.classList.add('hidden');
    ok?.classList.remove('flex');
    if (title) title.textContent = 'Publicando…';
    if (text) text.textContent = 'Enviando a matéria para a Página do Facebook.';
    if (linkEl) linkEl.classList.add('hidden');
  }

  function hidePublishModal() {
    const modal = document.getElementById('publish-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    document.body.style.overflow = '';
  }

  document.getElementById('btn-agendar')?.addEventListener('click', async () => {
    const runAt = document.getElementById('matter-schedule')?.value;
    if (!runAt) {
      setStatus('Escolha data e hora', true);
      return;
    }
    setStatus('Salvando e agendando…');
    try {
      // Envia o valor do datetime-local; o servidor interpreta como Araguaína (UTC−3)
      const res = await fetch('/api/materias-ia/matters/' + cfg.id + '/agendar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          run_at: runAt,
          titulo: tituloEl.value,
          materia: materiaEl.value,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Falha ao agendar');
      setStatus('Agendada ✓ (horário de Araguaína)');
      setTimeout(() => window.location.reload(), 800);
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  const imageInput = document.getElementById('matter-image-input');
  const imagePreviewWrap = document.getElementById('matter-image-preview-wrap');
  const imagePreview = document.getElementById('matter-image-preview');
  const confirmImageButton = document.getElementById('btn-confirmar-imagem');
  const cancelImageButton = document.getElementById('btn-cancelar-imagem');
  let previewObjectUrl = null;

  function releaseImagePreview() {
    if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = null;
  }

  function clearImageSelection() {
    releaseImagePreview();
    if (imageInput) imageInput.value = '';
    if (imagePreview) imagePreview.removeAttribute('src');
    imagePreviewWrap?.classList.add('hidden');
  }

  imageInput?.addEventListener('change', () => {
    releaseImagePreview();
    const file = imageInput.files?.[0];
    if (!file) {
      clearImageSelection();
      return;
    }
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      clearImageSelection();
      setStatus('Escolha uma imagem PNG, JPG ou WebP', true);
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      clearImageSelection();
      setStatus('A imagem deve ter no máximo 12 MB', true);
      return;
    }

    previewObjectUrl = URL.createObjectURL(file);
    imagePreview.src = previewObjectUrl;
    imagePreviewWrap?.classList.remove('hidden');
    setStatus('Confira a imagem e confirme para aplicar sua marca.');
  });

  cancelImageButton?.addEventListener('click', () => {
    clearImageSelection();
    setStatus('Troca de imagem cancelada.');
  });

  confirmImageButton?.addEventListener('click', async () => {
    const file = imageInput?.files?.[0];
    if (!file) {
      setStatus('Escolha uma imagem para continuar', true);
      return;
    }

    const originalLabel = confirmImageButton.textContent;
    confirmImageButton.disabled = true;
    confirmImageButton.textContent = 'Aplicando marca…';
    setStatus('Gerando a nova arte com sua marca…');

    try {
      const formData = new FormData();
      formData.append('imagem', file);
      formData.append('titulo', tituloEl.value);
      const res = await fetch('/api/materias-ia/matters/' + cfg.id + '/arte', {
        method: 'POST',
        body: formData,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Falha ao trocar a imagem');

      if (data.imagemUrl && imgEl) {
        imgEl.src = data.imagemUrl + (data.imagemUrl.includes('?') ? '&' : '?') + 't=' + Date.now();
        imgWrap?.classList.remove('hidden');
      }
      clearImageSelection();
      setStatus(
        data.hasLogo
          ? 'Nova imagem confirmada e marca aplicada ✓'
          : 'Nova imagem confirmada com sua identidade visual (sem logomarca cadastrada) ✓'
      );
    } catch (err) {
      setStatus(err.message, true);
    } finally {
      confirmImageButton.disabled = false;
      confirmImageButton.textContent = originalLabel;
    }
  });

  const reloadBrandButton = document.getElementById('btn-recarregar-marca');
  reloadBrandButton?.addEventListener('click', async () => {
    const originalLabel = reloadBrandButton.textContent;
    reloadBrandButton.disabled = true;
    reloadBrandButton.textContent = 'Recarregando modelo…';
    setStatus('Aplicando o modelo atual da sua marca…');

    try {
      const res = await fetch('/api/materias-ia/matters/' + cfg.id + '/arte/regenerar', {
        method: 'POST',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Falha ao recarregar o modelo da marca');

      if (data.imagemUrl && imgEl) {
        imgEl.src = data.imagemUrl + (data.imagemUrl.includes('?') ? '&' : '?') + 't=' + Date.now();
        imgWrap?.classList.remove('hidden');
      }
      setStatus('Modelo, logo e cores atuais aplicados à arte ✓');
    } catch (err) {
      setStatus(err.message, true);
    } finally {
      reloadBrandButton.disabled = false;
      reloadBrandButton.textContent = originalLabel;
    }
  });

  window.addEventListener('beforeunload', releaseImagePreview);
  loadPages();
})();
