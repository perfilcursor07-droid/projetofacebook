const DEFAULT_API = 'https://www.viralizeai.online';
const MIN_AUTO_INTERVAL = 3;

const els = {
  setup: document.getElementById('view-setup'),
  main: document.getElementById('view-main'),
  apiBase: document.getElementById('apiBase'),
  token: document.getElementById('token'),
  btnSave: document.getElementById('btn-save'),
  setupStatus: document.getElementById('setup-status'),
  apiLabel: document.getElementById('api-label'),
  btnDisconnect: document.getElementById('btn-disconnect'),
  pageSelect: document.getElementById('pageSelect'),
  autoPublish: document.getElementById('autoPublish'),
  intervalMin: document.getElementById('intervalMin'),
  btnRefresh: document.getElementById('btn-refresh'),
  btnPublishNext: document.getElementById('btn-publish-next'),
  btnPublishSelected: document.getElementById('btn-publish-selected'),
  checkAllPend: document.getElementById('check-all-pend'),
  mainStatus: document.getElementById('main-status'),
  pendentes: document.getElementById('pendentes'),
  logs: document.getElementById('logs'),
};

function setStatus(el, msg, kind) {
  el.textContent = msg || '';
  el.className = 'status' + (kind === 'err' ? ' err' : kind === 'ok' ? ' ok' : '');
}

function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

async function loadSettings() {
  const data = await chrome.storage.local.get([
    'apiBase',
    'token',
    'selectedPageId',
    'autoPublish',
    'intervalMin',
    'activityLog',
  ]);
  return data;
}

function showSetup(prefill = {}) {
  els.setup.classList.remove('hidden');
  els.main.classList.add('hidden');
  els.apiBase.value = prefill.apiBase || DEFAULT_API;
  els.token.value = prefill.token || '';
}

function showMain(settings) {
  els.setup.classList.add('hidden');
  els.main.classList.remove('hidden');
  els.apiLabel.textContent = settings.apiBase || DEFAULT_API;
  els.apiLabel.title = settings.apiBase || DEFAULT_API;
  els.autoPublish.checked = Boolean(settings.autoPublish);
  els.intervalMin.value = Math.max(MIN_AUTO_INTERVAL, Number(settings.intervalMin) || 5);
  renderLogs(settings.activityLog || []);
}

function renderLogs(logs) {
  if (!logs.length) {
    els.logs.innerHTML = '<p class="muted small">Nenhuma atividade ainda.</p>';
    return;
  }
  els.logs.innerHTML = logs
    .slice(0, 12)
    .map((item) => {
      const when = item.at ? new Date(item.at).toLocaleString('pt-BR') : '';
      const link = item.url
        ? ` · <a href="${escapeAttr(item.url)}" target="_blank" rel="noopener">ver post</a>`
        : '';
      const err = item.error ? ` — ${escapeHtml(item.error)}` : '';
      return `<div class="card"><div class="small muted">${escapeHtml(when)}</div>
        <div>${escapeHtml(item.title || 'Matéria')} — <strong>${escapeHtml(item.status)}</strong>${err}${link}</div></div>`;
    })
    .join('');
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(text) {
  return escapeHtml(text).replace(/'/g, '&#39;');
}

async function connect() {
  const apiBase = String(els.apiBase.value || '').trim().replace(/\/$/, '');
  const token = String(els.token.value || '').trim();
  if (!apiBase || !token) {
    setStatus(els.setupStatus, 'Informe URL e token.', 'err');
    return;
  }
  setStatus(els.setupStatus, 'Validando…');
  const res = await send('CONNECT', { apiBase, token });
  if (!res?.ok) {
    setStatus(els.setupStatus, res?.error || 'Falha ao conectar', 'err');
    return;
  }
  const settings = await loadSettings();
  showMain(settings);
  await refresh();
}

async function refresh() {
  setStatus(els.mainStatus, 'Carregando…');
  const res = await send('REFRESH');
  if (!res?.ok) {
    setStatus(els.mainStatus, res?.error || 'Falha ao atualizar', 'err');
    return;
  }
  fillPages(res.paginas || [], res.selectedPageId);
  renderPendentes(res.pendentes || []);
  renderLogs(res.activityLog || []);
  setStatus(els.mainStatus, `${(res.pendentes || []).length} disponível(is)`, 'ok');
}

function fillPages(paginas, selectedPageId) {
  if (!paginas.length) {
    els.pageSelect.innerHTML = '<option value="">Nenhuma página conectada no site</option>';
    return;
  }
  els.pageSelect.innerHTML = paginas
    .map((p) => {
      const selected = String(p.page_id) === String(selectedPageId) ? ' selected' : '';
      return `<option value="${escapeAttr(p.page_id)}"${selected}>${escapeHtml(p.page_name)} (${escapeHtml(p.page_id)})</option>`;
    })
    .join('');
}

function renderPendentes(items) {
  if (els.checkAllPend) els.checkAllPend.checked = false;
  if (!items.length) {
    els.pendentes.innerHTML =
      '<p class="muted small">Nenhuma matéria disponível. Crie conteúdo no site e atualize aqui.</p>';
    return;
  }
  els.pendentes.innerHTML = items
    .map((m) => {
      const preview = String(m.materia || '').replace(/\s+/g, ' ').trim().slice(0, 140);
      const thumb = m.imagem_url
        ? `<img class="thumb" src="${escapeAttr(m.imagem_url)}" alt="" />`
        : `<div class="thumb-placeholder">${escapeHtml(m.tipo_publicacao || 'txt')}</div>`;
      const st = escapeHtml(m.status || 'rascunho');
      return `<article class="card" data-id="${m.id}">
        <div class="card-pend">
          <input type="checkbox" class="js-pend-check" value="${m.id}" checked />
          <div class="card-body">
            <span class="badge-st ${st}">${st}</span>
            <h3>${escapeHtml(m.titulo || 'Sem título')}</h3>
            <p>${escapeHtml(preview)}</p>
            <div class="meta">
              <span class="small muted">${escapeHtml(m.tipo_publicacao)} · ${escapeHtml(m.page_name || 'sem página')}</span>
              <button type="button" class="btn compact primary js-pub" data-id="${m.id}">Publicar</button>
            </div>
          </div>
          ${thumb}
        </div>
      </article>`;
    })
    .join('');

  els.pendentes.querySelectorAll('.js-pub').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      setStatus(els.mainStatus, 'Publicando…');
      const res = await send('PUBLISH_ONE', { matterId: Number(btn.dataset.id) });
      if (!res?.ok) setStatus(els.mainStatus, res?.error || 'Falha', 'err');
      else setStatus(els.mainStatus, 'Publicado ✓', 'ok');
      await refresh();
    });
  });
}

