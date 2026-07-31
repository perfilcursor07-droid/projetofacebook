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

  // ——— Tela dividida (metade imagem, metade vídeo) ———
  const splitPanel = document.getElementById('split-panel');
  if (splitPanel) {
    const imgPreview = document.getElementById('split-img-preview');
    const imgEmpty = document.getElementById('split-img-empty');
    const videoPreview = document.getElementById('split-video-preview');
    const previewBox = document.getElementById('split-preview');
    const videoRange = document.getElementById('split-video-offset');
    const imagemRange = document.getElementById('split-imagem-offset');
    const videoValor = document.getElementById('split-video-valor');
    const imagemValor = document.getElementById('split-imagem-valor');
    const ladoBtn = document.getElementById('btn-split-lado');
    const msgEl = document.getElementById('split-msg');
    const aplicarBtn = document.getElementById('btn-split-aplicar');
    const enquadrarBtn = document.getElementById('btn-split-enquadrar');
    const buscaForm = document.getElementById('split-busca-form');
    const buscaTermo = document.getElementById('split-busca-termo');
    const buscaResultados = document.getElementById('split-busca-resultados');
    const framesBtn = document.getElementById('btn-split-frames');
    const framesResultados = document.getElementById('split-frames-resultados');
    const uploadInput = document.getElementById('split-upload-file');

    let fonte = 'busca';
    let imagemEscolhida = cfg.splitImagemUrl || null;
    let frameSegundo = null;
    let lado = 'esquerda';

    function setSplitMsg(msg, isError) {
      if (!msgEl) return;
      msgEl.textContent = msg || '';
      msgEl.className = 'text-[11px] ' + (isError ? 'text-rose-300' : 'text-slate-500');
    }

    function aplicarOffsetsNoPreview() {
      const v = Number(videoRange?.value ?? 50);
      const i = Number(imagemRange?.value ?? 50);
      if (videoPreview) videoPreview.style.objectPosition = v + '% 50%';
      if (imgPreview) imgPreview.style.objectPosition = i + '% 50%';
      if (videoValor) videoValor.textContent = v + '%';
      if (imagemValor) imagemValor.textContent = i + '%';
    }

    function aplicarLadoNoPreview() {
      if (!previewBox) return;
      previewBox.style.flexDirection = lado === 'direita' ? 'row-reverse' : 'row';
      if (ladoBtn) {
        ladoBtn.dataset.lado = lado;
        ladoBtn.textContent = lado === 'direita' ? 'Imagem à direita' : 'Imagem à esquerda';
      }
    }

    function mostrarImagem(url) {
      imagemEscolhida = url || null;
      if (!imgPreview) return;
      if (url) {
        imgPreview.src = url;
        imgPreview.classList.remove('hidden');
        imgEmpty?.classList.add('hidden');
      } else {
        imgPreview.classList.add('hidden');
        imgEmpty?.classList.remove('hidden');
      }
    }

    function marcarSelecionada(container, el) {
      container?.querySelectorAll('button[data-img]').forEach((b) => {
        b.className =
          'group relative aspect-square overflow-hidden rounded-lg border border-slate-700 transition hover:border-fuchsia-400';
      });
      if (el) {
        el.className =
          'group relative aspect-square overflow-hidden rounded-lg border-2 border-fuchsia-400 ring-2 ring-fuchsia-500/30';
      }
    }

    function thumbsHtml(itens) {
      return itens
        .map(
          (item) => `
        <button type="button" data-img="${escapeHtml(item.url)}" data-segundo="${item.segundo != null ? item.segundo : ''}"
          title="${escapeHtml(item.titulo || '')}"
          class="group relative aspect-square overflow-hidden rounded-lg border border-slate-700 transition hover:border-fuchsia-400">
          <img src="${escapeHtml(item.thumbnail || item.url)}" alt="" loading="lazy" class="h-full w-full object-cover" />
        </button>`
        )
        .join('');
    }

    videoRange?.addEventListener('input', aplicarOffsetsNoPreview);
    imagemRange?.addEventListener('input', aplicarOffsetsNoPreview);
    aplicarOffsetsNoPreview();
    aplicarLadoNoPreview();

    ladoBtn?.addEventListener('click', () => {
      lado = lado === 'direita' ? 'esquerda' : 'direita';
      aplicarLadoNoPreview();
    });

    document.getElementById('btn-split-play')?.addEventListener('click', () => {
      if (!videoPreview) return;
      if (videoPreview.paused) videoPreview.play().catch(() => {});
      else videoPreview.pause();
    });

    splitPanel.querySelectorAll('.split-fonte-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        fonte = btn.dataset.splitFonte;
        splitPanel.querySelectorAll('.split-fonte-btn').forEach((b) => {
          const on = b === btn;
          b.className = on
            ? 'split-fonte-btn rounded-lg bg-fuchsia-500 px-3 py-1.5 text-xs font-semibold text-white'
            : 'split-fonte-btn rounded-lg px-3 py-1.5 text-xs text-slate-300 hover:text-white';
        });
        ['busca', 'frame', 'upload'].forEach((key) => {
          document.getElementById('split-pane-' + key)?.classList.toggle('hidden', key !== fonte);
        });
      });
    });

    buscaForm?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const termo = String(buscaTermo?.value || '').trim();
      if (termo.length < 2) {
        setSplitMsg('Digite pelo menos 2 caracteres.', true);
        return;
      }
      setSplitMsg('Buscando fotos…');
      if (buscaResultados) {
        buscaResultados.innerHTML = '<p class="col-span-4 text-[11px] text-slate-500">Buscando…</p>';
      }
      try {
        const res = await fetch(
          '/api/clips/' + cfg.id + '/split/imagens?q=' + encodeURIComponent(termo)
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Falha na busca de imagens');
        const imagens = Array.isArray(data.imagens) ? data.imagens : [];
        if (!imagens.length) throw new Error('Nenhuma imagem encontrada.');
        if (buscaResultados) buscaResultados.innerHTML = thumbsHtml(imagens);
        setSplitMsg(data.aviso || imagens.length + ' fotos');
      } catch (err) {
        if (buscaResultados) buscaResultados.innerHTML = '';
        setSplitMsg(err.message, true);
      }
    });

    framesBtn?.addEventListener('click', async () => {
      setSplitMsg('Pegando momentos do vídeo…');
      framesBtn.disabled = true;
      try {
        const res = await fetch('/api/clips/' + cfg.id + '/split/frames?quantidade=8');
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Falha ao extrair frames');
        const frames = (data.frames || []).map((f) => ({
          url: f.url,
          thumbnail: f.url,
          segundo: f.segundo,
          titulo: f.segundo + 's',
        }));
        if (framesResultados) framesResultados.innerHTML = thumbsHtml(frames);
        setSplitMsg(frames.length + ' momentos — clique em um');
      } catch (err) {
        setSplitMsg(err.message, true);
      } finally {
        framesBtn.disabled = false;
      }
    });

    splitPanel.addEventListener('click', (e) => {
      const thumb = e.target.closest('button[data-img]');
      if (!thumb) return;
      e.preventDefault();
      const container = thumb.parentElement;
      marcarSelecionada(container, thumb);
      mostrarImagem(thumb.dataset.img);
      const segundo = thumb.dataset.segundo;
      frameSegundo = segundo !== '' && segundo != null ? Number(segundo) : null;
      setSplitMsg('Imagem escolhida — clique em aplicar.');
    });

    uploadInput?.addEventListener('change', () => {
      const file = uploadInput.files?.[0];
      if (!file) return;
      mostrarImagem(URL.createObjectURL(file));
      frameSegundo = null;
      setSplitMsg('Arquivo pronto — clique em aplicar.');
    });

    function corpoDoSplit() {
      const videoOffset = Number(videoRange?.value ?? 50);
      const imagemOffset = Number(imagemRange?.value ?? 50);

      if (fonte === 'upload') {
        const file = uploadInput?.files?.[0];
        if (!file) throw new Error('Escolha um arquivo de imagem.');
        const form = new FormData();
        form.append('imagem', file);
        form.append('fonte', 'upload');
        form.append('video_offset', String(videoOffset));
        form.append('imagem_offset', String(imagemOffset));
        form.append('imagem_lado', lado);
        return { body: form, isForm: true };
      }

      if (fonte === 'frame') {
        if (frameSegundo == null) throw new Error('Clique em um momento do vídeo primeiro.');
        return {
          body: {
            fonte: 'frame',
            frame_segundo: frameSegundo,
            video_offset: videoOffset,
            imagem_offset: imagemOffset,
            imagem_lado: lado,
          },
          isForm: false,
        };
      }

      if (!imagemEscolhida || !/^https?:\/\//i.test(imagemEscolhida)) {
        throw new Error('Busque e clique em uma foto primeiro.');
      }
      return {
        body: {
          fonte: 'busca',
          imagem_url: imagemEscolhida,
          video_offset: videoOffset,
          imagem_offset: imagemOffset,
          imagem_lado: lado,
        },
        isForm: false,
      };
    }

    aplicarBtn?.addEventListener('click', async () => {
      let payload;
      try {
        payload = corpoDoSplit();
      } catch (err) {
        setSplitMsg(err.message, true);
        return;
      }

      const original = aplicarBtn.textContent;
      aplicarBtn.disabled = true;
      aplicarBtn.textContent = 'Montando…';
      setSplitMsg('Montando a tela dividida…');
      try {
        const res = await fetch('/api/clips/' + cfg.id + '/split', {
          method: 'POST',
          headers: payload.isForm ? undefined : { 'Content-Type': 'application/json' },
          body: payload.isForm ? payload.body : JSON.stringify(payload.body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Falha ao montar a tela dividida');
        setSplitMsg(data.message || 'Enfileirado — atualizando…');
        setTimeout(() => location.reload(), 7000);
      } catch (err) {
        aplicarBtn.disabled = false;
        aplicarBtn.textContent = original;
        setSplitMsg(err.message, true);
      }
    });

    enquadrarBtn?.addEventListener('click', async () => {
      enquadrarBtn.disabled = true;
      setSplitMsg('Reenquadrando…');
      try {
        await postJson('/api/clips/' + cfg.id + '/split/enquadrar', {
          video_offset: Number(videoRange?.value ?? 50),
          imagem_offset: Number(imagemRange?.value ?? 50),
          imagem_lado: lado,
        });
        setSplitMsg('Enfileirado — atualizando…');
        setTimeout(() => location.reload(), 7000);
      } catch (err) {
        enquadrarBtn.disabled = false;
        setSplitMsg(err.message, true);
      }
    });

    document.getElementById('btn-split-remover')?.addEventListener('click', async () => {
      if (!confirm('Voltar o corte para o vídeo cheio?')) return;
      try {
        const res = await fetch('/api/clips/' + cfg.id + '/split', { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Falha ao remover');
        location.reload();
      } catch (err) {
        setSplitMsg(err.message, true);
      }
    });
  }

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

  // Auto-refresh enquanto matéria/capa/tela dividida geram
  if (
    cfg.materiaStatus === 'gerando' ||
    cfg.capaStatus === 'gerando' ||
    cfg.splitStatus === 'gerando'
  ) {
    setStatus('Aguarde: gerando conteúdo…');
    setTimeout(() => location.reload(), 6000);
  }
})();
