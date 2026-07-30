/* Agenda biblioteca — sem window.confirm (ações diretas) */
(function () {
  const msgEl = document.getElementById('agenda-msg');
  const busyEl = document.getElementById('agenda-busy');
  const busyText = document.getElementById('agenda-busy-text');
  const listEl = document.getElementById('agenda-list');
  const countEl = document.getElementById('agenda-count');
  const checkAll = document.getElementById('agenda-check-all');
  const btnLoteConfirmar = document.getElementById('agenda-lote-confirmar');
  const btnLotePublicar = document.getElementById('agenda-lote-publicar');
  const btnLoteExcluir = document.getElementById('agenda-lote-excluir');
  const mainEl = document.querySelector('main[data-agenda-aba]');
  const abaAtual =
    (mainEl && mainEl.dataset.agendaAba) ||
    new URLSearchParams(location.search).get('aba') ||
    'agendada';

  function reloadAgenda() {
    const params = new URLSearchParams(location.search);
    params.set('aba', abaAtual === 'publicadas' ? 'publicadas' : 'agendada');
    location.href = '/biblioteca/agendar?' + params.toString();
  }

  /** Remove cabeçalhos de dia sem itens e atualiza a contagem de cada grupo. */
  function syncGruposDeDia() {
    listEl?.querySelectorAll('li.agenda-day').forEach((header) => {
      const dia = header.dataset.day;
      const n = listEl.querySelectorAll(
        'li.agenda-row[data-day="' + CSS.escape(dia || '') + '"]'
      ).length;
      if (!n) {
        header.remove();
        return;
      }
      const badge = header.querySelector('.agenda-day-count');
      if (badge) badge.textContent = String(n);
    });
  }

  function updateAgendaCount() {
    const n = listEl ? listEl.querySelectorAll('li.agenda-row').length : 0;
    if (countEl) countEl.textContent = '(' + n + ' nesta lista)';
    const tab = document.querySelector('a[href*="aba=agendada"] span');
    if (tab && abaAtual !== 'publicadas') tab.textContent = '(' + n + ')';
    let empty = document.getElementById('agenda-empty');
    if (n === 0 && listEl && !empty) {
      empty = document.createElement('li');
      empty.id = 'agenda-empty';
      empty.className = 'px-4 py-10 text-center text-sm text-slate-500';
      empty.textContent =
        abaAtual === 'publicadas'
          ? 'Nenhuma publicação ainda nesta agenda.'
          : 'Nenhuma pré-agenda ainda. Clique em Montar agenda de amanhã.';
      listEl.appendChild(empty);
    } else if (n > 0 && empty) {
      empty.remove();
    }
    if (checkAll) checkAll.checked = false;
    syncLoteButtons();
  }

  /** Remove linhas e aplica horários já compactados — sem reload (mantém o scroll). */
  function applyAgendaAposExcluir(idsRemovidos, itens) {
    const y = window.scrollY;
    const removidos = new Set((idsRemovidos || []).map(Number));
    removidos.forEach((id) => {
      listEl?.querySelector('li.agenda-row[data-id="' + id + '"]')?.remove();
    });
    if (Array.isArray(itens)) {
      itens.forEach((item) => {
        const id = Number(item.id);
        if (!id || removidos.has(id)) return;
        const row = listEl?.querySelector('li.agenda-row[data-id="' + id + '"]');
        if (!row) return;
        const local = String(
          item.proposed_at_local || (item.proposed_at ? item.proposed_at : '')
        ).slice(0, 16);
        if (local.length < 16) return;
        const horaInput = row.querySelector('.agenda-hora');
        if (horaInput) horaInput.value = local;
        const badge = row.querySelector('.agenda-hora-badge');
        if (badge) badge.textContent = local.slice(11, 16);
      });
    }
    syncGruposDeDia();
    updateAgendaCount();
    requestAnimationFrame(() => window.scrollTo(0, y));
  }

  function setBusy(on, text) {
    if (!busyEl) return;
    busyEl.classList.toggle('hidden', !on);
    if (busyText && text) busyText.textContent = text;
  }

  function setMsg(text, isError) {
    if (!msgEl) return;
    if (!text) {
      msgEl.classList.add('hidden');
      return;
    }
    msgEl.textContent = text;
    msgEl.className =
      'text-sm sm:col-span-2 lg:col-span-12 ' + (isError ? 'text-rose-300' : 'text-emerald-300');
    msgEl.classList.remove('hidden');
  }

  async function api(url, opts) {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      ...opts,
    });
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = {};
    }
    if (!res.ok) {
      const msg =
        data.error ||
        data.message ||
        (res.status === 504 || res.status === 502
          ? 'Tempo esgotado no servidor. Tente com menos itens (ex.: 10–20) e rode de novo — a agenda continua do último horário.'
          : null) ||
        (text && text.length < 200 && !text.trim().startsWith('<') ? text.trim() : null) ||
        res.statusText ||
        'Erro ao montar a agenda';
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function selectedIds() {
    return Array.from(document.querySelectorAll('.agenda-check:checked')).map((el) =>
      Number(el.value)
    );
  }

  function syncLoteButtons() {
    const n = selectedIds().length;
    const disabled = n === 0;
    [btnLoteConfirmar, btnLotePublicar, btnLoteExcluir].forEach((btn) => {
      if (btn) btn.disabled = disabled;
    });
    const chip = document.getElementById('agenda-selecao');
    if (chip) {
      chip.textContent = n === 1 ? '1 selecionado' : n + ' selecionados';
      chip.classList.toggle('hidden', n === 0);
    }
  }

  checkAll?.addEventListener('change', () => {
    document.querySelectorAll('.agenda-check').forEach((el) => {
      el.checked = Boolean(checkAll.checked);
    });
    syncLoteButtons();
  });

  listEl?.addEventListener('change', (e) => {
    if (e.target.classList.contains('agenda-check')) syncLoteButtons();
  });

  document.getElementById('agenda-montar-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const page = document.getElementById('agenda-page')?.value || '';
    const max = Number(document.getElementById('agenda-max')?.value || 20);
    const usarKeywords = Boolean(document.getElementById('agenda-usar-keywords')?.checked);
    if (!page) {
      setMsg('Selecione a Página do Facebook.', true);
      return;
    }
    try {
      setBusy(
        true,
        usarKeywords
          ? 'Montando agenda só com posts das suas palavras-chave…'
          : 'Montando agenda de amanhã (pode demorar se for gerar várias matérias)…'
      );
      setMsg('');
      const data = await api('/api/biblioteca/agenda/montar', {
        method: 'POST',
        body: JSON.stringify({
          facebook_page_id: page,
          max_itens: max,
          somente_sites: true,
          usar_keywords: usarKeywords,
        }),
      });
      const de = data.de ? String(data.de).replace('T', ' ') : null;
      const ate = data.ate ? String(data.ate).replace('T', ' ') : null;
      const cont = data.continuidade
        ? ` (após ${String(data.continuidade).replace('T', ' ')})`
        : '';
      const kwHint = data.filtroKeywords
        ? ` (filtro: ${data.keywordsUsadas || 0} palavra(s)-chave)`
        : '';
      setMsg(
        `${data.criados || 0} item(ns) pré-agendado(s)${kwHint}${cont}` +
          (de && ate ? `: ${de} → ${ate}` : data.dia ? ` para ${data.dia}` : '') +
          '.' +
          (data.erros?.length ? ` ${data.erros.length} aviso(s)/falha(s).` : ''),
        false
      );
      reloadAgenda();
    } catch (err) {
      setMsg(err.message, true);
    } finally {
      setBusy(false);
    }
  });

  document.getElementById('agenda-btn-compactar')?.addEventListener('click', async () => {
    try {
      setBusy(true, 'Reorganizando horários de 30 em 30 min…');
      setMsg('');
      const data = await api('/api/biblioteca/agenda/compactar', {
        method: 'POST',
        body: '{}',
      });
      setMsg(data.mensagem || `${data.ajustados || 0} horário(s) ajustado(s).`, false);
      // Hard reload para garantir horários novos na tela
      setTimeout(() => {
        window.location.href = '/biblioteca/agendar?aba=agendada&t=' + Date.now();
      }, 400);
    } catch (err) {
      setMsg(err.message, true);
    } finally {
      setBusy(false);
    }
  });

  async function runLote(acao) {
    const ids = selectedIds();
    if (!ids.length) return;
    try {
      setBusy(true, 'Aplicando ação em lote…');
      const data = await api('/api/biblioteca/agenda/lote', {
        method: 'POST',
        body: JSON.stringify({ ids, acao }),
      });
      const fail = data.erros?.length || 0;
      setMsg(`${data.ok || 0} ok` + (fail ? `, ${fail} erro(s)` : ''), fail > 0);
      if (acao === 'excluir') {
        const falhas = new Set((data.erros || []).map((e) => Number(e.id)));
        const removidos = ids.filter((id) => !falhas.has(Number(id)));
        applyAgendaAposExcluir(removidos, data.itens);
      } else {
        reloadAgenda();
      }
    } catch (err) {
      setMsg(err.message, true);
    } finally {
      setBusy(false);
    }
  }

  btnLoteConfirmar?.addEventListener('click', () => runLote('confirmar'));
  btnLotePublicar?.addEventListener('click', () => runLote('publicar'));
  btnLoteExcluir?.addEventListener('click', () => runLote('excluir'));

  listEl?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-id]');
    if (!btn) return;
    const isAgendaAction =
      btn.classList.contains('agenda-btn-confirmar') ||
      btn.classList.contains('agenda-btn-publicar') ||
      btn.classList.contains('agenda-btn-excluir');
    if (!isAgendaAction) return;
    const id = Number(btn.dataset.id);
    if (!id) return;

    try {
      if (btn.classList.contains('agenda-btn-confirmar')) {
        setBusy(true, 'Confirmando agendamento…');
        await api('/api/biblioteca/agenda/' + id + '/confirmar', { method: 'POST', body: '{}' });
        reloadAgenda();
      } else if (btn.classList.contains('agenda-btn-publicar')) {
        setBusy(true, 'Publicando…');
        await api('/api/biblioteca/agenda/' + id + '/publicar', { method: 'POST', body: '{}' });
        reloadAgenda();
      } else if (btn.classList.contains('agenda-btn-excluir')) {
        setBusy(true, 'Excluindo…');
        const data = await api('/api/biblioteca/agenda/' + id, { method: 'DELETE' });
        applyAgendaAposExcluir([id], data.itens);
        setMsg('Item excluído. Horários reorganizados de 30 em 30.', false);
      }
    } catch (err) {
      alert(err.message);
    } finally {
      setBusy(false);
    }
  });

  let horaTimer = null;

  /** datetime-local no fuso America/Araguaina (UTC−3). */
  function nowLocalMin() {
    const ms = Date.now() - 3 * 60 * 60 * 1000;
    const x = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return (
      x.getUTCFullYear() +
      '-' +
      pad(x.getUTCMonth() + 1) +
      '-' +
      pad(x.getUTCDate()) +
      'T' +
      pad(x.getUTCHours()) +
      ':' +
      pad(x.getUTCMinutes())
    );
  }

  function applyMinToHoraInputs() {
    const min = nowLocalMin();
    document.querySelectorAll('.agenda-hora').forEach((input) => {
      input.min = min;
    });
  }

  function setHoraStatus(id, text, isError) {
    const el = listEl?.querySelector('.agenda-hora-status[data-id="' + id + '"]');
    if (!el) return;
    el.textContent = text || '';
    el.className =
      'agenda-hora-status text-[10px] ' + (isError ? 'text-rose-300' : 'text-emerald-300/90');
  }

  applyMinToHoraInputs();
  // Atualiza o mínimo a cada minuto (evita escolher horário que acabou de passar)
  setInterval(applyMinToHoraInputs, 60_000);

  listEl?.addEventListener('change', async (e) => {
    const input = e.target.closest('.agenda-hora');
    if (!input) return;
    const id = Number(input.dataset.id);
    const value = input.value;
    if (!id || !value) return;

    applyMinToHoraInputs();
    if (input.min && value < input.min) {
      setHoraStatus(id, 'Horário no passado — escolha outra data/hora', true);
      // Não força "agora" no campo (isso confundia com o horário salvo)
      return;
    }

    clearTimeout(horaTimer);
    setHoraStatus(id, 'Salvando…');
    horaTimer = setTimeout(async () => {
      try {
        await api('/api/biblioteca/agenda/' + id, {
          method: 'PATCH',
          body: JSON.stringify({ proposed_at: value }),
        });
        const badge = listEl?.querySelector('.agenda-hora-badge[data-id="' + id + '"]');
        if (badge) badge.textContent = String(value).slice(11, 16);
        setHoraStatus(id, 'Horário atualizado ✓');
      } catch (err) {
        setHoraStatus(id, err.message, true);
        alert(err.message);
      }
    }, 400);
  });

  /* ——— Título + imagem (mesmas APIs de /materias-ia) ——— */
  const tituloSugestoesPorMatter = {};

  function setArteStatus(matterId, text, isError) {
    const el = listEl?.querySelector('.agenda-arte-status[data-matter-id="' + matterId + '"]');
    if (!el) return;
    el.textContent = text || '';
    el.className =
      'agenda-arte-status text-[10px] ' + (isError ? 'text-rose-300' : 'text-emerald-300/90');
  }

  function cacheBust(url) {
    if (!url) return url;
    const sep = url.includes('?') ? '&' : '?';
    return url + sep + 't=' + Date.now();
  }

  function updateRowArt(matterId, { titulo, imagemUrl } = {}) {
    const mid = String(matterId);
    if (titulo != null) {
      const label = listEl.querySelector('.agenda-titulo-label[data-matter-id="' + mid + '"]');
      const input = listEl.querySelector('.agenda-titulo-input[data-matter-id="' + mid + '"]');
      if (label) label.textContent = titulo;
      if (input && document.activeElement !== input) input.value = titulo;
    }
    if (imagemUrl) {
      const bust = cacheBust(imagemUrl);
      const row = listEl.querySelector('.agenda-row[data-matter-id="' + mid + '"]');
      if (!row) return;
      let img = row.querySelector('img.agenda-thumb');
      const empty = row.querySelector('.agenda-thumb-empty');
      if (img) {
        img.src = bust;
      } else if (empty) {
        img = document.createElement('img');
        img.className =
          'agenda-thumb h-14 w-14 shrink-0 rounded-lg object-cover ring-1 ring-slate-700';
        img.alt = '';
        img.dataset.matterId = mid;
        img.src = bust;
        empty.replaceWith(img);
      }
    }
  }

  function suggestCacheKey(matterId) {
    return 'agenda-img-suggest:' + matterId;
  }

  function saveSuggestCache(matterId, data) {
    try {
      sessionStorage.setItem(
        suggestCacheKey(matterId),
        JSON.stringify({
          aviso: data.aviso || null,
          pessoa: data.pessoa || null,
          imagens: data.imagens || [],
        })
      );
    } catch {
      /* ignore */
    }
  }

  function loadSuggestCache(matterId) {
    try {
      const raw = sessionStorage.getItem(suggestCacheKey(matterId));
      if (!raw) return null;
      const data = JSON.parse(raw);
      return data?.imagens?.length ? data : null;
    } catch {
      return null;
    }
  }

  function renderSuggestStrip(matterId, data) {
    const mid = String(matterId);
    const strip = listEl.querySelector('.agenda-img-strip[data-matter-id="' + mid + '"]');
    const meta = listEl.querySelector('.agenda-img-meta[data-matter-id="' + mid + '"]');
    const imgs = data.imagens || [];
    if (!window.__AGENDA_IMG_SUGESTOES__) window.__AGENDA_IMG_SUGESTOES__ = {};
    window.__AGENDA_IMG_SUGESTOES__[mid] = imgs;

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
        return (
          '<button type="button" data-agenda-suggest="' +
          mid +
          '" data-suggest-idx="' +
          i +
          '" title="' +
          String(img.titulo || '').replace(/"/g, '&quot;') +
          '" class="relative shrink-0 overflow-hidden rounded-md border bg-slate-950 focus:outline-none focus:ring-1 focus:ring-violet-400 ' +
          border +
          '" style="width:48px;height:64px;padding:0;flex:0 0 48px">' +
          '<img src="' +
          thumb +
          '" alt="" loading="lazy" decoding="async" style="width:100%;height:100%;object-fit:cover;display:block" />' +
          '<span class="absolute bottom-0 left-0 right-0 bg-black/75 py-px text-center text-[8px] leading-tight text-slate-200">' +
          label +
          '</span></button>'
        );
      })
      .join('');
  }

  async function carregarSugestoesImagem(matterId, { force } = {}) {
    const mid = String(matterId);
    if (!force) {
      const cached = loadSuggestCache(mid);
      if (cached) {
        renderSuggestStrip(mid, cached);
        return;
      }
    }
    const meta = listEl.querySelector('.agenda-img-meta[data-matter-id="' + mid + '"]');
    if (meta) meta.textContent = 'Buscando fotos relacionadas…';
    setArteStatus(mid, 'Buscando fotos (Brave / Serper)…');
    const data = await api('/api/materias-ia/matters/' + mid + '/sugerir-imagens', {
      method: 'POST',
      body: '{}',
    });
    saveSuggestCache(mid, data);
    renderSuggestStrip(mid, data);
    setArteStatus(mid, (data.imagens || []).length + ' sugestões — clique numa miniatura');
  }

  async function aplicarImagemSugerida(matterId, chosen) {
    const mid = String(matterId);
    if (!chosen?.url) return;
    const titulo =
      listEl.querySelector('.agenda-titulo-input[data-matter-id="' + mid + '"]')?.value || '';
    setArteStatus(mid, 'Alterando a arte…');
    setBusy(true, 'Gerando arte com o novo título/imagem…');
    try {
      const data = await api('/api/materias-ia/matters/' + mid + '/aplicar-imagem-url', {
        method: 'POST',
        body: JSON.stringify({
          imageUrl: chosen.url,
          titulo,
          autor: chosen.autor || null,
          fonte: chosen.fonte || null,
          imagemTitulo: chosen.titulo || null,
          origem: chosen.origem || null,
        }),
      });
      updateRowArt(mid, { imagemUrl: data.imagemUrl });
      setArteStatus(mid, 'Arte atualizada ✓');
    } finally {
      setBusy(false);
    }
  }

  listEl?.addEventListener('toggle', (e) => {
    const details = e.target.closest('details.agenda-arte');
    if (!details || !details.open) return;
    const row = details.closest('.agenda-row');
    const matterId = row?.dataset?.matterId;
    if (!matterId) return;
    carregarSugestoesImagem(matterId, { force: false }).catch((err) => {
      setArteStatus(matterId, err.message, true);
    });
  }, true);

  listEl?.addEventListener('click', async (e) => {
    const suggestBtn = e.target.closest('[data-agenda-suggest]');
    if (suggestBtn) {
      const mid = suggestBtn.dataset.agendaSuggest;
      const idx = Number(suggestBtn.dataset.suggestIdx);
      const chosen = (window.__AGENDA_IMG_SUGESTOES__?.[mid] || [])[idx];
      try {
        await aplicarImagemSugerida(mid, chosen);
      } catch (err) {
        setArteStatus(mid, err.message, true);
        alert(err.message);
      }
      return;
    }

    const btnTitulo = e.target.closest('.agenda-btn-sugerir-titulo');
    if (btnTitulo) {
      const mid = btnTitulo.dataset.matterId;
      const tom =
        listEl.querySelector('.agenda-titulo-tom[data-matter-id="' + mid + '"]')?.value ||
        'natural';
      const input = listEl.querySelector('.agenda-titulo-input[data-matter-id="' + mid + '"]');
      const original = btnTitulo.textContent;
      btnTitulo.disabled = true;
      btnTitulo.textContent = 'Gerando…';
      setArteStatus(mid, 'A IA está sugerindo outro título…');
      setBusy(true, 'Sugerindo título e regenerando arte…');
      try {
        if (!tituloSugestoesPorMatter[mid]) tituloSugestoesPorMatter[mid] = [];
        const data = await api('/api/materias-ia/matters/' + mid + '/sugerir-titulo', {
          method: 'POST',
          body: JSON.stringify({
            tom,
            evitar: tituloSugestoesPorMatter[mid].slice(-8),
            tituloAtual: String(input?.value || '').trim(),
          }),
        });
        if (data.titulo) {
          tituloSugestoesPorMatter[mid].push(data.titulo);
          updateRowArt(mid, { titulo: data.titulo, imagemUrl: data.imagemUrl });
        }
        setArteStatus(
          mid,
          data.aviso ||
            (data.imagemUrl
              ? 'Novo título aplicado e arte atualizada ✓'
              : 'Novo título aplicado ✓')
        );
      } catch (err) {
        setArteStatus(mid, err.message, true);
        alert(err.message);
      } finally {
        btnTitulo.disabled = false;
        btnTitulo.textContent = original || 'Sugerir título';
        setBusy(false);
      }
      return;
    }

    const btnSalvar = e.target.closest('.agenda-btn-salvar-titulo');
    if (btnSalvar) {
      const mid = btnSalvar.dataset.matterId;
      const input = listEl.querySelector('.agenda-titulo-input[data-matter-id="' + mid + '"]');
      const titulo = String(input?.value || '').trim();
      if (!titulo) {
        setArteStatus(mid, 'Informe um título.', true);
        return;
      }
      const original = btnSalvar.textContent;
      btnSalvar.disabled = true;
      btnSalvar.textContent = 'Salvando…';
      setBusy(true, 'Salvando título e regenerando arte…');
      try {
        const data = await api('/api/materias-ia/matters/' + mid, {
          method: 'PATCH',
          body: JSON.stringify({ titulo }),
        });
        updateRowArt(mid, {
          titulo: data.matter?.titulo || titulo,
          imagemUrl: data.imagemUrl,
        });
        setArteStatus(
          mid,
          data.aviso ||
            (data.imagemUrl ? 'Título salvo e arte atualizada ✓' : 'Título salvo ✓')
        );
      } catch (err) {
        setArteStatus(mid, err.message, true);
        alert(err.message);
      } finally {
        btnSalvar.disabled = false;
        btnSalvar.textContent = original || 'Salvar título';
        setBusy(false);
      }
      return;
    }

    const btnBuscar = e.target.closest('.agenda-btn-buscar-imgs');
    if (btnBuscar) {
      const mid = btnBuscar.dataset.matterId;
      const original = btnBuscar.textContent;
      btnBuscar.disabled = true;
      btnBuscar.textContent = 'Buscando…';
      try {
        await carregarSugestoesImagem(mid, { force: true });
      } catch (err) {
        setArteStatus(mid, err.message, true);
        alert(err.message);
      } finally {
        btnBuscar.disabled = false;
        btnBuscar.textContent = original || 'Buscar fotos (Brave / Serper)';
      }
    }
  });

  syncLoteButtons();
  if (countEl && listEl) {
    const n = listEl.querySelectorAll('.agenda-row').length;
    countEl.textContent = '(' + n + ')';
  }
})();
