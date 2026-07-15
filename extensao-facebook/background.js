const ALARM_AUTO = 'viralizeai-auto-publish';
const MIN_INTERVAL_MINUTES = 3;
const PUBLISH_TIMEOUT_MS = 210000;

async function getSettings() {
  const data = await chrome.storage.local.get([
    'apiBase',
    'token',
    'selectedPageId',
    'autoPublish',
    'intervalMin',
    'activityLog',
    'lastPublishAt',
  ]);
  return {
    apiBase: (data.apiBase || '').replace(/\/$/, ''),
    token: data.token || '',
    selectedPageId: data.selectedPageId || '',
    autoPublish: Boolean(data.autoPublish),
    intervalMin: Math.max(MIN_INTERVAL_MINUTES, Number(data.intervalMin) || 5),
    activityLog: Array.isArray(data.activityLog) ? data.activityLog : [],
    lastPublishAt: Number(data.lastPublishAt) || 0,
  };
}

async function apiFetch(path, options = {}) {
  const { apiBase, token } = await getSettings();
  if (!apiBase || !token) throw new Error('Configure URL e token na extensão');
  const res = await fetch(apiBase + path, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function pushLog(entry) {
  const { activityLog } = await getSettings();
  const next = [{ at: Date.now(), ...entry }, ...activityLog].slice(0, 40);
  await chrome.storage.local.set({ activityLog: next });
  return next;
}

async function scheduleAlarm(intervalMin, enabled) {
  await chrome.alarms.clear(ALARM_AUTO);
  if (!enabled) return;
  const minutes = Math.max(MIN_INTERVAL_MINUTES, Number(intervalMin) || 5);
  chrome.alarms.create(ALARM_AUTO, { periodInMinutes: minutes });
}

async function findFacebookTab(pageId) {
  const targetUrl = pageId
    ? `https://www.facebook.com/${encodeURIComponent(pageId)}`
    : 'https://www.facebook.com/';

  const tabs = await chrome.tabs.query({
    url: ['https://www.facebook.com/*', 'https://facebook.com/*'],
  });

  let tab = tabs.find((t) => t.active) || tabs[0];
  if (!tab) {
    tab = await chrome.tabs.create({ url: targetUrl, active: true });
    await waitTabComplete(tab.id);
    return tab;
  }

  // Vai para o feed da Página (topo) — evita caixa de comentário no meio do feed
  const needsNav =
    pageId &&
    !(
      String(tab.url || '').includes(`/${pageId}`) ||
      String(tab.url || '').includes(`id=${pageId}`)
    );

  if (needsNav || !tab.url || tab.url === 'chrome://newtab/') {
    await chrome.tabs.update(tab.id, { url: targetUrl, active: true });
    await waitTabComplete(tab.id);
    await new Promise((r) => setTimeout(r, 1200));
  } else {
    await chrome.tabs.update(tab.id, { active: true });
  }
  return tab;
}

function waitTabComplete(tabId, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error('Timeout ao carregar o Facebook'));
    }, timeoutMs);

    function onUpdated(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    }
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        clearTimeout(timer);
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (tab.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      } else {
        chrome.tabs.onUpdated.addListener(onUpdated);
      }
    });
  });
}

async function ensureContentScript(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    if (String(response?.version || '').startsWith('2.')) return;
  } catch {
    /* injeta a versão atual */
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content-v2.js'],
  });
  const response = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
  if (!String(response?.version || '').startsWith('2.')) {
    throw new Error('Não foi possível ativar o motor de publicação 2.0 na aba do Facebook');
  }
}

