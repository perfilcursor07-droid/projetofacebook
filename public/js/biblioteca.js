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

  // Abas por plataforma em "Suas fontes"
  (function initFontesTabs() {
    const tabs = document.getElementById('bib-fontes-tabs');
    const list = document.getElementById('bib-fontes');
    const countEl = document.getElementById('bib-fontes-count');
    const emptyTab = document.getElementById('bib-fontes-empty-tab');
    if (!tabs || !list) return;

    const tabActive =
      'bib-fonte-tab inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-2.5 py-1.5 text-xs font-semibold text-emerald-300 transition';
    const tabIdle =
      'bib-fonte-tab inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900/40 px-2.5 py-1.5 text-xs font-medium text-slate-400 transition hover:border-slate-600 hover:text-slate-200';

    function aplicarFiltro(plat) {
      const items = list.querySelectorAll('.bib-fonte');
      let visible = 0;
      items.forEach((el) => {
        const match = plat === 'todas' || el.dataset.plataforma === plat;
        el.classList.toggle('hidden', !match);
        if (match) visible += 1;
      });
      if (emptyTab) emptyTab.classList.toggle('hidden', visible > 0 || items.length === 0);
      if (countEl) {
        countEl.textContent = `${visible} salva${visible === 1 ? '' : 's'}`;
      }
      tabs.querySelectorAll('.bib-fonte-tab').forEach((btn) => {
        const on = btn.dataset.plat === plat;
        btn.setAttribute('aria-selected', on ? 'true' : 'false');
        btn.className = on ? tabActive : tabIdle;
      });
    }

    tabs.addEventListener('click', (e) => {
      const btn = e.target.closest('.bib-fonte-tab');
      if (!btn) return;
      e.preventDefault();
      aplicarFiltro(btn.dataset.plat || 'todas');
    });
  })();

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

  async function gerarVideo(id, facebookPageId = pageId(), { openInNewTab = false } = {}) {
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

  // --- Lista de palavras-chave dos alertas (salva na conta) ---
  const alertasBox = document.getElementById('bib-alertas');
  const alertasAside = document.getElementById('bib-secao-alertas');
  const keywordInput = document.getElementById('bib-alertas-keyword-input');
  const keywordAddBtn = document.getElementById('bib-alertas-keyword-add');
  const keywordsListEl = document.getElementById('bib-alertas-keywords-list');
  const keywordsClearBtn = document.getElementById('bib-alertas-keywords-clear');
  const filterStatus = document.getElementById('bib-alertas-filter-status');
  const markAllBtn = document.getElementById('bib-mark-all');

  /** Abre URL em nova aba sem tirar o foco de /biblioteca. */
  function abrirAbaEmSegundoPlano(url) {
    if (!url || url.startsWith('#')) return;
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    // Ctrl/Cmd+click costuma abrir em segundo plano (sem mudar de aba)
    a.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        view: window,
        ctrlKey: true,
        metaKey: true,
      })
    );
  }

  function marcarAlertaVisualComoLido(link) {
    if (!link || link.dataset.lido === '1') return false;
    link.dataset.lido = '1';
    link.classList.add('opacity-55');
    const dot = link.querySelector('[title="Não lido"], .h-2.w-2');
    if (dot) {
      dot.className = 'block h-2 w-2 rounded-full bg-slate-700';
      dot.title = 'Lido';
    }
    const unread = document.getElementById('bib-alertas-unread-count');
    const app = document.getElementById('biblioteca-app');
    const atual = Number(app?.dataset?.alertasNaoLidos || 0);
    if (atual > 0 && app) {
      const novo = atual - 1;
      app.dataset.alertasNaoLidos = String(novo);
      if (unread) {
        if (novo <= 0) unread.classList.add('hidden');
        else {
          unread.classList.remove('hidden');
          unread.textContent = `${novo} novo${novo === 1 ? '' : 's'}`;
        }
      }
    }
    return true;
  }

  alertasBox?.addEventListener('click', (e) => {
    const link = e.target.closest('.bib-alerta-link');
    if (!link || !alertasBox.contains(link)) return;
    const href = link.getAttribute('href') || '';
    if (!href || href.startsWith('#')) return;
    // Já com Ctrl/Cmd/Shift: deixa o navegador agir
    if (e.ctrlKey || e.metaKey || e.shiftKey) return;
    e.preventDefault();
    abrirAbaEmSegundoPlano(href);
    const eraNovo = marcarAlertaVisualComoLido(link);
    const alertaId = link.dataset.alerta;
    if (eraNovo && alertaId) {
      api(`/api/biblioteca/alertas/${alertaId}/lido`, { method: 'POST', body: '{}' }).catch(() => {});
    }
  });

  function parseKeywordsClient(raw) {
    const parts = Array.isArray(raw) ? raw : String(raw || '').split(/[,;\n]+/);
    const seen = new Set();
    const out = [];
    for (const item of parts) {
      const k = String(item || '').trim().replace(/\s+/g, ' ');
      if (k.length < 2) continue;
      const key = k.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(k);
      if (out.length >= 30) break;
    }
    return out;
  }

  let keywordsList = parseKeywordsClient(alertasAside?.dataset?.keywordsSalvas || '');

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
            ? 'Quando surgir conteúdo com essas palavras, ele aparece aqui automaticamente.'
            : 'As novidades aparecerão aqui quando uma fonte monitorada publicar algo.'
        }</p>
      </div>`;
  }

  function renderAlertaItem(a) {
    const dest = a.post_id
      ? `/biblioteca/posts/${a.post_id}`
      : a.fonte_id
        ? `/biblioteca/fontes/${a.fonte_id}`
        : '#bib-secao-alertas';
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
    const clicavel = Boolean(a.post_id || a.fonte_id);

    return `
      <a
        href="${escHtml(dest)}"
        class="bib-alerta-link group flex gap-3 px-4 py-4 transition hover:bg-slate-800/30 sm:px-5 ${lido ? 'opacity-55' : ''} ${clicavel ? '' : 'pointer-events-none'}"
        data-alerta="${escHtml(a.id)}"
        data-lido="${lido ? '1' : '0'}">
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

  function renderKeywordsList() {
    if (!keywordsListEl) return;
    const countEl = document.getElementById('bib-keywords-count');
    if (countEl) countEl.textContent = `${keywordsList.length}/40`;
    keywordsClearBtn?.classList.toggle('hidden', !keywordsList.length);
    if (!keywordsList.length) {
      keywordsListEl.innerHTML = '<p class="text-[11px] text-slate-600" data-empty>Nenhuma palavra cadastrada.</p>';
      return;
    }
    keywordsListEl.innerHTML = keywordsList
      .map(
        (kw) => `
      <span class="inline-flex max-w-full items-center gap-1 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-1 text-[11px] font-medium text-emerald-200" data-keyword="${escHtml(kw)}">
        <span class="truncate" title="${escHtml(kw)}">${escHtml(kw)}</span>
        <button type="button" class="bib-kw-remove shrink-0 rounded-full p-0.5 text-emerald-300/70 transition hover:bg-emerald-500/20 hover:text-white" data-remove="${escHtml(kw)}" aria-label="Remover ${escHtml(kw)}">
          <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </span>`
      )
      .join('');
  }

  function aplicarListaAlertas(list) {
    if (!alertasBox) return;
    const filtrando = keywordsList.length > 0;
    if (!list.length) {
      alertasBox.innerHTML = renderAlertasEmpty(filtrando);
    } else {
      alertasBox.innerHTML = list.map(renderAlertaItem).join('');
    }
    if (markAllBtn) {
      markAllBtn.classList.toggle('invisible', !list.length && !filtrando);
    }
    if (filtrando) {
      setFilterStatus(
        list.length
          ? `Lista ativa · ${keywordsList.length} palavra${keywordsList.length === 1 ? '' : 's'} · ${list.length} alerta${list.length === 1 ? '' : 's'}`
          : `Lista ativa · ${keywordsList.length} palavra${keywordsList.length === 1 ? '' : 's'} · nenhum alerta no momento`,
        true
      );
    } else {
      setFilterStatus('', false);
    }
  }

  async function persistirListaKeywords(nextList) {
    const list = parseKeywordsClient(nextList);
    if (keywordAddBtn) {
      keywordAddBtn.disabled = true;
      keywordAddBtn.textContent = '…';
    }
    try {
      const data = await api('/api/biblioteca/alertas/keywords', {
        method: 'PUT',
        body: JSON.stringify({ keywords: list }),
      });
      keywordsList = Array.isArray(data.keywordsList)
        ? data.keywordsList
        : parseKeywordsClient(data.keywordsSalvas || data.keywords || list);
      const joined = keywordsList.join(', ');
      if (alertasAside) alertasAside.dataset.keywordsSalvas = joined;
      renderKeywordsList();
      aplicarListaAlertas(Array.isArray(data.alertas) ? data.alertas : []);
    } catch (err) {
      setFilterStatus(err.message || 'Falha ao salvar lista', true);
      renderKeywordsList();
    } finally {
      if (keywordAddBtn) {
        keywordAddBtn.disabled = false;
        keywordAddBtn.innerHTML = '<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg> Add';
      }
    }
  }

  async function adicionarKeyword() {
    const raw = String(keywordInput?.value || '').trim();
    if (!raw) {
      keywordInput?.focus();
      return;
    }
    // Aceita várias de uma vez se o usuário colar "pastor, igreja"
    const novas = parseKeywordsClient(raw);
    if (!novas.length) {
      setFilterStatus('Digite ao menos 2 caracteres.', true);
      return;
    }
    const merged = parseKeywordsClient([...keywordsList, ...novas]);
    if (merged.length === keywordsList.length) {
      setFilterStatus('Essa palavra já está na lista.', true);
      if (keywordInput) keywordInput.value = '';
      return;
    }
    if (keywordInput) keywordInput.value = '';
    await persistirListaKeywords(merged);
    keywordInput?.focus();
  }

  async function removerKeyword(kw) {
    const next = keywordsList.filter((item) => item.toLowerCase() !== String(kw || '').toLowerCase());
    await persistirListaKeywords(next);
  }

  keywordAddBtn?.addEventListener('click', () => {
    adicionarKeyword();
  });

  keywordInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      adicionarKeyword();
    }
  });

  keywordsListEl?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove]');
    if (!btn) return;
    e.preventDefault();
    removerKeyword(btn.getAttribute('data-remove'));
  });

  keywordsClearBtn?.addEventListener('click', async () => {
    if (!keywordsList.length) return;
    if (!confirm('Limpar toda a lista de palavras-chave?')) return;
    await persistirListaKeywords([]);
  });

  renderKeywordsList();

  document.querySelectorAll('a[href="#bib-secao-alertas"], #bib-btn-alertas').forEach((el) => {
    el.addEventListener('click', (e) => {
      const target = document.getElementById('bib-secao-alertas');
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
})();
