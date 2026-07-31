(function initClipEdit() {
  const cfg = window.__CLIP_EDIT__;
  if (!cfg?.id || !cfg.canEdit) return;

  /* —— Abas: Matéria | Layout do Reel | Áudio —— */
  const TAB_STYLES = {
    on: 'corte-tab-btn rounded-xl bg-violet-500 px-3.5 py-2 text-xs font-semibold text-white sm:px-4',
    off: 'corte-tab-btn rounded-xl px-3.5 py-2 text-xs font-medium text-slate-400 hover:text-white sm:px-4',
  };
  // Layout usa fuchsia quando ativa
  const TAB_ON = {
    materia: 'corte-tab-btn rounded-xl bg-violet-500 px-3.5 py-2 text-xs font-semibold text-white sm:px-4',
    layout: 'corte-tab-btn rounded-xl bg-fuchsia-500 px-3.5 py-2 text-xs font-semibold text-white sm:px-4',
    audio: 'corte-tab-btn rounded-xl bg-sky-500 px-3.5 py-2 text-xs font-semibold text-white sm:px-4',
  };

  function setCorteTab(tabId) {
    const id = ['materia', 'layout', 'audio'].includes(tabId) ? tabId : 'materia';
    document.querySelectorAll('[data-corte-tab-panel]').forEach((panel) => {
      const on = panel.getAttribute('data-corte-tab-panel') === id;
      if (on) panel.removeAttribute('hidden');
      else panel.setAttribute('hidden', '');
    });
    document.querySelectorAll('[data-corte-tab-btn]').forEach((btn) => {
      const key = btn.getAttribute('data-corte-tab-btn');
      const on = key === id;
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
      btn.className = on ? TAB_ON[key] || TAB_STYLES.on : TAB_STYLES.off;
    });
    try {
      const url = new URL(window.location.href);
      if (id === 'materia') url.hash = '';
      else url.hash = id;
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    } catch {
      /* ignore */
    }
  }

  document.getElementById('corte-tabs')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-corte-tab-btn]');
    if (!btn) return;
    setCorteTab(btn.getAttribute('data-corte-tab-btn'));
  });

  const hashTab = String(window.location.hash || '')
    .replace(/^#/, '')
    .toLowerCase();
  const initialTab =
    hashTab === 'layout' || hashTab === 'audio' || hashTab === 'materia'
      ? hashTab
      : cfg.splitAtivo || cfg.splitStatus === 'gerando'
        ? 'layout'
        : 'materia';
  setCorteTab(initialTab);

  const statusEl = document.getElementById('clip-status');
  const pageSelect = document.getElementById('clip-page');
  const materiaEl = document.getElementById('clip-materia');
  const temaEl = document.getElementById('clip-tema');
  const capaTituloEl = document.getElementById('clip-capa-titulo');
  const capaAtivaEl = document.getElementById('clip-capa-ativa');
  const capaStatusLabel = document.getElementById('capa-status-label');
  const capaTomEl = document.getElementById('clip-capa-tom');
  const btnCapaSugerir = document.getElementById('btn-capa-sugerir-titulo');
  const modoEl = document.getElementById('clip-modo');
  const videoEl = document.getElementById('clip-video');
  const btnMateria = document.getElementById('btn-materia');
  const btnCapa = document.getElementById('btn-capa');
  const tituloCapaEvitar = [];

  // Estado local — nunca recarrega a página inteira enquanto o usuário edita.
  const state = {
    materiaStatus: cfg.materiaStatus || '',
    capaStatus: cfg.capaStatus || '',
    splitStatus: cfg.splitStatus || '',
    splitAtivo: Boolean(cfg.splitAtivo),
    videoUrl: videoEl?.getAttribute('src') || '',
    splitImagemUrl: cfg.splitImagemUrl || '',
    materiaSnapshot: String(materiaEl?.value || ''),
    pollTimer: null,
    polling: false,
  };

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

  function mediaUrlComCache(url) {
    if (!url) return '';
    const base = String(url).split('?')[0];
    return base + '?t=' + Date.now();
  }

  /** Troca só o src do player — sem mexer no resto da página. */
  function atualizarVideoPrincipal(url, opts = {}) {
    if (!videoEl || !url) return;
    const atual = String(videoEl.getAttribute('src') || '').split('?')[0];
    const nova = String(url).split('?')[0];
    const force = Boolean(opts.force);
    if (!force && atual === nova && state.videoUrl && state.videoUrl.split('?')[0] === nova) return;
    const wasPaused = videoEl.paused;
    const t = force ? 0 : videoEl.currentTime || 0;
    videoEl.src = mediaUrlComCache(url);
    state.videoUrl = url;
    videoEl.addEventListener(
      'loadedmetadata',
      () => {
        try {
          if (t > 0 && t < (videoEl.duration || Infinity)) videoEl.currentTime = t;
          else videoEl.currentTime = 0;
        } catch {
          /* ignore */
        }
        if (!wasPaused && !force) videoEl.play().catch(() => {});
      },
      { once: true }
    );
  }

  function setBadgeSplit(ativo, gerando) {
    const header = document.querySelector('main .flex.flex-wrap.items-start .flex.flex-wrap.items-center.gap-2');
    if (!header) return;
    header.querySelectorAll('[data-live-badge]').forEach((el) => el.remove());
    if (gerando) {
      const span = document.createElement('span');
      span.dataset.liveBadge = '1';
      span.className = 'rounded-full bg-amber-500/15 px-2.5 py-0.5 font-medium text-amber-200';
      span.textContent = 'Montando tela…';
      header.appendChild(span);
    } else if (ativo) {
      const span = document.createElement('span');
      span.dataset.liveBadge = '1';
      span.className = 'rounded-full bg-fuchsia-500/15 px-2.5 py-0.5 font-medium text-fuchsia-300';
      span.textContent = 'Tela dividida';
      header.appendChild(span);
    }
  }

  function atualizarUiSplit(data) {
    const aplicarBtn = document.getElementById('btn-split-aplicar');
    const msgEl = document.getElementById('split-msg');
    const imgPreview = document.getElementById('split-img-preview');
    const imgEmpty = document.getElementById('split-img-empty');
    const badgeGerando = document.querySelector('#split-panel [data-split-live-status]');

    const gerando = data.split_status === 'gerando';
    const ativo = data.layout === 'split' || data.split_status === 'pronta';

    if (badgeGerando) {
      badgeGerando.textContent = gerando ? 'Montando…' : ativo ? 'Ativa' : '';
      badgeGerando.className = gerando
        ? 'rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-200'
        : ativo
          ? 'rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-300'
          : 'hidden';
      badgeGerando.classList.toggle('hidden', !gerando && !ativo);
    }

    setBadgeSplit(ativo, gerando);

    if (data.split_imagem_url && imgPreview) {
      const atual = String(imgPreview.getAttribute('src') || '').split('?')[0];
      const nova = String(data.split_imagem_url).split('?')[0];
      if (atual !== nova) {
        imgPreview.src = data.split_imagem_url;
        imgPreview.classList.remove('hidden');
        imgEmpty?.classList.add('hidden');
      }
      state.splitImagemUrl = data.split_imagem_url;
    }

    if (aplicarBtn) {
      aplicarBtn.disabled = gerando;
      aplicarBtn.textContent = gerando
        ? 'Montando…'
        : ativo
          ? 'Atualizar tela dividida'
          : 'Aplicar tela dividida';
    }

    const enquadrarBtn = document.getElementById('btn-split-enquadrar');
    if (enquadrarBtn) enquadrarBtn.disabled = gerando;

    if (msgEl) {
      if (gerando) {
        msgEl.textContent = 'Montando a tela dividida — só o vídeo atualiza quando ficar pronto.';
        msgEl.className = 'text-[11px] text-amber-300';
      } else if (data.split_status === 'erro') {
        msgEl.textContent = data.split_erro || 'Falha na tela dividida.';
        msgEl.className = 'text-[11px] text-rose-300';
      } else if (data.split_status === 'pronta' && state.splitStatus === 'gerando') {
        msgEl.textContent = 'Tela dividida pronta.';
        msgEl.className = 'text-[11px] text-emerald-400';
      }
    }
  }

  function atualizarMateriaSeSeguro(data) {
    if (!materiaEl) return;
    const nova = String(data.materia || '').trim();
    if (!nova) return;
    // Só preenche se o campo ainda está igual ao que veio do servidor
    // (o usuário não digitou por cima) ou se estava vazio.
    const atual = String(materiaEl.value || '');
    if (!atual.trim() || atual === state.materiaSnapshot) {
      materiaEl.value = nova;
      state.materiaSnapshot = nova;
    }
    if (btnMateria && data.materia_status === 'pronta') {
      btnMateria.textContent = 'Refazer matéria';
    }
  }

  function syncCapaUi(status) {
    const pronta = status === 'pronta';
    const gerando = status === 'gerando';
    if (capaAtivaEl && document.activeElement !== capaAtivaEl) {
      capaAtivaEl.checked = pronta;
    }
    if (btnCapa) {
      btnCapa.textContent = gerando ? 'Gerando…' : pronta ? 'Refazer capa' : 'Gerar capa';
      btnCapa.disabled = gerando;
    }
    if (capaStatusLabel) {
      capaStatusLabel.textContent = gerando
        ? 'Gerando capa…'
        : pronta
          ? 'Capa ativa no vídeo'
          : 'Sem capa';
      capaStatusLabel.className =
        'text-[11px] ' + (pronta ? 'text-emerald-300' : gerando ? 'text-amber-300' : 'text-slate-600');
    }
  }

  function atualizarCapaTituloSeSeguro(data) {
    if (!capaTituloEl) return;
    const novo = String(data.capa_titulo || '').trim();
    if (novo && !capaTituloEl.value.trim()) capaTituloEl.value = novo;
    syncCapaUi(data.capa_status || state.capaStatus);
  }

  function aindaGerando() {
    return (
      state.materiaStatus === 'gerando' ||
      state.capaStatus === 'gerando' ||
      state.splitStatus === 'gerando'
    );
  }

  function pararPoll() {
    if (state.pollTimer) {
      clearTimeout(state.pollTimer);
      state.pollTimer = null;
    }
    state.polling = false;
  }

  function agendarPoll(ms) {
    pararPoll();
    state.polling = true;
    state.pollTimer = setTimeout(pollStatus, ms);
  }

  async function pollStatus() {
    state.pollTimer = null;
    try {
      const res = await fetch('/api/clips/' + cfg.id + '/status', { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Falha ao consultar status');

      const prevSplit = state.splitStatus;
      const prevCapa = state.capaStatus;
      const prevMateria = state.materiaStatus;

      state.materiaStatus = data.materia_status || '';
      state.capaStatus = data.capa_status || '';
      state.splitStatus = data.split_status || '';
      state.splitAtivo = data.layout === 'split' || data.split_status === 'pronta';

      // Só o vídeo (e badges/msgs da tela dividida) — página permanece editável.
      // Com capa desmarcada, nunca aceitar URL de arquivo `_capa_` no preview.
      if (data.video_url) {
        const capaOff = String(data.capa_status || '') !== 'pronta';
        const urlCapa = /_capa_/i.test(String(data.video_url));
        if (!(capaOff && urlCapa)) {
          atualizarVideoPrincipal(data.video_url);
        }
      }
      atualizarUiSplit(data);

      if (data.materia_status === 'pronta' && prevMateria === 'gerando') {
        atualizarMateriaSeSeguro(data);
        setStatus('Matéria pronta.');
      }
      if (data.capa_status === 'pronta' && prevCapa === 'gerando') {
        atualizarCapaTituloSeSeguro(data);
        setStatus('Capa pronta — vídeo atualizado.');
      } else if (data.capa_status && data.capa_status !== prevCapa) {
        syncCapaUi(data.capa_status);
      }
      if (data.split_status === 'pronta' && prevSplit === 'gerando') {
        setStatus('Tela dividida pronta — vídeo atualizado.');
      }
      if (data.split_status === 'erro') {
        setStatus(data.split_erro || 'Falha na tela dividida.', true);
      }
      if (data.capa_status === 'erro' && data.erro_mensagem) {
        setStatus(data.erro_mensagem, true);
      }
      if (data.materia_status === 'erro' && data.erro_mensagem) {
        setStatus(data.erro_mensagem, true);
      }

      if (aindaGerando()) {
        if (!statusEl?.textContent || /gerando|montando|aguarde/i.test(statusEl.textContent)) {
          const partes = [];
          if (state.splitStatus === 'gerando') partes.push('tela dividida');
          if (state.capaStatus === 'gerando') partes.push('capa');
          if (state.materiaStatus === 'gerando') partes.push('matéria');
          setStatus('Gerando ' + (partes.join(' · ') || 'conteúdo') + '… (a página não recarrega)');
        }
        agendarPoll(2500);
        return;
      }

      state.polling = false;
    } catch (err) {
      console.warn('[clip-edit] poll:', err.message);
      if (aindaGerando()) agendarPoll(4000);
      else state.polling = false;
    }
  }

  function iniciarPollSePreciso() {
    if (aindaGerando() && !state.polling) {
      setStatus('Aguarde: gerando conteúdo… (só o vídeo atualiza)');
      agendarPoll(1500);
    }
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

  btnMateria?.addEventListener('click', async () => {
    setStatus('Gerando matéria…');
    state.materiaStatus = 'gerando';
    state.materiaSnapshot = String(materiaEl?.value || '');
    try {
      await postJson('/api/clips/' + cfg.id + '/materia', {
        tema: temaEl ? temaEl.value.trim() : '',
      });
      setStatus('Matéria enfileirada — o texto atualiza sozinho quando ficar pronto.');
      iniciarPollSePreciso();
    } catch (err) {
      state.materiaStatus = '';
      setStatus(err.message, true);
    }
  });

  btnCapa?.addEventListener('click', async () => {
    if (capaAtivaEl) capaAtivaEl.checked = true;
    setStatus('Gerando capa…');
    state.capaStatus = 'gerando';
    syncCapaUi('gerando');
    try {
      await postJson('/api/clips/' + cfg.id + '/capa', {
        titulo: capaTituloEl ? capaTituloEl.value.trim() : '',
      });
      setStatus('Capa enfileirada — só o vídeo atualiza quando ficar pronta.');
      iniciarPollSePreciso();
    } catch (err) {
      state.capaStatus = '';
      syncCapaUi(state.capaStatus);
      setStatus(err.message, true);
    }
  });

  async function removerCapaDoVideo(opts = {}) {
    const silent = Boolean(opts.silent);
    const res = await fetch('/api/clips/' + cfg.id + '/capa', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: true }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Falha ao remover capa');
    state.capaStatus = 'pendente';
    syncCapaUi('pendente');
    if (data.video_url) atualizarVideoPrincipal(data.video_url, { force: true });
    if (!silent) setStatus(data.message || 'Capa removida do vídeo.');
    agendarPoll(800);
  }

  capaAtivaEl?.addEventListener('change', async () => {
    if (capaAtivaEl.checked) {
      btnCapa?.click();
      return;
    }
    try {
      setStatus('Removendo capa do vídeo…');
      capaAtivaEl.disabled = true;
      await removerCapaDoVideo();
    } catch (err) {
      capaAtivaEl.checked = true;
      syncCapaUi(state.capaStatus === 'pronta' ? 'pronta' : 'pendente');
      setStatus(err.message, true);
    } finally {
      capaAtivaEl.disabled = false;
    }
  });

  // Ao abrir com capa desmarcada: força limpeza (capa embutida sem `_capa_` no nome).
  if (state.capaStatus !== 'pronta') {
    removerCapaDoVideo({ silent: true }).catch(() => {});
  }

  syncCapaUi(state.capaStatus);

  btnCapaSugerir?.addEventListener('click', async () => {
    const original = btnCapaSugerir.textContent;
    btnCapaSugerir.disabled = true;
    btnCapaSugerir.textContent = 'Gerando…';
    setStatus('IA sugerindo título da capa…');
    try {
      const atual = String(capaTituloEl?.value || '').trim();
      if (atual && !tituloCapaEvitar.includes(atual)) tituloCapaEvitar.push(atual);
      const data = await postJson('/api/clips/' + cfg.id + '/capa/sugerir-titulo', {
        tom: capaTomEl?.value || 'natural',
        titulo_atual: atual,
        evitar: tituloCapaEvitar.slice(-8),
      });
      if (capaTituloEl && data.titulo) {
        capaTituloEl.value = data.titulo;
        if (!tituloCapaEvitar.includes(data.titulo)) tituloCapaEvitar.push(data.titulo);
      }
      btnCapaSugerir.textContent = 'Outra sugestão';
      setStatus('Novo título sugerido — clique de novo se quiser outra opção.');
    } catch (err) {
      btnCapaSugerir.textContent = original;
      setStatus(err.message, true);
    } finally {
      btnCapaSugerir.disabled = false;
      if (btnCapaSugerir.textContent === 'Gerando…') btnCapaSugerir.textContent = original;
    }
  });

  // ——— Música de fundo ———
  const bgmPresetEl = document.getElementById('clip-bgm-preset');
  const bgmVolEl = document.getElementById('clip-bgm-volume');
  const bgmVolValor = document.getElementById('clip-bgm-vol-valor');
  const bgmDescEl = document.getElementById('clip-bgm-desc');
  const bgmBtn = document.getElementById('btn-bgm-aplicar');
  const bgmMsg = document.getElementById('clip-bgm-msg');
  const bgmPresetsMeta = Array.isArray(cfg.bgmPresets) ? cfg.bgmPresets : [];

  function syncBgmUi() {
    const preset = bgmPresetEl?.value || 'nenhuma';
    const meta = bgmPresetsMeta.find((p) => p.id === preset);
    if (bgmDescEl) bgmDescEl.textContent = meta?.description || '';
    if (bgmVolEl) bgmVolEl.disabled = preset === 'nenhuma';
    if (bgmBtn) {
      bgmBtn.textContent = preset === 'nenhuma' ? 'Remover música' : 'Aplicar música';
    }
  }

  bgmPresetEl?.addEventListener('change', syncBgmUi);
  bgmVolEl?.addEventListener('input', () => {
    if (bgmVolValor) bgmVolValor.textContent = String(bgmVolEl.value || '18');
  });
  syncBgmUi();

  bgmBtn?.addEventListener('click', async () => {
    const original = bgmBtn.textContent;
    bgmBtn.disabled = true;
    bgmBtn.textContent = 'Aplicando…';
    if (bgmMsg) {
      bgmMsg.textContent = 'Aplicando trilha (uns segundos)…';
      bgmMsg.className = 'mt-2 text-[11px] text-amber-300';
    }
    try {
      const data = await postJson('/api/clips/' + cfg.id + '/bgm', {
        preset: bgmPresetEl?.value || 'nenhuma',
        volume: Number(bgmVolEl?.value || 18),
      });
      if (data.video_url) atualizarVideoPrincipal(data.video_url);
      if (bgmMsg) {
        bgmMsg.textContent = data.message || 'Pronto.';
        bgmMsg.className = 'mt-2 text-[11px] text-emerald-400';
      }
      setStatus(data.message || 'Música atualizada.');
      syncBgmUi();
    } catch (err) {
      if (bgmMsg) {
        bgmMsg.textContent = err.message;
        bgmMsg.className = 'mt-2 text-[11px] text-rose-300';
      }
      setStatus(err.message, true);
    } finally {
      bgmBtn.disabled = false;
      bgmBtn.textContent = original;
      syncBgmUi();
    }
  });

  // ——— Velocidade do vídeo ———
  const speedRange = document.getElementById('clip-speed');
  const speedValor = document.getElementById('clip-speed-valor');
  const speedDurPrev = document.getElementById('clip-speed-dur-prev');
  const speedBtn = document.getElementById('btn-speed-aplicar');
  const speedMsg = document.getElementById('clip-speed-msg');
  const speedOpts = Array.isArray(cfg.speedOptions) && cfg.speedOptions.length
    ? cfg.speedOptions.map(Number)
    : String(speedRange?.dataset.options || '0.75,1,1.25,1.5,1.75,2,2.5,3')
        .split(',')
        .map(Number)
        .filter((n) => Number.isFinite(n));
  const durBaseSec = Number(cfg.durBase ?? speedRange?.dataset.durBase);
  let appliedSpeed = Number(cfg.playbackSpeed) || 1;

  function speedFromRange() {
    const idx = Math.max(0, Math.min(speedOpts.length - 1, Number(speedRange?.value) || 0));
    return speedOpts[idx] || 1;
  }

  function formatSpeedUi(s) {
    return Number.isInteger(s) ? s + 'x' : String(s) + 'x';
  }

  function syncSpeedPreview() {
    const s = speedFromRange();
    if (speedValor) speedValor.textContent = formatSpeedUi(s);
    if (speedDurPrev && Number.isFinite(durBaseSec) && durBaseSec > 0) {
      speedDurPrev.textContent = '~' + Math.max(1, Math.round(durBaseSec / s)) + 's';
    }
    const video = document.getElementById('clip-video');
    if (video) {
      const relative = s / (appliedSpeed || 1);
      video.playbackRate = Math.min(4, Math.max(0.25, relative));
    }
    if (speedBtn) {
      speedBtn.textContent =
        Math.abs(s - 1) < 0.001 ? 'Voltar para 1x' : 'Aplicar velocidade ' + formatSpeedUi(s);
    }
  }

  speedRange?.addEventListener('input', syncSpeedPreview);
  syncSpeedPreview();

  speedBtn?.addEventListener('click', async () => {
    const s = speedFromRange();
    const original = speedBtn.textContent;
    speedBtn.disabled = true;
    speedBtn.textContent = 'Aplicando…';
    if (speedMsg) {
      speedMsg.textContent = 'Reprocessando o vídeo na nova velocidade…';
      speedMsg.className = 'text-[11px] text-sky-300';
    }
    try {
      const data = await postJson('/api/clips/' + cfg.id + '/velocidade', { speed: s });
      appliedSpeed = Number(data.speed) || s;
      if (data.video_url) atualizarVideoPrincipal(data.video_url);
      if (data.capa_status) {
        state.capaStatus = data.capa_status;
        syncCapaUi(data.capa_status);
      }
      const video = document.getElementById('clip-video');
      if (video) video.playbackRate = 1;
      if (speedMsg) {
        speedMsg.textContent = data.message || 'Pronto.';
        speedMsg.className = 'text-[11px] text-emerald-400';
      }
      setStatus(data.message || 'Velocidade aplicada.');
      syncSpeedPreview();
    } catch (err) {
      if (speedMsg) {
        speedMsg.textContent = err.message;
        speedMsg.className = 'text-[11px] text-rose-300';
      }
      setStatus(err.message, true);
    } finally {
      speedBtn.disabled = false;
      speedBtn.textContent = original;
      syncSpeedPreview();
    }
  });

  // ——— Tela dividida (metade imagem, metade vídeo) ———
  const splitPanel = document.getElementById('split-panel');
  if (splitPanel) {
    // Badge de status ao vivo (sem precisar recarregar o HTML do painel)
    const splitTitleRow = splitPanel.querySelector('.flex.flex-wrap.items-center.gap-2');
    if (splitTitleRow && !splitTitleRow.querySelector('[data-split-live-status]')) {
      const live = document.createElement('span');
      live.dataset.splitLiveStatus = '1';
      live.className = 'hidden';
      splitTitleRow.appendChild(live);
    }

    const imgPreview = document.getElementById('split-img-preview');
    const imgEmpty = document.getElementById('split-img-empty');
    const videoPreview = document.getElementById('split-video-preview');
    const previewBox = document.getElementById('split-preview');
    const videoRange = document.getElementById('split-video-offset');
    const imagemRange = document.getElementById('split-imagem-offset');
    const videoRangeY = document.getElementById('split-video-offset-y');
    const imagemRangeY = document.getElementById('split-imagem-offset-y');
    const videoZoomRange = document.getElementById('split-video-zoom');
    const imagemZoomRange = document.getElementById('split-imagem-zoom');
    const videoValor = document.getElementById('split-video-valor');
    const imagemValor = document.getElementById('split-imagem-valor');
    const videoValorY = document.getElementById('split-video-valor-y');
    const imagemValorY = document.getElementById('split-imagem-valor-y');
    const videoZoomValor = document.getElementById('split-video-zoom-valor');
    const imagemZoomValor = document.getElementById('split-imagem-zoom-valor');
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
    const paneImg = document.getElementById('split-pane-img');
    const paneVid = document.getElementById('split-pane-vid');
    const dividerEl = document.getElementById('split-divider');

    let fonte = 'busca';
    let imagemEscolhida = cfg.splitImagemUrl || null;
    let frameSegundo = null;
    let modo = cfg.splitModo === 'empilhado'
      ? 'empilhado'
      : cfg.splitModo === 'lado'
        ? 'lado'
        : 'normal';
    let lado = cfg.splitImagemPos || (modo === 'empilhado' ? 'cima' : 'esquerda');
    let textoPosicao = ['topo', 'meio'].includes(cfg.splitTextoPosicao)
      ? cfg.splitTextoPosicao
      : modo === 'empilhado'
        ? 'meio'
        : 'rodape';
    let textoTamanho = Number(cfg.splitTextoTamanho) || 100;
    let textoFundo = cfg.splitTextoFundo === 'transparente' ? 'transparente' : 'cor';
    let textoFundoCor = /^#[0-9a-f]{6}$/i.test(String(cfg.splitTextoFundoCor || ''))
      ? String(cfg.splitTextoFundoCor).toLowerCase()
      : '#000000';
    const textoEvitar = [];
    const textoInput = document.getElementById('split-texto');
    const textoPreview = document.getElementById('split-texto-preview');
    const textoPreviewP = document.getElementById('split-texto-preview-p');
    const textoTamInput = document.getElementById('split-texto-tamanho');
    const textoTamValor = document.getElementById('split-texto-tam-valor');
    const textoTomEl = document.getElementById('split-texto-tom');
    const textoIaTamEl = document.getElementById('split-texto-ia-tamanho');
    const sugerirTextoBtn = document.getElementById('btn-split-sugerir-texto');
    const textoFundoCorInput = document.getElementById('split-texto-fundo-cor');
    const textoFundoCorWrap = document.getElementById('split-texto-fundo-cor-wrap');

    function setSplitMsg(msg, isError) {
      if (!msgEl) return;
      msgEl.textContent = msg || '';
      msgEl.className = 'text-[11px] ' + (isError ? 'text-rose-300' : 'text-slate-500');
    }

    function escapeHtmlLocal(s) {
      return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function formatTextoComDestaque(raw) {
      return escapeHtmlLocal(raw).replace(
        /\[\[([^\]]+)\]\]/g,
        '<span class="inline-block bg-yellow-400 px-0.5 text-slate-950">$1</span>'
      );
    }

    function previewClassForPos(pos) {
      const base = 'pointer-events-none absolute inset-x-0 px-2 py-1.5 ';
      if (textoFundo === 'transparente') {
        if (pos === 'topo') return base + 'top-0 bg-transparent';
        if (pos === 'meio') return base + 'top-1/2 -translate-y-1/2 bg-transparent';
        return base + 'bottom-0 bg-transparent';
      }
      if (pos === 'topo') return base + 'top-0';
      if (pos === 'meio') return base + 'top-1/2 -translate-y-1/2';
      return base + 'bottom-0';
    }

    function syncTextoPreview() {
      const txt = String(textoInput?.value || '').trim();
      if (!textoPreview || !textoPreviewP) return;
      if (!txt) {
        textoPreview.classList.add('hidden');
        textoPreviewP.textContent = '';
        return;
      }
      textoPreviewP.innerHTML = formatTextoComDestaque(txt);
      const px = Math.max(6, Math.round(8 * (textoTamanho / 100)));
      textoPreviewP.style.fontSize = px + 'px';
      textoPreviewP.className =
        'text-center text-[8px] font-extrabold uppercase leading-snug tracking-wide text-white px-0.5';
      textoPreview.classList.remove('hidden');
      textoPreview.className = previewClassForPos(textoPosicao);
      if (textoFundo === 'cor') {
        textoPreview.style.background =
          textoFundoCor + (textoPosicao === 'meio' ? 'cc' : 'd9');
      } else {
        textoPreview.style.background = 'transparent';
      }
    }

    function normalizarPosUi(pos) {
      if (pos === 'topo' || pos === 'meio') return pos;
      return 'rodape';
    }

    function syncFundoBtns() {
      splitPanel.querySelectorAll('.split-texto-fundo-btn').forEach((b) => {
        const on = b.dataset.textoFundo === textoFundo;
        b.className = on
          ? 'split-texto-fundo-btn rounded-md bg-fuchsia-500 px-2.5 py-1 text-[11px] font-semibold text-white'
          : 'split-texto-fundo-btn rounded-md px-2.5 py-1 text-[11px] text-slate-400 hover:text-white';
      });
      if (textoFundoCorWrap) {
        textoFundoCorWrap.classList.toggle('hidden', textoFundo !== 'cor');
      }
    }

    textoInput?.addEventListener('input', syncTextoPreview);
    textoTamInput?.addEventListener('input', () => {
      textoTamanho = Number(textoTamInput.value) || 100;
      if (textoTamValor) textoTamValor.textContent = String(textoTamanho);
      syncTextoPreview();
    });
    textoFundoCorInput?.addEventListener('input', () => {
      textoFundoCor = String(textoFundoCorInput.value || '#000000').toLowerCase();
      syncTextoPreview();
    });
    splitPanel.querySelectorAll('.split-texto-fundo-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        textoFundo = btn.dataset.textoFundo === 'transparente' ? 'transparente' : 'cor';
        syncFundoBtns();
        syncTextoPreview();
      });
    });
    syncFundoBtns();

    sugerirTextoBtn?.addEventListener('click', async () => {
      const original = sugerirTextoBtn.textContent;
      sugerirTextoBtn.disabled = true;
      sugerirTextoBtn.textContent = 'Gerando…';
      setSplitMsg('IA escrevendo outra opção de texto…');
      try {
        const atual = String(textoInput?.value || '').trim();
        if (atual && !textoEvitar.includes(atual)) textoEvitar.push(atual);
        const data = await postJson('/api/clips/' + cfg.id + '/split/sugerir-texto', {
          tom: textoTomEl?.value || 'natural',
          tamanho: textoIaTamEl?.value || 'curto',
          texto_atual: atual,
          evitar: textoEvitar.slice(-8),
          titulo: capaTituloEl ? capaTituloEl.value.trim() : '',
        });
        if (textoInput && data.texto) {
          textoInput.value = data.texto;
          if (!textoEvitar.includes(data.texto)) textoEvitar.push(data.texto);
          syncTextoPreview();
        }
        sugerirTextoBtn.textContent = 'Outra sugestão';
        setSplitMsg('Nova sugestão — clique de novo até gostar, depois aplique a tela dividida.');
      } catch (err) {
        sugerirTextoBtn.textContent = original;
        setSplitMsg(err.message, true);
      } finally {
        sugerirTextoBtn.disabled = false;
        if (sugerirTextoBtn.textContent === 'Gerando…') sugerirTextoBtn.textContent = original;
      }
    });

    splitPanel.querySelectorAll('.split-texto-pos-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        textoPosicao = normalizarPosUi(btn.dataset.textoPos);
        splitPanel.querySelectorAll('.split-texto-pos-btn').forEach((b) => {
          const on = b === btn;
          b.className = on
            ? 'split-texto-pos-btn rounded-md bg-fuchsia-500 px-2.5 py-1 text-[11px] font-semibold text-white'
            : 'split-texto-pos-btn rounded-md px-2.5 py-1 text-[11px] text-slate-400 hover:text-white';
        });
        syncTextoPreview();
      });
    });
    syncTextoPreview();

    function aplicarMediaPreview(el, x, y, zoomPct) {
      if (!el) return;
      const z = Math.min(160, Math.max(70, Number(zoomPct) || 100)) / 100;
      el.style.objectFit = 'cover';
      el.style.objectPosition = x + '% ' + y + '%';
      el.style.position = 'absolute';
      el.style.maxWidth = 'none';
      if (z >= 1) {
        el.style.width = '100%';
        el.style.height = '100%';
        el.style.left = '0';
        el.style.top = '0';
        el.style.transform = z > 1.001 ? 'scale(' + z + ')' : 'none';
        el.style.transformOrigin = x + '% ' + y + '%';
      } else {
        const w = z * 100;
        const h = z * 100;
        el.style.width = w + '%';
        el.style.height = h + '%';
        el.style.left = ((100 - w) * x) / 100 + '%';
        el.style.top = ((100 - h) * y) / 100 + '%';
        el.style.transform = 'none';
      }
    }

    function aplicarOffsetsNoPreview() {
      const v = Number(videoRange?.value ?? 50);
      const i = Number(imagemRange?.value ?? 50);
      const vy = Number(videoRangeY?.value ?? 50);
      const iy = Number(imagemRangeY?.value ?? 50);
      const vz = Number(videoZoomRange?.value ?? 100);
      const iz = Number(imagemZoomRange?.value ?? 100);
      aplicarMediaPreview(videoPreview, v, vy, vz);
      aplicarMediaPreview(imgPreview, i, iy, iz);
      if (videoValor) videoValor.textContent = v + '%';
      if (imagemValor) imagemValor.textContent = i + '%';
      if (videoValorY) videoValorY.textContent = vy + '%';
      if (imagemValorY) imagemValorY.textContent = iy + '%';
      if (videoZoomValor) videoZoomValor.textContent = vz + '%';
      if (imagemZoomValor) imagemZoomValor.textContent = iz + '%';
    }

    const blocoEnquadrar = document.getElementById('split-bloco-enquadrar');
    const blocoImagemFonte = document.getElementById('split-bloco-imagem-fonte');

    function rotuloPosicao() {
      if (modo === 'empilhado') {
        return lado === 'baixo' ? 'Imagem embaixo' : 'Imagem em cima';
      }
      return lado === 'direita' ? 'Imagem à direita' : 'Imagem à esquerda';
    }

    function rotuloAplicar() {
      if (modo === 'normal') {
        return state.splitAtivo ? 'Atualizar texto' : 'Aplicar texto';
      }
      return state.splitAtivo ? 'Atualizar layout' : 'Aplicar layout';
    }

    function aplicarLayoutNoPreview() {
      if (!previewBox) return;
      const isNormal = modo === 'normal';
      blocoEnquadrar?.classList.toggle('hidden', isNormal);
      blocoImagemFonte?.classList.toggle('hidden', isNormal);
      ladoBtn?.classList.toggle('hidden', isNormal);
      paneImg?.classList.toggle('hidden', isNormal);
      dividerEl?.classList.toggle('hidden', isNormal);

      if (isNormal) {
        previewBox.style.flexDirection = 'column';
        paneVid?.classList.remove('h-1/2', 'w-1/2');
        paneVid?.classList.add('h-full', 'w-full');
      } else if (modo === 'empilhado') {
        previewBox.style.flexDirection = lado === 'baixo' ? 'column-reverse' : 'column';
        paneImg?.classList.remove('h-full', 'w-1/2', 'hidden');
        paneVid?.classList.remove('h-full', 'w-1/2');
        paneImg?.classList.add('h-1/2', 'w-full');
        paneVid?.classList.add('h-1/2', 'w-full');
        if (dividerEl) {
          dividerEl.className =
            'pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-white/20';
        }
      } else {
        previewBox.style.flexDirection = lado === 'direita' ? 'row-reverse' : 'row';
        paneImg?.classList.remove('h-1/2', 'w-full', 'hidden');
        paneVid?.classList.remove('h-1/2', 'w-full');
        paneImg?.classList.add('h-full', 'w-1/2');
        paneVid?.classList.add('h-full', 'w-1/2');
        if (dividerEl) {
          dividerEl.className =
            'pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-white/20';
        }
      }
      if (ladoBtn) {
        ladoBtn.dataset.lado = lado;
        ladoBtn.textContent = rotuloPosicao();
      }
      if (aplicarBtn && !aplicarBtn.disabled) {
        aplicarBtn.textContent = rotuloAplicar();
      }
      splitPanel.querySelectorAll('.split-modo-btn').forEach((b) => {
        const on = b.dataset.splitModo === modo;
        b.className = on
          ? 'split-modo-btn rounded-lg bg-fuchsia-500 px-3 py-1.5 text-xs font-semibold text-white'
          : 'split-modo-btn rounded-lg px-3 py-1.5 text-xs text-slate-300 hover:text-white';
      });
      aplicarOffsetsNoPreview();
    }

    function aplicarLadoNoPreview() {
      aplicarLayoutNoPreview();
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
    videoRangeY?.addEventListener('input', aplicarOffsetsNoPreview);
    imagemRangeY?.addEventListener('input', aplicarOffsetsNoPreview);
    videoZoomRange?.addEventListener('input', aplicarOffsetsNoPreview);
    imagemZoomRange?.addEventListener('input', aplicarOffsetsNoPreview);
    aplicarOffsetsNoPreview();
    aplicarLadoNoPreview();
    atualizarUiSplit({
      split_status: state.splitStatus,
      layout: state.splitAtivo ? 'split' : 'normal',
      split_imagem_url: state.splitImagemUrl,
    });

    ladoBtn?.addEventListener('click', () => {
      if (modo === 'empilhado') {
        lado = lado === 'baixo' ? 'cima' : 'baixo';
      } else {
        lado = lado === 'direita' ? 'esquerda' : 'direita';
      }
      aplicarLadoNoPreview();
    });

    splitPanel.querySelectorAll('.split-modo-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const next =
          btn.dataset.splitModo === 'empilhado'
            ? 'empilhado'
            : btn.dataset.splitModo === 'normal'
              ? 'normal'
              : 'lado';
        if (next === modo) return;
        if (next === 'empilhado') {
          lado = lado === 'direita' || lado === 'baixo' ? 'baixo' : 'cima';
          if (textoPosicao === 'rodape') {
            textoPosicao = 'meio';
            splitPanel.querySelectorAll('.split-texto-pos-btn').forEach((b) => {
              const on = b.dataset.textoPos === 'meio';
              b.className = on
                ? 'split-texto-pos-btn rounded-md bg-fuchsia-500 px-2.5 py-1 text-[11px] font-semibold text-white'
                : 'split-texto-pos-btn rounded-md px-2.5 py-1 text-[11px] text-slate-400 hover:text-white';
            });
            syncTextoPreview();
          }
        } else if (next === 'lado') {
          lado = lado === 'baixo' ? 'direita' : 'esquerda';
        }
        modo = next;
        aplicarLayoutNoPreview();
      });
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
      const videoOffsetY = Number(videoRangeY?.value ?? 50);
      const imagemOffsetY = Number(imagemRangeY?.value ?? 50);
      const videoZoom = Number(videoZoomRange?.value ?? 100);
      const imagemZoom = Number(imagemZoomRange?.value ?? 100);
      const texto = String(textoInput?.value || '').trim();
      const textoFields = {
        texto,
        texto_posicao: textoPosicao,
        texto_tamanho: textoTamanho,
        texto_fundo: textoFundo,
        texto_fundo_cor: textoFundoCor,
      };
      const offsetFields = {
        video_offset: videoOffset,
        imagem_offset: imagemOffset,
        video_offset_y: videoOffsetY,
        imagem_offset_y: imagemOffsetY,
        video_zoom: videoZoom,
        imagem_zoom: imagemZoom,
      };

      if (modo === 'normal') {
        return {
          body: {
            fonte: 'busca',
            imagem_lado: 'esquerda',
            modo: 'normal',
            ...offsetFields,
            ...textoFields,
          },
          isForm: false,
        };
      }

      if (fonte === 'upload') {
        const file = uploadInput?.files?.[0];
        if (!file) throw new Error('Escolha um arquivo de imagem.');
        const form = new FormData();
        form.append('imagem', file);
        form.append('fonte', 'upload');
        form.append('video_offset', String(videoOffset));
        form.append('imagem_offset', String(imagemOffset));
        form.append('video_offset_y', String(videoOffsetY));
        form.append('imagem_offset_y', String(imagemOffsetY));
        form.append('video_zoom', String(videoZoom));
        form.append('imagem_zoom', String(imagemZoom));
        form.append('imagem_lado', lado);
        form.append('modo', modo);
        form.append('texto', texto);
        form.append('texto_posicao', textoPosicao);
        form.append('texto_tamanho', String(textoTamanho));
        form.append('texto_fundo', textoFundo);
        form.append('texto_fundo_cor', textoFundoCor);
        return { body: form, isForm: true };
      }

      if (fonte === 'frame') {
        if (frameSegundo == null) throw new Error('Clique em um momento do vídeo primeiro.');
        return {
          body: {
            fonte: 'frame',
            frame_segundo: frameSegundo,
            imagem_lado: lado,
            modo,
            ...offsetFields,
            ...textoFields,
          },
          isForm: false,
        };
      }

      if (
        !imagemEscolhida ||
        (!/^https?:\/\//i.test(imagemEscolhida) && !imagemEscolhida.startsWith('/media/'))
      ) {
        throw new Error('Busque e clique em uma foto primeiro.');
      }
      if (imagemEscolhida.startsWith('/media/') && fonte === 'busca') {
        throw new Error('Busque e clique em uma foto da web, ou use a aba Upload / Do vídeo.');
      }
      return {
        body: {
          fonte: 'busca',
          imagem_url: imagemEscolhida,
          imagem_lado: lado,
          modo,
          ...offsetFields,
          ...textoFields,
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
      state.splitStatus = 'gerando';
      try {
        const res = await fetch('/api/clips/' + cfg.id + '/split', {
          method: 'POST',
          headers: payload.isForm ? undefined : { 'Content-Type': 'application/json' },
          body: payload.isForm ? payload.body : JSON.stringify(payload.body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Falha ao montar a tela dividida');
        setSplitMsg(data.message || 'Montando… o vídeo atualiza sozinho.');
        setStatus('Montando tela dividida — continue editando, a página não recarrega.');
        iniciarPollSePreciso();
      } catch (err) {
        state.splitStatus = '';
        aplicarBtn.disabled = false;
        aplicarBtn.textContent = original;
        setSplitMsg(err.message, true);
      }
    });

    enquadrarBtn?.addEventListener('click', async () => {
      enquadrarBtn.disabled = true;
      setSplitMsg('Reenquadrando…');
      state.splitStatus = 'gerando';
      try {
        await postJson('/api/clips/' + cfg.id + '/split/enquadrar', {
          video_offset: Number(videoRange?.value ?? 50),
          imagem_offset: Number(imagemRange?.value ?? 50),
          video_offset_y: Number(videoRangeY?.value ?? 50),
          imagem_offset_y: Number(imagemRangeY?.value ?? 50),
          video_zoom: Number(videoZoomRange?.value ?? 100),
          imagem_zoom: Number(imagemZoomRange?.value ?? 100),
          imagem_lado: lado,
          modo,
          texto: String(textoInput?.value || '').trim(),
          texto_posicao: textoPosicao,
          texto_tamanho: textoTamanho,
          texto_fundo: textoFundo,
          texto_fundo_cor: textoFundoCor,
        });
        setSplitMsg('Reenquadrando… o vídeo atualiza sozinho.');
        setStatus('Reenquadrando — a página não recarrega.');
        iniciarPollSePreciso();
      } catch (err) {
        state.splitStatus = state.splitAtivo ? 'pronta' : '';
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
        state.splitStatus = 'pendente';
        state.splitAtivo = false;
        setSplitMsg('Tela dividida removida — atualizando o vídeo…');
        setStatus('Tela dividida removida.');
        agendarPoll(400);
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
    } catch (err) {
      modalError(err.message);
      setStatus(err.message, true);
    }
  });

  loadPages();
  iniciarPollSePreciso();
})();