function sendToContent(tabId, message, timeoutMs = PUBLISH_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout na publicação no Facebook')), timeoutMs);
    chrome.tabs.sendMessage(tabId, message, (response) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

async function downloadImageAsDataUrl(imagemUrl) {
  if (!imagemUrl) return null;
  const res = await fetch(imagemUrl);
  if (!res.ok) throw new Error('Falha ao baixar a imagem da matéria');
  const blob = await res.blob();
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  const b64 = btoa(binary);
  const mime = blob.type || 'image/jpeg';
  return { dataUrl: `data:${mime};base64,${b64}`, mime, name: 'viralizeai-post.jpg' };
}

function buildCaption(matter) {
  const parts = [];
  if (matter.titulo) parts.push(String(matter.titulo).trim());
  if (matter.materia) parts.push(String(matter.materia).trim());
  const tags = Array.isArray(matter.hashtags)
    ? matter.hashtags.map((t) => (String(t).startsWith('#') ? t : `#${t}`)).join(' ')
    : '';
  if (tags) parts.push(tags);
  return parts.filter(Boolean).join('\n\n');
}

async function publishMatter(matter) {
  if (!matter?.id) throw new Error('Matéria inválida');
  const settings = await getSettings();
  const pageId = matter.fb_page_id || settings.selectedPageId || null;
  let targetPageName = matter.page_name || null;
  if (pageId && !targetPageName) {
    try {
      const pages = await apiFetch('/api/extensao/paginas');
      targetPageName = (pages.paginas || []).find(
        (page) => String(page.page_id) === String(pageId)
      )?.page_name || null;
    } catch {
      // A publicação ainda pode ser validada pelo ID presente na URL.
    }
  }

  await apiFetch(`/api/extensao/matters/${matter.id}/heartbeat`, {
    method: 'POST',
    body: JSON.stringify({ page_id: pageId }),
  });

  const tab = await findFacebookTab(pageId);
  await chrome.tabs.update(tab.id, { active: true });
  // Garante topo da página (composer de post)
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.scrollTo(0, 0),
    });
  } catch {
    /* ignore */
  }
  await ensureContentScript(tab.id);

  let imagePayload = null;
  if (matter.tipo_publicacao === 'foto') {
    if (!matter.imagem_url) throw new Error('Matéria foto sem imagem_url');
    imagePayload = await downloadImageAsDataUrl(matter.imagem_url);
  }

  const caption = buildCaption(matter);
  const result = await sendToContent(tab.id, {
    type: 'PUBLISH',
    payload: {
      caption,
      tipo: matter.tipo_publicacao === 'foto' ? 'foto' : 'texto',
      image: imagePayload,
      pageId,
      pageName: targetPageName,
    },
  });

  if (!result?.ok) {
    const errorMessage = result?.error || 'Publicação não confirmada no Facebook';
    await apiFetch(`/api/extensao/matters/${matter.id}/resultado`, {
      method: 'POST',
      body: JSON.stringify({ status: 'erro', error_message: errorMessage }),
    });
    await pushLog({ title: matter.titulo, status: 'erro', error: errorMessage });
    throw new Error(errorMessage);
  }

  await apiFetch(`/api/extensao/matters/${matter.id}/resultado`, {
    method: 'POST',
    body: JSON.stringify({
      status: 'publicado',
      fb_post_id: result.fb_post_id || null,
      fb_post_url: result.fb_post_url || null,
    }),
  });

  await chrome.storage.local.set({ lastPublishAt: Date.now() });
  await pushLog({
    title: matter.titulo,
    status: 'publicado',
    url: result.fb_post_url || null,
  });

  return result;
}

async function listPendentes(pageId) {
  const q = pageId ? `?page_id=${encodeURIComponent(pageId)}` : '';
  const data = await apiFetch(`/api/extensao/pendentes${q}`);
  return data.pendentes || [];
}

