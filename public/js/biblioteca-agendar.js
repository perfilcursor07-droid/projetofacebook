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

  function reloadAgenda(forceAba) {
    const params = new URLSearchParams(location.search);
    const next =
      forceAba ||
      (abaAtual === 'publicadas'
        ? 'publicadas'
        : abaAtual === 'viralizadas'
          ? 'viralizadas'
          : 'agendada');
    params.set('aba', next);
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
        const btn = row.querySelector('.agenda-hora-btn');
        if (btn) {
          btn.dataset.value = local;
          const label = btn.querySelector('.agenda-hora-label');
          if (label) {
            label.textContent =
              local.slice(8, 10) + '/' + local.slice(5, 7) + ' ' + local.slice(11, 16);
          }
        }
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
    const dia = document.getElementById('agenda-dia')?.value === 'hoje' ? 'hoje' : 'amanha';
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
          : `Montando agenda de ${dia === 'hoje' ? 'hoje' : 'amanhã'} (pode demorar se for gerar várias matérias)…`
      );
      setMsg('');
      const data = await api('/api/biblioteca/agenda/montar', {
        method: 'POST',
        body: JSON.stringify({
          facebook_page_id: page,
          max_itens: max,
          somente_sites: true,
          usar_keywords: usarKeywords,
          dia,
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
      const limpezaHint =
        data.removidosSemKw > 0 ? ` Removidos ${data.removidosSemKw} fora do filtro.` : '';
      setMsg(
        (data.mensagem
          ? data.mensagem
          : `${data.criados || 0} item(ns) pré-agendado(s)${kwHint}${cont}` +
            (de && ate ? `: ${de} → ${ate}` : data.dia ? ` para ${data.dia}` : '') +
            '.') +
          limpezaHint +
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

  const agendaDia = document.getElementById('agenda-dia');
  const agendaBtnMontar = document.getElementById('agenda-btn-montar');
  const atualizarTextoBotaoDia = () => {
    if (agendaBtnMontar) {
      agendaBtnMontar.textContent =
        agendaDia?.value === 'hoje' ? 'Montar agenda de hoje' : 'Montar agenda de amanhã';
    }
  };
  agendaDia?.addEventListener('change', atualizarTextoBotaoDia);
  atualizarTextoBotaoDia();

  document.getElementById('agenda-btn-limpar-kw')?.addEventListener('click', async () => {
    if (
      !confirm(
        'Remover da agenda todos os itens pré-agendados que NÃO batem nas suas palavras-chave?'
      )
    ) {
      return;
    }
    try {
      setBusy(true, 'Removendo itens fora das palavras-chave…');
      setMsg('');
      const data = await api('/api/biblioteca/agenda/limpar-sem-keyword', {
        method: 'POST',
        body: '{}',
      });
      setMsg(data.mensagem || `${data.removidos || 0} removido(s).`, false);
      setTimeout(() => {
        window.location.href = '/biblioteca/agendar?aba=agendada&t=' + Date.now();
      }, 400);
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
    // Não intercepta o botão de horário (tem data-id, mas não é ação de agenda)
    if (e.target.closest('.agenda-hora-btn')) return;
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

  /** datetime no fuso America/Araguaina (UTC−3). */
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

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function formatHoraLabel(value) {
    const v = String(value || '').slice(0, 16);
    if (v.length < 16) return '--/-- --:--';
    return v.slice(8, 10) + '/' + v.slice(5, 7) + ' ' + v.slice(11, 16);
  }

  function setHoraStatus(id, text, isError) {
    const el = listEl?.querySelector('.agenda-hora-status[data-id="' + id + '"]');
    if (!el) return;
    el.textContent = text || '';
    el.className =
      'agenda-hora-status text-[10px] ' +
      (text ? '' : 'hidden ') +
      (isError ? 'text-rose-300' : 'text-emerald-300/90');
  }

  function syncHoraBtn(id, value) {
    const btn = listEl?.querySelector('.agenda-hora-btn[data-id="' + id + '"]');
    if (btn) {
      btn.dataset.value = value;
      const label = btn.querySelector('.agenda-hora-label');
      if (label) label.textContent = formatHoraLabel(value);
    }
    const badge = listEl?.querySelector('.agenda-hora-badge[data-id="' + id + '"]');
    if (badge) badge.textContent = String(value).slice(11, 16);
  }

  async function salvarHorarioAgenda(id, value) {
    const min = nowLocalMin();
    if (value < min) {
      setHoraStatus(id, 'Horário no passado — escolha outra data/hora', true);
      return false;
    }
    setHoraStatus(id, 'Salvando…');
    try {
      await api('/api/biblioteca/agenda/' + id, {
        method: 'PATCH',
        body: JSON.stringify({ proposed_at: value }),
      });
      syncHoraBtn(id, value);
      setHoraStatus(id, 'Horário atualizado ✓');
      return true;
    } catch (err) {
      setHoraStatus(id, err.message, true);
      alert(err.message);
      return false;
    }
  }

  /* ——— Seletor próprio de data/hora (com OK) ——— */
  const pickerEl = document.getElementById('agenda-hora-picker');
  const ahpDate = document.getElementById('ahp-date');
  const ahpHour = document.getElementById('ahp-hour');
  const ahpMin = document.getElementById('ahp-min');
  const ahpOk = document.getElementById('ahp-ok');
  const ahpCancel = document.getElementById('ahp-cancel');
  let pickerTargetId = null;
  let pickerAnchorBtn = null;

  function fillHourMinSelects() {
    if (!ahpHour || ahpHour.options.length) return;
    for (let h = 0; h < 24; h += 1) {
      const opt = document.createElement('option');
      opt.value = pad2(h);
      opt.textContent = pad2(h);
      ahpHour.appendChild(opt);
    }
    for (let m = 0; m < 60; m += 5) {
      const opt = document.createElement('option');
      opt.value = pad2(m);
      opt.textContent = pad2(m);
      ahpMin.appendChild(opt);
    }
  }

  function closeHoraPicker() {
    if (!pickerEl) return;
    pickerEl.classList.add('hidden');
    pickerTargetId = null;
    pickerAnchorBtn = null;
  }

  function positionHoraPicker(anchor) {
    if (!pickerEl || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    const width = pickerEl.offsetWidth || 296;
    const height = pickerEl.offsetHeight || 220;
    let left = rect.left;
    let top = rect.bottom + 6;
    if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
    if (left < 8) left = 8;
    if (top + height > window.innerHeight - 8) {
      top = Math.max(8, rect.top - height - 6);
    }
    pickerEl.style.left = left + 'px';
    pickerEl.style.top = top + 'px';
  }

  function openHoraPicker(btn) {
    if (!pickerEl || !ahpDate || !ahpHour || !ahpMin) return;
    fillHourMinSelects();
    pickerTargetId = Number(btn.dataset.id);
    pickerAnchorBtn = btn;
    const value = String(btn.dataset.value || nowLocalMin()).slice(0, 16);
    const day = value.slice(0, 10);
    let hour = value.slice(11, 13);
    let min = value.slice(14, 16);
    // Arredonda minutos para o passo de 5
    const minN = Math.round(Number(min || 0) / 5) * 5;
    min = pad2(minN >= 60 ? 55 : minN);

    ahpDate.value = day;
    ahpHour.value = hour;
    if (![...ahpHour.options].some((o) => o.value === hour)) ahpHour.value = '08';
    ahpMin.value = min;
    if (![...ahpMin.options].some((o) => o.value === min)) ahpMin.value = '00';

    pickerEl.classList.remove('hidden');
    positionHoraPicker(btn);
  }

  listEl?.addEventListener('click', (e) => {
    const btn = e.target.closest('.agenda-hora-btn');
    if (!btn || btn.disabled) return;
    e.preventDefault();
    e.stopPropagation();
    if (pickerTargetId && Number(btn.dataset.id) === pickerTargetId && !pickerEl?.classList.contains('hidden')) {
      closeHoraPicker();
      return;
    }
    openHoraPicker(btn);
  });

  ahpCancel?.addEventListener('click', (e) => {
    e.preventDefault();
    closeHoraPicker();
  });

  ahpOk?.addEventListener('click', async (e) => {
    e.preventDefault();
    const id = pickerTargetId;
    if (!id || !ahpDate?.value) return;
    const value = ahpDate.value + 'T' + (ahpHour?.value || '00') + ':' + (ahpMin?.value || '00');
    ahpOk.disabled = true;
    ahpOk.textContent = '…';
    try {
      const ok = await salvarHorarioAgenda(id, value);
      if (ok) closeHoraPicker();
    } finally {
      ahpOk.disabled = false;
      ahpOk.textContent = 'OK';
    }
  });

  document.addEventListener('keydown', (e) => {
    if (!pickerEl || pickerEl.classList.contains('hidden')) return;
    if (e.key === 'Escape') {
      closeHoraPicker();
      return;
    }
    if (e.key === 'Enter' && e.target && pickerEl.contains(e.target)) {
      e.preventDefault();
      ahpOk?.click();
    }
  });

  document.addEventListener('mousedown', (e) => {
    if (!pickerEl || pickerEl.classList.contains('hidden')) return;
    if (pickerEl.contains(e.target)) return;
    if (e.target.closest?.('.agenda-hora-btn')) return;
    closeHoraPicker();
  });

  window.addEventListener(
    'scroll',
    () => {
      if (pickerAnchorBtn && pickerEl && !pickerEl.classList.contains('hidden')) {
        positionHoraPicker(pickerAnchorBtn);
      }
    },
    true
  );
  window.addEventListener('resize', () => {
    if (pickerAnchorBtn && pickerEl && !pickerEl.classList.contains('hidden')) {
      positionHoraPicker(pickerAnchorBtn);
    }
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

  // Aba Viralizadas: reescreve (anti-plágio + marca) e pré-agenda
  document.getElementById('agenda-viral-list')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('.viral-btn-agendar');
    if (!btn) return;
    const row = btn.closest('.viral-row');
    const id = btn.dataset.id || row?.dataset.matterId;
    if (!id) return;
    const page = row?.querySelector('.viral-page')?.value || '';
    const hora = row?.querySelector('.viral-hora')?.value || '';
    if (!page) {
      setMsg('Selecione a Página de destino.', true);
      return;
    }
    const old = btn.textContent;
    btn.disabled = true;
    try {
      setBusy(true, 'Reescrevendo no estilo da sua marca (sem plagiar) e pré-agendando…');
      setMsg('');
      const data = await api('/api/biblioteca/agenda/viralizadas/' + id, {
        method: 'POST',
        body: JSON.stringify({
          facebook_page_id: page,
          proposed_at: hora || null,
        }),
      });
      setBusy(false);
      setMsg(
        'Variação pronta' +
          (data.titulo ? ': “' + data.titulo + '”' : '') +
          ' — foi para Agendada. Confirme o horário quando quiser.',
        false
      );
      setTimeout(() => reloadAgenda('agendada'), 900);
    } catch (err) {
      setBusy(false);
      btn.disabled = false;
      btn.textContent = old;
      setMsg(err.message || 'Falha ao agendar viralizada', true);
      alert(err.message || 'Falha ao agendar viralizada');
    }
  });

  syncLoteButtons();
  if (countEl && listEl) {
    const n = listEl.querySelectorAll('.agenda-row').length;
    countEl.textContent = '(' + n + ')';
  }
})();
