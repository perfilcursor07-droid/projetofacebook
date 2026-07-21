(function initMatterEdit() {
  const cfg = window.__MATTER_EDIT__;
  if (!cfg?.id) return;

  const statusEl = document.getElementById('matter-status');
  const pageSelect = document.getElementById('matter-page');
  const tituloEl = document.getElementById('matter-titulo');
  const materiaEl = document.getElementById('matter-materia');
  const fonteCreditoEl = document.getElementById('matter-fonte-credito');
  const tipoEl = document.getElementById('matter-tipo');
  const imgEl = document.getElementById('matter-img');
  const imgWrap = document.getElementById('matter-img-wrap');
  const btnBaixarArte = document.getElementById('btn-baixar-arte');
  const btnCopiarLegenda = document.getElementById('btn-copiar-legenda');

  function setStatus(msg, isError) {
    if (!statusEl) return;
    statusEl.textContent = msg || '';
    statusEl.className =
      'mb-2 text-sm ' +
      (msg ? '' : 'hidden ') +
      (isError ? 'text-rose-300' : 'text-slate-400');
  }

  function syncDownloadArtLink(url) {
    if (!btnBaixarArte) return;
    if (!url) {
      btnBaixarArte.classList.add('hidden');
      btnBaixarArte.removeAttribute('href');
      return;
    }
    btnBaixarArte.href = url;
    btnBaixarArte.setAttribute('download', 'arte-materia-' + cfg.id + '.jpg');
    btnBaixarArte.classList.remove('hidden');
  }

  function setArtImage(url) {
    if (!imgEl || !url) return;
    const withCache = url + (url.includes('?') ? '&' : '?') + 't=' + Date.now();
    imgEl.src = withCache;
    if (imgWrap) imgWrap.classList.remove('hidden');
    syncDownloadArtLink(withCache);
  }

  function montarLegendaCompleta() {
    const titulo = String(tituloEl?.value || '').trim();
    const materia = String(materiaEl?.value || '').trim();
    const credito = String(fonteCreditoEl?.value || '').trim();
    const tags = String(document.getElementById('matter-hashtags-line')?.textContent || '').trim();
    const parts = [];
    if (titulo) parts.push(titulo);
    if (materia) {
      // Evita duplicar o título no início do corpo
      let body = materia;
      if (titulo && body.toLowerCase().startsWith(titulo.toLowerCase())) {
        body = body.slice(titulo.length).replace(/^[\s:—\-–.]+/, '').trim();
      }
      if (body) parts.push(body);
    }
    if (credito) parts.push(credito);
    if (tags) parts.push(tags);
    return parts.join('\n\n').trim();
  }

  async function copiarLegenda() {
    const texto = montarLegendaCompleta();
    if (!texto) {
      setStatus('Não há legenda para copiar.', true);
      return;
    }
    try {
      await navigator.clipboard.writeText(texto);
      const prev = btnCopiarLegenda?.textContent;
      if (btnCopiarLegenda) btnCopiarLegenda.textContent = 'Copiado ✓';
      setStatus('Legenda completa copiada (com fonte) ✓');
      setTimeout(() => {
        if (btnCopiarLegenda && prev) btnCopiarLegenda.textContent = prev;
      }, 1600);
    } catch {
      // fallback
      materiaEl.focus();
      materiaEl.select();
      try {
        document.execCommand('copy');
        setStatus('Legenda copiada ✓');
      } catch {
        setStatus('Não foi possível copiar. Selecione o texto manualmente.', true);
      }
    }
  }

  async function baixarArte(e) {
    if (e) e.preventDefault();
    const url = imgEl?.currentSrc || imgEl?.src || btnBaixarArte?.getAttribute('href');
    if (!url || url === '#' || url.endsWith('/#')) {
      setStatus('Nenhuma arte disponível para baixar.', true);
      return;
    }
    try {
      setStatus('Preparando download da arte…');
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Falha ao baixar (' + res.status + ')');
      const blob = await res.blob();
      const ext = (blob.type || '').includes('png') ? 'png' : 'jpg';
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = 'arte-materia-' + cfg.id + '.' + ext;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
      setStatus('Download da arte iniciado ✓');
    } catch (err) {
      // fallback: abre em nova aba
      window.open(url, '_blank', 'noopener');
      setStatus(err.message || 'Abra a imagem e salve manualmente.', true);
    }
  }

  btnCopiarLegenda?.addEventListener('click', (e) => {
    e.preventDefault();
    copiarLegenda();
  });
  btnBaixarArte?.addEventListener('click', baixarArte);
  if (imgEl?.src) syncDownloadArtLink(imgEl.src);

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function loadPages() {
    const selects = [
      pageSelect,
      document.getElementById('matter-nova-link-page'),
    ].filter(Boolean);
    if (!selects.length) return;
    try {
      const res = await fetch('/api/facebook/pages');
      const data = await res.json();
      const pages = data.pages || [];
      const defaultId =
        Number(data.default_facebook_page_id) ||
        Number(pages.find((p) => p.is_default)?.id) ||
        null;

      // Na publicação da matéria: só a página padrão do perfil (/paginas)
      let page = defaultId
        ? pages.find((p) => Number(p.id) === Number(defaultId))
        : null;

      // Fallback: página já salva na matéria, se não houver padrão definida
      if (!page && cfg.pageId) {
        page = pages.find((p) => Number(p.id) === Number(cfg.pageId)) || null;
      }

      let html;
      if (!pages.length) {
        html = '<option value="">Conecte uma página em /paginas</option>';
      } else if (!page) {
        html =
          '<option value="">Defina a página padrão em /paginas</option>';
      } else {
        const tag = page.is_default || Number(page.id) === Number(defaultId) ? ' · padrão' : '';
        html = `<option value="${page.id}" selected>${escapeHtml(page.page_name)}${tag}</option>`;
      }

      selects.forEach((el) => {
        el.innerHTML = html;
        // Uma única opção: trava troca acidental
        if (page) el.disabled = true;
        else el.disabled = false;
      });
    } catch {
      selects.forEach((el) => {
        el.innerHTML = '<option value="">Erro ao carregar páginas</option>';
        el.disabled = false;
      });
    }
  }

  async function salvar() {
    const res = await fetch('/api/materias-ia/matters/' + cfg.id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        titulo: tituloEl.value,
        materia: materiaEl.value,
        fonteCredito: fonteCreditoEl ? fonteCreditoEl.value : undefined,
        tipoPublicacao: tipoEl.value,
        facebookPageId: pageSelect.value ? Number(pageSelect.value) : null,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Falha ao salvar');
    if (data.imagemUrl && imgEl) {
      setArtImage(data.imagemUrl);
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

  const tituloSugestoes = [];
  document.getElementById('btn-sugerir-titulo')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-sugerir-titulo');
    const tomEl = document.getElementById('matter-titulo-tom');
    const original = btn?.textContent;
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Gerando título…';
    }
    setStatus('A IA está sugerindo outro título…');
    try {
      const res = await fetch('/api/materias-ia/matters/' + cfg.id + '/sugerir-titulo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tom: tomEl?.value || 'natural',
          evitar: tituloSugestoes.slice(-8),
          tituloAtual: String(tituloEl?.value || '').trim(),
          materia: String(materiaEl?.value || '').trim(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Falha ao sugerir título');

      if (data.titulo && tituloEl) {
        tituloEl.value = data.titulo;
        tituloSugestoes.push(data.titulo);
      }
      if (data.imagemUrl && imgEl) {
        setArtImage(data.imagemUrl);
        imgWrap?.classList.remove('hidden');
      }
      const reelVideo = document.getElementById('matter-reel-video');
      if (data.videoUrl && reelVideo) {
        reelVideo.src = data.videoUrl + (data.videoUrl.includes('?') ? '&' : '?') + 't=' + Date.now();
        reelVideo.load();
      }
      setStatus(
        data.aviso ||
          (data.videoUrl
            ? 'Novo título aplicado e capa do Reel atualizada ✓'
            : data.imagemUrl
              ? 'Novo título aplicado e arte atualizada ✓'
              : 'Novo título aplicado ✓')
      );
    } catch (err) {
      setStatus(err.message, true);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = original || 'Sugerir outro título';
      }
    }
  });

  document.getElementById('btn-reescrever-info')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-reescrever-info');
    const infoEl = document.getElementById('matter-info-extra');
    const infoExtra = String(infoEl?.value || '').trim();
    if (!infoExtra) {
      setStatus('Cole as informações extras no campo antes de reescrever.', true);
      infoEl?.focus();
      return;
    }
    const original = btn?.textContent;
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Reescrevendo…';
    }
    setStatus('A IA está reforçando o texto com as informações incluídas…');
    try {
      const res = await fetch('/api/materias-ia/matters/' + cfg.id + '/reescrever-com-info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          infoExtra,
          titulo: tituloEl?.value || '',
          materia: materiaEl?.value || '',
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Falha ao reescrever o texto');

      if (data.titulo && tituloEl) tituloEl.value = data.titulo;
      if (data.materia && materiaEl) materiaEl.value = data.materia;

      const tagsLine = document.getElementById('matter-hashtags-line');
      const tagsWrap = document.getElementById('matter-hashtags-wrap');
      if (Array.isArray(data.hashtags) && data.hashtags.length && tagsLine) {
        tagsLine.textContent = data.hashtags
          .map((h) => '#' + String(h).replace(/^#/, ''))
          .join(' ');
        tagsWrap?.classList.remove('hidden');
        tagsLine.parentElement?.classList.remove('hidden');
      }

      if (data.imagemUrl && imgEl) {
        imgEl.src = data.imagemUrl + (data.imagemUrl.includes('?') ? '&' : '?') + 't=' + Date.now();
        imgWrap?.classList.remove('hidden');
      }
      const reelVideo = document.getElementById('matter-reel-video');
      if (data.videoUrl && reelVideo) {
        reelVideo.src = data.videoUrl + (data.videoUrl.includes('?') ? '&' : '?') + 't=' + Date.now();
        reelVideo.load();
      }

      setStatus(data.aviso || 'Texto reescrito com as informações incluídas ✓');
    } catch (err) {
      setStatus(err.message, true);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = original || 'Reescrever texto com informações incluídas';
      }
    }
  });

  document.getElementById('btn-enriquecer-fontes')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-enriquecer-fontes');
    const box = document.getElementById('matter-fontes-enriquecimento');
    const kwEl = document.getElementById('matter-enriquecer-keywords');
    const periodoEl = document.getElementById('matter-enriquecer-periodo');
    const original = btn?.textContent;
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Buscando…';
    }
    const keywords = String(kwEl?.value || '').trim() || String(tituloEl?.value || '').trim();
    setStatus('Buscando reportagens (Google News + Brave), como em Pautas com IA…');
    if (box) {
      box.classList.remove('hidden');
      box.innerHTML =
        '<span class="inline-block h-3 w-3 animate-spin rounded-full border-2 border-emerald-400/30 border-t-emerald-300 align-middle"></span> ' +
        'Consultando notícias com: <strong class="text-slate-300">' +
        keywords.replace(/</g, '&lt;') +
        '</strong>';
    }
    try {
      const res = await fetch('/api/materias-ia/matters/' + cfg.id + '/enriquecer-fontes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          titulo: tituloEl?.value || '',
          materia: materiaEl?.value || '',
          palavrasChave: keywords,
          periodo: periodoEl?.value || '180d',
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Falha ao enriquecer a matéria');

      if (data.titulo && tituloEl) tituloEl.value = data.titulo;
      if (data.materia && materiaEl) {
        materiaEl.value = data.materia;
        materiaEl.dispatchEvent(new Event('input'));
      }

      const tagsLine = document.getElementById('matter-hashtags-line');
      const tagsWrap = document.getElementById('matter-hashtags-wrap');
      if (Array.isArray(data.hashtags) && data.hashtags.length && tagsLine) {
        tagsLine.textContent = data.hashtags
          .map((h) => '#' + String(h).replace(/^#/, ''))
          .join(' ');
        tagsWrap?.classList.remove('hidden');
        tagsLine.parentElement?.classList.remove('hidden');
      }

      if (data.imagemUrl && imgEl) {
        imgEl.src = data.imagemUrl + (data.imagemUrl.includes('?') ? '&' : '?') + 't=' + Date.now();
        imgWrap?.classList.remove('hidden');
      }
      const reelVideo = document.getElementById('matter-reel-video');
      if (data.videoUrl && reelVideo) {
        reelVideo.src = data.videoUrl + (data.videoUrl.includes('?') ? '&' : '?') + 't=' + Date.now();
        reelVideo.load();
      }

      if (box) {
        const fontes = Array.isArray(data.fontes) ? data.fontes : [];
        const fatos = Array.isArray(data.fatosUsados) ? data.fatosUsados : [];
        const linhas = [];
        if (data.queryUsada) {
          linhas.push(
            '<span class="text-slate-500">Busca:</span> <span class="text-slate-300">' +
              String(data.queryUsada).replace(/</g, '&lt;') +
              '</span>'
          );
        }
        if (fontes.length) {
          linhas.push(
            '<span class="font-semibold text-slate-300">Fontes:</span> ' +
              fontes
                .map((f) => {
                  const nome = (f.veiculo || 'Web') + (f.titulo ? ' — ' + String(f.titulo).slice(0, 60) : '');
                  return f.url
                    ? '<a class="text-sky-400 hover:text-sky-300" href="' +
                        f.url +
                        '" target="_blank" rel="noopener">' +
                        String(nome).replace(/</g, '&lt;') +
                        '</a>'
                    : String(nome).replace(/</g, '&lt;');
                })
                .join('<br/>')
          );
        }
        if (fatos.length) {
          linhas.push(
            '<span class="font-semibold text-slate-300">Fatos usados:</span> ' +
              fatos.map((f) => String(f).replace(/</g, '&lt;')).join(' · ')
          );
        }
        box.innerHTML = linhas.join('<br/>') || 'Enriquecimento concluído.';
        box.classList.remove('hidden');
      }

      setStatus(data.aviso || 'Matéria enriquecida com fatos de outras fontes ✓');
    } catch (err) {
      setStatus(err.message, true);
      if (box) {
        box.textContent = err.message;
        box.classList.remove('hidden');
      }
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = original || 'Buscar e enriquecer';
      }
    }
  });

  document.getElementById('btn-publicar')?.addEventListener('click', async () => {
    if (!pageSelect.value) {
      setStatus('Defina a página padrão em /paginas antes de publicar', true);
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
    setStatus(
      cfg.isReel
        ? 'Publicando Reel (upload do vídeo pode levar 1–3 min)…'
        : isRepublish
          ? 'Republicando…'
          : 'Salvando e publicando…'
    );

    try {
      if (cfg.canEdit) await salvar();
      const res = await fetch('/api/materias-ia/matters/' + cfg.id + '/publicar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          facebookPageId: Number(pageSelect.value),
          tipoPublicacao: cfg.isReel ? 'reel' : tipoEl.value,
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
        setArtImage(data.imagemUrl);
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
    if (title) title.textContent = cfg.isReel ? 'Publicando Reel…' : 'Publicando…';
    if (text) {
      text.textContent = cfg.isReel
        ? 'Enviando o vídeo + capa e aguardando confirmação do Facebook. Pode levar até 3–4 minutos — não feche a página.'
        : 'Enviando a matéria para a Página do Facebook.';
    }
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
        setArtImage(data.imagemUrl);
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
        setArtImage(data.imagemUrl);
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

  function setSuggestLoading(on) {
    const box = document.getElementById('matter-img-suggest-loading');
    const strip = document.getElementById('matter-img-suggest-strip');
    const wrap = document.getElementById('matter-img-wrap');
    if (box) {
      box.classList.toggle('hidden', !on);
      box.classList.toggle('flex', on);
    }
    if (strip) {
      strip.style.opacity = on ? '0.45' : '';
      strip.style.pointerEvents = on ? 'none' : '';
    }
    if (wrap) {
      wrap.style.opacity = on ? '0.55' : '';
    }
  }

  async function aplicarImagemSugerida(chosen, el) {
    if (!chosen?.url) return;
    if (el) el.disabled = true;
    setSuggestLoading(true);
    setStatus('Aguarde, alterando a arte…');
    try {
      const r = await fetch('/api/materias-ia/matters/' + cfg.id + '/aplicar-imagem-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageUrl: chosen.url,
          titulo: tituloEl?.value || '',
          autor: chosen.autor || null,
          fonte: chosen.fonte || null,
          imagemTitulo: chosen.titulo || null,
          origem: chosen.origem || null,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'Falha ao aplicar imagem');
      if (j.imagemUrl && imgEl) {
        setArtImage(j.imagemUrl);
        imgWrap?.classList.remove('hidden');
      }
      const materiaEl = document.getElementById('matter-materia');
      if (materiaEl && j.matter?.materia) {
        materiaEl.value = j.matter.materia;
      }
      // Marca a miniatura escolhida como "Atual" sem buscar de novo na API
      const list = window.__IMG_SUGESTOES__ || [];
      const idx = Number(el?.dataset?.suggestIdx);
      list.forEach((img, i) => {
        if (img.origem === 'fonte') img.origem = img._origemAntes || 'google';
        if (i === idx) {
          img._origemAntes = img.origem;
          img.origem = 'fonte';
        }
      });
      if (window.__IMG_SUGESTOES_CACHE__) {
        window.__IMG_SUGESTOES_CACHE__.imagens = list;
        saveSuggestCache(window.__IMG_SUGESTOES_CACHE__);
      }
      renderSuggestStrip(window.__IMG_SUGESTOES_CACHE__ || { imagens: list });
      setStatus('Arte atualizada ✓');
    } catch (err) {
      setStatus(err.message, true);
      if (el) el.disabled = false;
    } finally {
      setSuggestLoading(false);
    }
  }

  const SUGGEST_CACHE_KEY = 'matter-img-suggest:' + cfg.id;

  function saveSuggestCache(data) {
    try {
      sessionStorage.setItem(
        SUGGEST_CACHE_KEY,
        JSON.stringify({
          aviso: data.aviso || null,
          pessoa: data.pessoa || null,
          motivo: data.motivo || null,
          imagens: data.imagens || [],
        })
      );
    } catch {
      /* ignore quota */
    }
  }

  function loadSuggestCache() {
    try {
      const raw = sessionStorage.getItem(SUGGEST_CACHE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data?.imagens?.length) return null;
      return data;
    } catch {
      return null;
    }
  }

  function renderSuggestStrip(data) {
    const strip = document.getElementById('matter-img-suggest-strip');
    const meta = document.getElementById('matter-img-suggest-meta');
    const imgs = data.imagens || [];
    window.__IMG_SUGESTOES__ = imgs;
    window.__IMG_SUGESTOES_CACHE__ = data;

    if (meta) {
      const parts = [];
      if (data.aviso) parts.push(data.aviso);
      if (data.pessoa) parts.push(data.pessoa);
      parts.push('Clique numa miniatura para trocar a arte');
      meta.textContent = parts.join(' · ');
    }

    if (!strip) return;
    if (!imgs.length) {
      strip.innerHTML = '<p class="text-[11px] text-slate-500">Nenhuma sugestão encontrada.</p>';
      return;
    }

    strip.innerHTML = imgs
      .map((img, i) => {
        const thumb = String(img.thumbnail || img.url || '').replace(/"/g, '&quot;');
        const isAtual = img.origem === 'fonte';
        const label =
          isAtual
            ? 'Post'
            : img.origem === 'serpapi'
              ? 'Google'
              : img.origem === 'brave'
                ? 'Brave'
                : img.origem === 'google'
                  ? 'Serper'
                  : img.origem || '';
        const border = isAtual ? 'border-emerald-400' : 'border-slate-700 hover:border-violet-400';
        return `<button type="button" data-suggest-idx="${i}" title="${String(img.titulo || '').replace(/"/g, '&quot;')}"
          class="relative shrink-0 overflow-hidden rounded-md border bg-slate-950 focus:outline-none focus:ring-1 focus:ring-violet-400 ${border}"
          style="width:48px;height:64px;padding:0;flex:0 0 48px">
          <img src="${thumb}" alt="" loading="lazy" decoding="async"
            style="width:100%;height:100%;object-fit:cover;display:block" />
          <span class="absolute bottom-0 left-0 right-0 bg-black/75 py-px text-center text-[8px] leading-tight text-slate-200">${label}</span>
        </button>`;
      })
      .join('');

    strip.querySelectorAll('[data-suggest-idx]').forEach((el) => {
      el.addEventListener('click', () => {
        const chosen = (window.__IMG_SUGESTOES__ || [])[Number(el.dataset.suggestIdx)];
        aplicarImagemSugerida(chosen, el);
      });
    });
  }

  async function carregarSugestoesImagem({ silent, force } = {}) {
    const meta = document.getElementById('matter-img-suggest-meta');
    const strip = document.getElementById('matter-img-suggest-strip');
    if (!cfg.canEdit || !strip) return;

    if (!force) {
      const cached = loadSuggestCache();
      if (cached) {
        renderSuggestStrip(cached);
        if (!silent) setStatus('Sugestões em cache — clique em “Buscar novas” para atualizar');
        return;
      }
    }

    if (!silent) setStatus('Buscando fotos relacionadas à matéria…');
    if (meta) meta.textContent = 'Buscando fotos relacionadas…';
    try {
      const res = await fetch('/api/materias-ia/matters/' + cfg.id + '/sugerir-imagens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Falha ao sugerir imagens');
      saveSuggestCache(data);
      renderSuggestStrip(data);
      if (!silent) {
        setStatus((data.imagens || []).length + ' sugestões — clique numa miniatura para trocar');
      }
    } catch (err) {
      if (meta) meta.textContent = err.message;
      if (strip) {
        strip.innerHTML = `<p class="text-[11px] text-rose-300">${String(err.message || '').replace(/</g, '')}</p>`;
      }
      if (!silent) setStatus(err.message, true);
    }
  }

  document.getElementById('btn-sugerir-imagens')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-sugerir-imagens');
    const original = btn?.textContent;
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Buscando…';
    }
    try {
      await carregarSugestoesImagem({ silent: false, force: true });
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = original || 'Buscar novas sugestões';
      }
    }
  });

  // Carrega miniaturas automaticamente ao abrir a edição (só foto)
  if (cfg.canEdit && !cfg.isReel) {
    carregarSugestoesImagem({ silent: true, force: false });
  }

  // Reel em processamento: atualiza a página quando vídeo/legenda ficarem prontos
  if (cfg.isReel && cfg.reelProcessing) {
    setStatus('Processando Reel (download → fala → legenda → capa)…');
    let tries = 0;
    const poll = async () => {
      tries += 1;
      if (tries > 90) {
        setStatus('Ainda processando. Atualize a página em instantes.', true);
        return;
      }
      try {
        const res = await fetch('/api/materias-ia/matters/' + cfg.id);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Falha ao consultar matéria');
        const m = data.matter;
        const ready =
          m?.video_path && m?.materia && !String(m.materia).startsWith('⏳');
        if (ready || (m?.video_path && tries > 3)) {
          window.location.reload();
          return;
        }
        if (m?.error_message && m?.status === 'erro' && !m.video_path) {
          setStatus(m.error_message, true);
          return;
        }
      } catch (err) {
        console.warn(err);
      }
      setTimeout(poll, 4000);
    };
    setTimeout(poll, 3000);
  }

  document.getElementById('btn-buscar-imagem-fonte')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-buscar-imagem-fonte');
    const original = btn?.textContent;
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Buscando na fonte…';
    }
    setStatus('Buscando a foto de capa na página da notícia…');
    try {
      const res = await fetch('/api/materias-ia/matters/' + cfg.id + '/buscar-imagem-fonte', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Não foi possível buscar a imagem da fonte');

      if (data.imagemUrl && imgEl) {
        setArtImage(data.imagemUrl);
        imgWrap?.classList.remove('hidden');
      }
      setStatus(data.aviso || 'Imagem da fonte aplicada e arte gerada ✓');
      // Recarrega para mostrar botão "Aplicar marca" e preview corretos
      setTimeout(() => window.location.reload(), 700);
    } catch (err) {
      setStatus(err.message, true);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = original || 'Buscar imagem da fonte';
      }
    }
  });

  // Limpar → começar outra matéria pelo link sem sair da tela
  const novaLinkPanel = document.getElementById('matter-nova-link');
  const editAtual = document.getElementById('matter-edit-atual');
  const novaLinkUrl = document.getElementById('matter-nova-link-url');
  const novaLinkStatus = document.getElementById('matter-nova-link-status');

  function mostrarModoNovaLink() {
    if (editAtual) editAtual.classList.add('hidden');
    if (novaLinkPanel) novaLinkPanel.classList.remove('hidden');
    document.querySelector('aside')?.classList.add('opacity-40', 'pointer-events-none');
    if (novaLinkUrl) {
      novaLinkUrl.value = '';
      novaLinkUrl.focus();
    }
    const texto = document.getElementById('matter-nova-link-texto');
    const imagem = document.getElementById('matter-nova-link-imagem');
    const tipo = document.getElementById('matter-nova-link-tipo');
    if (texto) texto.value = '';
    if (imagem) imagem.value = '';
    if (tipo) tipo.value = 'auto';
    if (novaLinkStatus) {
      novaLinkStatus.textContent = 'Cole o link e gere a próxima matéria.';
      novaLinkStatus.className = 'text-sm text-slate-400';
    }
    setStatus('');
  }

  function mostrarModoEdicaoAtual() {
    if (novaLinkPanel) novaLinkPanel.classList.add('hidden');
    if (editAtual) editAtual.classList.remove('hidden');
    document.querySelector('aside')?.classList.remove('opacity-40', 'pointer-events-none');
    if (novaLinkStatus) novaLinkStatus.textContent = '';
  }

  document.getElementById('btn-limpar-nova-materia')?.addEventListener('click', () => {
    mostrarModoNovaLink();
  });

  document.getElementById('btn-cancelar-nova-link')?.addEventListener('click', () => {
    mostrarModoEdicaoAtual();
  });

  document.getElementById('btn-gerar-nova-link')?.addEventListener('click', async () => {
    const url = String(novaLinkUrl?.value || '').trim();
    const pageEl = document.getElementById('matter-nova-link-page');
    const tipoEl = document.getElementById('matter-nova-link-tipo');
    const st = novaLinkStatus;
    const btn = document.getElementById('btn-gerar-nova-link');

    if (!url) {
      if (st) {
        st.textContent = 'Cole o link da notícia, Facebook ou Instagram';
        st.className = 'text-sm text-rose-300';
      }
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      if (st) {
        st.textContent = 'O link precisa começar com http:// ou https://';
        st.className = 'text-sm text-rose-300';
      }
      return;
    }

    const looksReel =
      /\/reel\//i.test(url) ||
      /\/reels\//i.test(url) ||
      /\/videos\//i.test(url) ||
      /fb\.watch/i.test(url) ||
      /instagram\.com\/(reel|reels|tv)\//i.test(url);

    let tipo = tipoEl?.value || 'auto';
    if (tipo === 'auto') tipo = looksReel ? 'reel' : 'foto';

    const original = btn?.textContent;
    if (btn) {
      btn.disabled = true;
      btn.textContent = looksReel || tipo === 'reel' ? 'Enfileirando Reel…' : 'Gerando matéria…';
    }
    if (st) {
      st.textContent =
        looksReel || tipo === 'reel'
          ? 'Baixando Reel, legenda e capa…'
          : 'Lendo o link e montando a minimatéria…';
      st.className = 'text-sm text-slate-400';
    }

    try {
      const textoManual = String(document.getElementById('matter-nova-link-texto')?.value || '').trim();
      const imagemManual = String(document.getElementById('matter-nova-link-imagem')?.value || '').trim();
      const res = await fetch('/api/materias-ia/reescrever-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          facebookPageId: pageEl?.value ? Number(pageEl.value) : null,
          tipoPublicacao: tipo,
          status: 'rascunho',
          textoManual: textoManual || undefined,
          imagemManual: imagemManual || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.error && /cole a legenda|texto da postagem|bloqueou/i.test(data.error)) {
          document.querySelector('#matter-nova-link details')?.setAttribute('open', '');
        }
        throw new Error(data.error || 'Falha ao processar o link');
      }

      const matterId = data.matter?.id;
      const dest = data.redirect || (matterId ? '/materias-ia/' + matterId : null);
      if (!dest) throw new Error('Matéria gerada, mas sem ID para abrir');

      if (st) st.textContent = 'Pronta — abrindo a nova matéria…';
      window.location.href = dest;
    } catch (err) {
      if (st) {
        st.textContent = err.message;
        st.className = 'text-sm text-rose-300';
      }
      if (btn) {
        btn.disabled = false;
        btn.textContent = original || 'Gerar a partir do link';
      }
    }
  });

  novaLinkUrl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('btn-gerar-nova-link')?.click();
    }
  });

  document.getElementById('btn-variacao-tema')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-variacao-tema');
    if (!confirm('Gerar uma NOVA matéria neste tema?\n\nA IA busca informações novas e reescreve sem plagiar.')) {
      return;
    }
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Gerando…';
    }
    try {
      const res = await fetch('/api/materias-ia/matters/' + cfg.id + '/variacao', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          facebookPageId: pageSelect?.value ? Number(pageSelect.value) : null,
          tipoPublicacao: tipoEl?.value || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Falha ao gerar');
      const dest = data.redirect || (data.matter?.id ? '/materias-ia/' + data.matter.id : null);
      if (dest) window.location.href = dest;
      else alert('Matéria gerada.');
    } catch (err) {
      alert(err.message || 'Erro');
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Nova matéria neste tema';
      }
    }
  });

  document.getElementById('btn-matter-views')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-matter-views');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Buscando…';
    }
    try {
      const res = await fetch('/api/materias-ia/matters/' + cfg.id + '/views?force=1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Falha');
      if (data.views != null) {
        const n = Number(data.views);
        let label = String(n);
        if (n >= 1000000) label = (n / 1000000).toFixed(1).replace(/\.0$/, '') + ' mi';
        else if (n >= 1000) label = (n / 1000).toFixed(1).replace(/\.0$/, '') + ' mil';
        alert('Visualizações / impressões: ' + label);
      } else {
        alert(data.message || 'Sem dado de visualizações ainda.');
      }
    } catch (err) {
      alert(err.message || 'Erro ao buscar views');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Atualizar visualizações no Facebook';
      }
    }
  });

  window.addEventListener('beforeunload', releaseImagePreview);
  loadPages();
})();
