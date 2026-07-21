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

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function scanFalhou(button, message) {
    button.textContent = 'Falhou';
    button.disabled = false;
    button.title = message || 'Não foi possível concluir o escaneamento';
    button.classList.remove('opacity-50', 'pointer-events-none', 'text-amber-300');
    button.classList.add('text-rose-300');
    setTimeout(() => {
      button.textContent = 'Escanear agora';
      button.classList.remove('text-rose-300');
    }, 4000);
  }

  async function acompanharScan(button, id, onDone) {
    // O servidor consulta a Bright Data a cada minuto; a UI só acompanha o estado persistido.
    for (let tentativa = 0; tentativa < 36; tentativa += 1) {
      await sleep(10_000);
      try {
        const status = await api(`/api/biblioteca/fontes/${id}/posts`);
        if (status.pending) continue;
        if (status.scrape_error) throw new Error(status.scrape_error);

        button.textContent = 'Scan concluído';
        button.classList.remove('opacity-50', 'text-amber-300');
        button.classList.add('text-emerald-300');
        setTimeout(onDone, 1000);
        return;
      } catch (err) {
        scanFalhou(button, err.message);
        return;
      }
    }

    // A coleta continua no servidor mesmo que o acompanhamento do navegador termine.
    button.textContent = 'Escaneando em segundo plano…';
    button.classList.remove('opacity-50');
    button.classList.add('text-amber-300');
  }

  async function iniciarScanNoBotao(button, id, onDone) {
    button.disabled = true;
    button.textContent = 'Iniciando scan…';
    button.classList.add('opacity-50', 'pointer-events-none');
    button.classList.remove('text-rose-300', 'text-emerald-300');

    try {
      const data = await api(`/api/biblioteca/fontes/${id}/escanear`, {
        method: 'POST',
        body: '{}',
      });

      if (data.pending) {
        button.textContent = 'Escaneando em segundo plano…';
        button.classList.remove('opacity-50');
        button.classList.add('text-amber-300');
        await acompanharScan(button, id, onDone);
        return;
      }

      const novos = data.novos?.length || data.salvos || 0;
      const itens = data.itens || 0;
      button.textContent = itens ? `${novos} novo(s) de ${itens}` : 'Nenhum item';
      button.classList.remove('opacity-50');
      button.classList.add('text-emerald-300');
      setTimeout(onDone, 1000);
    } catch (err) {
      scanFalhou(button, err.message);
    }
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
        iniciarScanNoBotao(scan, scan.dataset.id, () => {
          location.href = `/biblioteca/fontes/${scan.dataset.id}`;
        });
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
  document.getElementById('bib-fonte-scan')?.addEventListener('click', () => {
    if (!fonteId) return;
    const button = document.getElementById('bib-fonte-scan');
    iniciarScanNoBotao(button, fonteId, () => location.reload());
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

  async function gerarTexto(id, { tipo = 'texto', facebookPageId = pageId(), openInNewTab = false } = {}) {
    setBusy(true, tipo === 'foto' ? 'IA preparando matéria e capa…' : 'IA gerando texto…');
    try {
      const data = await api(`/api/biblioteca/posts/${id}/gerar-texto`, {
        method: 'POST',
        body: JSON.stringify({
          facebook_page_id: facebookPageId,
          tipoPublicacao: tipo,
        }),
      });
      const dest = data.redirect || '/minhas-materias';
      if (openInNewTab) {
        window.open(dest, '_blank', 'noopener,noreferrer');
      } else {
        location.href = dest;
      }
    } catch (err) {
      alert(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function gerarVideo(id, facebookPageId = recommendationPageId() || pageId(), { openInNewTab = false } = {}) {
    setBusy(true, 'Baixando e preparando o Reel…');
    try {
      const data = await api(`/api/biblioteca/posts/${id}/gerar-video`, {
        method: 'POST',
        body: JSON.stringify({ facebook_page_id: facebookPageId }),
      });
      const dest = data.redirect || '/fila';
      if (openInNewTab) {
        window.open(dest, '_blank', 'noopener,noreferrer');
      } else {
        location.href = dest;
      }
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

  function renumerarMelhores() {
    document.querySelectorAll('#bib-melhores-track [data-melhor-post]').forEach((card, i) => {
      const rank = card.querySelector('.bib-melhor-rank');
      if (rank) rank.textContent = String(i + 1);
    });
  }

  async function ocultarMelhor(id, cardEl) {
    try {
      cardEl?.classList.add('opacity-40', 'pointer-events-none');
      await api(`/api/biblioteca/melhores/${id}`, { method: 'DELETE' });
      cardEl?.remove();
      renumerarMelhores();
      const track = document.getElementById('bib-melhores-track');
      if (track && !track.querySelector('[data-melhor-post]')) {
        location.reload();
      }
    } catch (err) {
      cardEl?.classList.remove('opacity-40', 'pointer-events-none');
      alert(err.message);
    }
  }

  document.body.addEventListener('click', (e) => {
    const ocultar = e.target.closest('.bib-ocultar-melhor');
    const publicar = e.target.closest('.bib-publicar-melhor');
    const preparar = e.target.closest('.bib-preparar-melhor');
    const t = e.target.closest('.bib-gen-texto');
    const v = e.target.closest('.bib-gen-video');
    if (ocultar) {
      const card = ocultar.closest('[data-melhor-post]');
      ocultarMelhor(ocultar.dataset.id, card);
      return;
    }
    if (publicar) {
      publicarMelhor(publicar.dataset.id, publicar.dataset.media);
      return;
    }
    if (preparar) {
      const id = preparar.dataset.id;
      const destinationPage = recommendationPageId();
      const media = preparar.dataset.media === 'video' ? 'video' : 'post';
      const qs = new URLSearchParams({ media });
      if (destinationPage) qs.set('facebook_page_id', String(destinationPage));
      // Abre na hora em nova aba — sem modal na Biblioteca
      window.open(`/biblioteca/preparar/${id}?${qs.toString()}`, '_blank', 'noopener,noreferrer');
      return;
    }
    if (t) gerarTexto(t.dataset.id);
    if (v) gerarVideo(v.dataset.id);
  });

  document.getElementById('bib-analisar-melhores')?.addEventListener('click', async () => {
    try {
      setBusy(true, 'Escaneando fontes e atualizando análise…');
      const data = await api('/api/biblioteca/melhores/analisar', {
        method: 'POST',
        body: JSON.stringify({ limit: 30 }),
      });
      if (!data.melhores?.length) {
        const novas = data.scan?.novas || 0;
        alert(
          novas
            ? 'Fontes escaneadas, mas nenhum conteúdo com pontuação 50+ ainda. Tente de novo em instantes.'
            : 'Nenhum conteúdo pendente encontrado nas fontes. Confira se as fontes estão ativas.'
        );
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

  // --- Filtro por palavras-chave nos alertas recentes ---
  const alertasBox = document.getElementById('bib-alertas');
  const keywordsInput = document.getElementById('bib-alertas-keywords');
  const filterStatus = document.getElementById('bib-alertas-filter-status');
  const markAllBtn = document.getElementById('bib-mark-all');
  let keywordsTimer = null;
  let keywordsReq = 0;

  function escHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function platClass(p) {
    const k = String(p || '').toLowerCase();
    if (k === 'youtube') return 'bg-rose-500/15 text-rose-300 ring-rose-500/20';
    if (k === 'facebook') return 'bg-sky-500/15 text-sky-300 ring-sky-500/20';
    if (k === 'instagram') return 'bg-fuchsia-500/15 text-fuchsia-300 ring-fuchsia-500/20';
    if (k === 'tiktok') return 'bg-slate-100/10 text-slate-200 ring-slate-500/30';
    if (k === 'site') return 'bg-amber-500/15 text-amber-300 ring-amber-500/20';
    return 'bg-slate-800 text-slate-300 ring-slate-700';
  }

  function fmtQuando(d) {
    if (!d) return '';
    try {
      return new Date(d).toLocaleString('pt-BR', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch (_) {
      return '';
    }
  }

  function renderAlertasEmpty(filtrando) {
    return `
      <div class="px-5 py-14 text-center">
        <span class="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-slate-800/70 text-slate-500">
          <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M13.7 21h-3.4" /></svg>
        </span>
        <p class="mt-3 text-sm font-medium text-slate-400">${
          filtrando ? 'Nenhum alerta com essas palavras-chave' : 'Nenhum alerta por enquanto'
        }</p>
        <p class="mt-1 text-xs leading-relaxed text-slate-600">${
          filtrando
            ? 'Tente outras palavras ou limpe o filtro para ver todos os alertas.'
            : 'As novidades aparecerão aqui quando uma fonte monitorada publicar algo.'
        }</p>
      </div>`;
  }

  function renderAlertaItem(a) {
    const dest = a.fonte_id ? `/biblioteca/fontes/${a.fonte_id}` : '#bib-secao-alertas';
    const lido = Boolean(a.lido);
    const plat = a.fonte_plataforma
      ? `<span class="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ring-inset ${platClass(a.fonte_plataforma)}">${escHtml(a.fonte_plataforma)}</span>`
      : '';
    const fonteNome = a.fonte_nome
      ? `<span class="max-w-[9rem] truncate text-[11px] text-slate-500">${escHtml(a.fonte_nome)}</span>`
      : '';
    const resumo = a.resumo
      ? `<p class="mt-1 line-clamp-2 text-xs leading-relaxed text-slate-400">${escHtml(a.resumo)}</p>`
      : '';
    const dot = lido
      ? '<span class="block h-2 w-2 rounded-full bg-slate-700" title="Lido"></span>'
      : '<span class="block h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_0_3px_rgba(52,211,153,0.15)]" title="Não lido"></span>';

    return `
      <a
        href="${escHtml(dest)}"
        class="group flex gap-3 px-4 py-4 transition hover:bg-slate-800/30 sm:px-5 ${lido ? 'opacity-55' : ''} ${a.fonte_id ? '' : 'pointer-events-none'}"
        data-alerta="${escHtml(a.id)}">
        <div class="mt-1.5 shrink-0">${dot}</div>
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            ${plat}
            ${fonteNome}
            <time class="ml-auto shrink-0 text-[11px] tabular-nums text-slate-600">${escHtml(fmtQuando(a.created_at))}</time>
          </div>
          <h3 class="mt-1.5 line-clamp-2 text-sm font-medium leading-snug text-white transition group-hover:text-emerald-300">${escHtml(a.titulo || '')}</h3>
          ${resumo}
        </div>
      </a>`;
  }

  function setFilterStatus(text, show) {
    if (!filterStatus) return;
    filterStatus.textContent = text || '';
    filterStatus.classList.toggle('hidden', !show);
  }

  async function carregarAlertasPorKeywords() {
    if (!alertasBox || !keywordsInput) return;
    const raw = String(keywordsInput.value || '').trim();
    const reqId = ++keywordsReq;
    setFilterStatus(raw ? 'Filtrando…' : '', Boolean(raw));

    try {
      const qs = new URLSearchParams();
      if (raw) qs.set('keywords', raw);
      const data = await api('/api/biblioteca/alertas' + (qs.toString() ? `?${qs}` : ''));
      if (reqId !== keywordsReq) return;

      const list = Array.isArray(data.alertas) ? data.alertas : [];
      if (!list.length) {
        alertasBox.innerHTML = renderAlertasEmpty(Boolean(raw));
      } else {
        alertasBox.innerHTML = list.map(renderAlertaItem).join('');
      }

      if (markAllBtn) {
        markAllBtn.classList.toggle('invisible', !list.length && !raw);
      }

      if (raw) {
        setFilterStatus(
          list.length
            ? `${list.length} alerta${list.length === 1 ? '' : 's'} com: ${raw}`
            : `Nenhum resultado para: ${raw}`,
          true
        );
      } else {
        setFilterStatus('', false);
      }
    } catch (err) {
      if (reqId !== keywordsReq) return;
      setFilterStatus(err.message || 'Falha ao filtrar alertas', true);
    }
  }

  keywordsInput?.addEventListener('input', () => {
    clearTimeout(keywordsTimer);
    keywordsTimer = setTimeout(carregarAlertasPorKeywords, 350);
  });

  keywordsInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(keywordsTimer);
      carregarAlertasPorKeywords();
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