els.btnSave.addEventListener('click', connect);
els.btnDisconnect.addEventListener('click', async () => {
  await send('DISCONNECT');
  showSetup({ apiBase: els.apiLabel.textContent || DEFAULT_API });
});
els.btnRefresh.addEventListener('click', refresh);
els.btnPublishNext.addEventListener('click', async () => {
  els.btnPublishNext.disabled = true;
  setStatus(els.mainStatus, 'Publicando próxima…');
  const res = await send('PUBLISH_NEXT');
  els.btnPublishNext.disabled = false;
  if (!res?.ok) setStatus(els.mainStatus, res?.error || 'Nada para publicar', 'err');
  else setStatus(els.mainStatus, 'Publicado ✓', 'ok');
  await refresh();
});

els.btnPublishSelected?.addEventListener('click', async () => {
  const ids = Array.from(document.querySelectorAll('.js-pend-check:checked')).map((el) => Number(el.value));
  if (!ids.length) {
    setStatus(els.mainStatus, 'Marque ao menos uma matéria.', 'err');
    return;
  }
  els.btnPublishSelected.disabled = true;
  setStatus(els.mainStatus, `Publicando ${ids.length}…`);
  const res = await send('PUBLISH_SELECTED', { matterIds: ids });
  els.btnPublishSelected.disabled = false;
  if (!res?.ok) setStatus(els.mainStatus, res?.error || 'Falha', 'err');
  else setStatus(els.mainStatus, res.message || 'Concluído ✓', 'ok');
  await refresh();
});

els.checkAllPend?.addEventListener('change', () => {
  document.querySelectorAll('.js-pend-check').forEach((el) => {
    el.checked = els.checkAllPend.checked;
  });
});

els.pageSelect.addEventListener('change', async () => {
  await chrome.storage.local.set({ selectedPageId: els.pageSelect.value });
  await refresh();
});

els.autoPublish.addEventListener('change', async () => {
  await send('SET_AUTO', {
    autoPublish: els.autoPublish.checked,
    intervalMin: Math.max(MIN_AUTO_INTERVAL, Number(els.intervalMin.value) || 5),
  });
});

els.intervalMin.addEventListener('change', async () => {
  const intervalMin = Math.max(MIN_AUTO_INTERVAL, Number(els.intervalMin.value) || 5);
  els.intervalMin.value = intervalMin;
  await send('SET_AUTO', {
    autoPublish: els.autoPublish.checked,
    intervalMin,
  });
});

(async function init() {
  const settings = await loadSettings();
  if (settings.token && settings.apiBase) {
    showMain(settings);
    await refresh();
  } else {
    showSetup(settings);
  }
})();