async function publishNext() {
  const settings = await getSettings();
  const since = Date.now() - settings.intervalMin * 60 * 1000;
  if (settings.lastPublishAt && settings.lastPublishAt > since) {
    const waitSec = Math.ceil((settings.lastPublishAt + settings.intervalMin * 60 * 1000 - Date.now()) / 1000);
    throw new Error(`Aguarde ${waitSec}s (intervalo mínimo entre publicações)`);
  }

  const pendentes = await listPendentes(settings.selectedPageId);
  if (!pendentes.length) throw new Error('Nenhuma matéria pendente');
  return publishMatter(pendentes[0]);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'CONNECT') {
        const apiBase = String(msg.apiBase || '').replace(/\/$/, '');
        const token = String(msg.token || '').trim();
        await chrome.storage.local.set({ apiBase, token });
        const data = await apiFetch('/api/extensao/paginas');
        const first = (data.paginas || [])[0];
        if (first?.page_id) {
          await chrome.storage.local.set({ selectedPageId: String(first.page_id) });
        }
        sendResponse({ ok: true, paginas: data.paginas || [] });
        return;
      }

      if (msg.type === 'DISCONNECT') {
        await chrome.alarms.clear(ALARM_AUTO);
        await chrome.storage.local.remove(['token', 'selectedPageId', 'autoPublish']);
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === 'REFRESH') {
        const settings = await getSettings();
        const pages = await apiFetch('/api/extensao/paginas');
        const pendentes = await listPendentes(settings.selectedPageId);
        sendResponse({
          ok: true,
          paginas: pages.paginas || [],
          pendentes,
          selectedPageId: settings.selectedPageId,
          activityLog: settings.activityLog,
        });
        return;
      }

      if (msg.type === 'SET_AUTO') {
        const intervalMin = Math.max(MIN_INTERVAL_MINUTES, Number(msg.intervalMin) || 5);
        await chrome.storage.local.set({
          autoPublish: Boolean(msg.autoPublish),
          intervalMin,
        });
        await scheduleAlarm(intervalMin, Boolean(msg.autoPublish));
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === 'PUBLISH_NEXT') {
        const result = await publishNext();
        sendResponse({ ok: true, result });
        return;
      }

      if (msg.type === 'PUBLISH_ONE') {
        const settings = await getSettings();
        const pendentes = await listPendentes(settings.selectedPageId);
        const matter = pendentes.find((m) => Number(m.id) === Number(msg.matterId));
        if (!matter) throw new Error('Matéria não está mais na fila');
        const result = await publishMatter(matter);
        sendResponse({ ok: true, result });
        return;
      }

      if (msg.type === 'PUBLISH_SELECTED') {
        const settings = await getSettings();
        const wanted = (msg.matterIds || []).map(Number);
        if (!wanted.length) throw new Error('Nenhuma matéria selecionada');
        const pendentes = await listPendentes(settings.selectedPageId);
        const queue = pendentes.filter((m) => wanted.includes(Number(m.id)));
        if (!queue.length) throw new Error('Selecionadas não estão mais na fila');

        let published = 0;
        let failed = 0;
        const errors = [];
        for (let i = 0; i < queue.length; i += 1) {
          try {
            // Respeita intervalo mínimo entre posts no mesmo lote
            if (i > 0) {
              const waitMs = settings.intervalMin * 60 * 1000;
              const since = Date.now() - (Number((await getSettings()).lastPublishAt) || 0);
              if (since < waitMs) {
                await new Promise((r) => setTimeout(r, waitMs - since));
              }
            }
            await publishMatter(queue[i]);
            published += 1;
          } catch (err) {
            failed += 1;
            errors.push(err.message || String(err));
          }
        }
        sendResponse({
          ok: published > 0 || failed === 0,
          published,
          failed,
          message: `${published} publicada(s)` + (failed ? ` · ${failed} erro(s)` : ''),
          errors,
        });
        return;
      }

      sendResponse({ ok: false, error: 'Mensagem desconhecida' });
    } catch (err) {
      sendResponse({ ok: false, error: err.message || String(err) });
    }
  })();
  return true;
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_AUTO) return;
  const settings = await getSettings();
  if (!settings.autoPublish || !settings.token) return;
  try {
    await publishNext();
  } catch (err) {
    await pushLog({ title: 'Auto', status: 'erro', error: err.message || String(err) });
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings();
  await scheduleAlarm(settings.intervalMin, settings.autoPublish);
});
