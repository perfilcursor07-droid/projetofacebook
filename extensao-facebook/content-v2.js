(() => {
  'use strict';

  if (window.__viralizeaiContentV2Loaded) return;
  window.__viralizeaiContentV2Loaded = true;
  window.__viralizeaiContentVersion = '2.0.0';

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function visible(element) {
    if (!element || !element.isConnected) return false;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2;
  }

  function textOf(element) {
    return String(element?.innerText || element?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function labelsOf(element) {
    return [...new Set([
      element?.getAttribute?.('aria-label'),
      element?.getAttribute?.('aria-placeholder'),
      element?.getAttribute?.('placeholder'),
      element?.getAttribute?.('title'),
      textOf(element),
    ].map((value) => String(value || '').replace(/\s+/g, ' ').trim()).filter(Boolean))];
  }

  function matchesLabel(element, patterns) {
    return labelsOf(element).some((label) => patterns.some((pattern) => pattern.test(label)));
  }

  function disabled(element) {
    return !element || element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true';
  }

  async function waitFor(getValue, { timeout = 30000, interval = 350, label = 'elemento' } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        const value = getValue();
        if (value) return value;
      } catch {
        // O Facebook substitui nós do React durante a renderização; tenta novamente.
      }
      await sleep(interval);
    }
    throw new Error(`Tempo esgotado aguardando ${label}`);
  }

  function isCommentContext(element) {
    if (!element) return true;
    let node = element;
    for (let depth = 0; depth < 12 && node; depth += 1, node = node.parentElement) {
      const labels = labelsOf(node).join(' ');
      if (/escreva um coment[aá]rio|write a comment|deixe um coment|leave a comment|comment as|responder|reply/i.test(labels)) return true;
      if (node.getAttribute?.('data-testid') === 'UFI2Comment/root') return true;
    }
    return false;
  }

  function closestClickable(element, boundary) {
    let node = element;
    while (node) {
      if (node.matches?.('button, [role="button"], a[href], [tabindex="0"]') && visible(node) && !disabled(node)) return node;
      if (node === boundary) break;
      node = node.parentElement;
    }
    return null;
  }

  async function clickElement(element) {
    if (!element) throw new Error('Elemento para clique não encontrado');
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
    await sleep(120);
    element.focus?.();
    element.click();
  }

  function createPostPatterns() {
    return [
      /criar (?:uma )?publica[cç][aã]o/i,
      /no que voc[eê](?: est[aá])? pensando/i,
      /what'?s on your mind/i,
      /create (?:a )?post/i,
      /comece a escrever/i,
      /escreva algo/i,
    ];
  }

  function findComposerOpener() {
    const main = document.querySelector('[role="main"]') || document.querySelector('main') || document.body;
    const patterns = createPostPatterns();
    const candidates = new Map();

    const consider = (raw) => {
      if (!raw || !visible(raw) || isCommentContext(raw)) return;
      const clickable = closestClickable(raw, main) || (raw.matches?.('button, [role="button"]') ? raw : null);
      if (!clickable || !visible(clickable) || disabled(clickable) || isCommentContext(clickable)) return;
      if (clickable.closest('[role="article"]')) return;
      const rect = clickable.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > innerHeight * 1.8 || rect.width < 80) return;
      const score = (rect.width >= 240 ? 30 : 0) + (rect.top >= 0 && rect.top <= innerHeight ? 15 : 0) - Math.max(rect.top, 0) / 100;
      if (!candidates.has(clickable) || candidates.get(clickable) < score) candidates.set(clickable, score);
    };

    main.querySelectorAll('button, [role="button"], a[href], [tabindex="0"]').forEach((element) => {
      if (matchesLabel(element, patterns)) consider(element);
    });
    if (!candidates.size) {
      main.querySelectorAll('span, div').forEach((element) => {
        if (matchesLabel(element, patterns)) consider(element);
      });
    }

    return [...candidates.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  }

  function composerDiagnostics() {
    const main = document.querySelector('[role="main"]') || document.body;
    const labels = [...main.querySelectorAll('button, [role="button"]')]
      .filter(visible)
      .flatMap(labelsOf)
      .filter((label) => /publica|post|pensando|mind|escrev/i.test(label))
      .slice(0, 8);
    return labels.length ? ` Encontrei estes controles parecidos: ${labels.join(' | ')}` : '';
  }

  function findComposerDialog() {
    const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].filter(visible);
    let fallback = null;
    let fallbackArea = 0;

    for (const dialog of dialogs) {
      const editors = [...dialog.querySelectorAll('[contenteditable="true"]')].filter(
        (editor) => visible(editor) && !isCommentContext(editor)
      );
      if (!editors.length) continue;
      const heading = [...dialog.querySelectorAll('h1, h2, [role="heading"]')].find(visible);
      if (matchesLabel(dialog, createPostPatterns()) || matchesLabel(heading, createPostPatterns())) return dialog;
      const label = labelsOf(dialog).join(' ').slice(0, 220);
      if (/coment[aá]rio|comment|compartilhar|share/i.test(label)) continue;
      const rect = dialog.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area > fallbackArea) {
        fallback = dialog;
        fallbackArea = area;
      }
    }
    return fallback;
  }

  function findEditor() {
    const dialog = findComposerDialog();
    if (!dialog) return null;
    return [...dialog.querySelectorAll('[contenteditable="true"]')]
      .filter((editor) => visible(editor) && !isCommentContext(editor))
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return br.width * br.height - ar.width * ar.height;
      })[0] || null;
  }

  async function openComposer() {
    scrollTo({ top: 0, behavior: 'auto' });
    await sleep(1000);
    const existing = findEditor();
    if (existing) return existing;

    const opener = await waitFor(findComposerOpener, {
      timeout: 15000,
      label: 'Criar publicação no feed principal',
    }).catch(() => null);
    if (!opener) {
      throw new Error(
        'Não encontrei “Criar publicação” no feed principal. Abra o perfil da Página selecionada, feche qualquer post/modal e confirme que sua conta tem permissão para publicar.' + composerDiagnostics()
      );
    }

    await clickElement(opener);
    return waitFor(findEditor, { timeout: 25000, label: 'modal Criar publicação' });
  }

  function editorText(editor) {
    return String(editor?.innerText || editor?.textContent || '').replace(/\u200b/g, '').replace(/\s+/g, ' ').trim();
  }

  function editorContains(editor, expected) {
    const actual = editorText(editor);
    const sample = String(expected || '').replace(/\s+/g, ' ').trim().slice(0, 32);
    return actual.length > 1 && (!sample || actual.includes(sample.slice(0, 18)) || sample.includes(actual.slice(0, 18)));
  }

  async function fillEditor(editor, value) {
    const text = String(value || '').trim();
    if (!text) throw new Error('Texto da publicação vazio');
    editor.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);

    let inserted = false;
    try {
      inserted = document.execCommand('insertText', false, text);
    } catch {
      inserted = false;
    }
    if (!inserted || !editorContains(editor, text)) {
      editor.textContent = text;
      editor.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: text }));
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
    editor.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(700);
    if (!editorContains(editor, text)) throw new Error('O Facebook não aceitou o texto no criador de publicação');
  }

  function queryFileInputs(root) {
    return [...root.querySelectorAll('input[type="file"]')].filter((input) => {
      const accept = String(input.accept || '').toLowerCase();
      return !accept || accept.includes('image') || accept.includes('*') || accept.includes('video');
    });
  }

  async function attachPhoto(image) {
    if (!image?.dataUrl) throw new Error('A matéria está sem imagem para anexar');
    const dialog = findComposerDialog();
    if (!dialog) throw new Error('O modal de publicação fechou antes de anexar a imagem');

    const mediaPatterns = [/foto\s*\/?\s*v[ií]deo/i, /photo\s*\/?\s*video/i, /adicionar foto/i, /add photo/i];
    const mediaButton = [...dialog.querySelectorAll('button, [role="button"]')].find(
      (element) => visible(element) && !disabled(element) && matchesLabel(element, mediaPatterns)
    );
    if (mediaButton) {
      await clickElement(mediaButton);
      await sleep(900);
    }

    const input = await waitFor(() => queryFileInputs(dialog)[0] || queryFileInputs(document)[0], {
      timeout: 20000,
      label: 'campo de upload de foto',
    });
    const response = await fetch(image.dataUrl);
    const blob = await response.blob();
    const file = new File([blob], image.name || 'viralizeai.jpg', {
      type: image.mime || blob.type || 'image/jpeg',
    });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));

    await waitFor(() => {
      const currentDialog = findComposerDialog();
      return currentDialog?.querySelector('img[src^="blob:"], img[src*="scontent"], [aria-label*="Remover"], [aria-label*="Remove"]');
    }, { timeout: 40000, label: 'prévia da foto anexada' });
  }

  function findAction(dialog, patterns, { enabled = true } = {}) {
    if (!dialog) return null;
    const matches = [...dialog.querySelectorAll('button, [role="button"]')]
      .filter((element) => visible(element) && matchesLabel(element, patterns) && !isCommentContext(element))
      .filter((element) => !enabled || !disabled(element))
      .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
    return matches[0] || null;
  }

  function actionDiagnostics(dialog) {
    const labels = [...(dialog?.querySelectorAll('button, [role="button"]') || [])]
      .filter(visible)
      .flatMap(labelsOf)
      .filter((label) => label.length <= 80)
      .slice(-12);
    return labels.length ? ` Controles visíveis: ${labels.join(' | ')}` : '';
  }

  async function submitPost() {
    let dialog = findComposerDialog();
    if (!dialog) throw new Error('O modal Criar publicação não está aberto');

    const next = findAction(dialog, [/^avan[cç]ar$/i, /^next$/i, /^continuar$/i, /^continue$/i]);
    if (next) {
      await clickElement(next);
      await sleep(1200);
      dialog = await waitFor(findComposerDialog, { timeout: 15000, label: 'etapa final da publicação' });
    }

    const publishPatterns = [/^publicar$/i, /^publish$/i, /^postar$/i, /^publicar agora$/i, /^publish now$/i];
    const publish = await waitFor(() => findAction(findComposerDialog(), publishPatterns), {
      timeout: 35000,
      label: 'botão Publicar habilitado',
    }).catch(() => null);
    if (!publish) {
      throw new Error('Não encontrei o botão Publicar habilitado dentro do modal.' + actionDiagnostics(findComposerDialog()));
    }
    if (isCommentContext(publish) || disabled(publish)) throw new Error('O botão final mudou; cancelei para não comentar por engano');
    await clickElement(publish);
  }

  function permalinkInfo(anchor) {
    const href = String(anchor?.href || '');
    if (!/\/posts\/|story_fbid|\/permalink\/|pfbid/i.test(href)) return null;
    const match = href.match(/posts\/(\d+)/) || href.match(/story_fbid=(\d+)/) || href.match(/\/(pfbid[^/?]+)/i);
    return { fb_post_url: href, fb_post_id: match?.[1] || null };
  }

  function postLinks() {
    return [...document.querySelectorAll('a[href*="/posts/"], a[href*="story_fbid"], a[href*="/permalink/"], a[href*="pfbid"]')]
      .filter(visible)
      .map((anchor) => ({ anchor, info: permalinkInfo(anchor) }))
      .filter((item) => item.info);
  }

  function newPostLink(previous, caption) {
    const sample = String(caption || '').replace(/\s+/g, ' ').trim().slice(0, 30);
    const fresh = postLinks().filter((item) => !previous.has(item.info.fb_post_url));
    const matching = fresh.find((item) => {
      const article = item.anchor.closest('[role="article"]');
      return article && textOf(article).includes(sample.slice(0, 18));
    });
    return matching?.info || fresh[0]?.info || null;
  }

  function successSignal() {
    return [...document.querySelectorAll('[role="alert"], [role="status"], [aria-live="polite"]')]
      .filter(visible)
      .some((element) => /publica[cç][aã]o (?:foi )?(?:criada|publicada|compartilhada)|post (?:was )?(?:created|published|shared)|publicado com sucesso/i.test(textOf(element)));
  }

  async function confirmPost(previous, caption) {
    const deadline = Date.now() + 65000;
    let closedAt = null;
    while (Date.now() < deadline) {
      const link = newPostLink(previous, caption);
      if (link) return link;
      if (successSignal()) return { fb_post_url: null, fb_post_id: null };

      const dialog = findComposerDialog();
      if (!dialog) {
        if (!closedAt) closedAt = Date.now();
        if (Date.now() - closedAt >= 10000) return { fb_post_url: null, fb_post_id: null };
      } else {
        closedAt = null;
        const error = [...dialog.querySelectorAll('[role="alert"], div, span')].find(
          (element) => visible(element) && /n[aã]o foi poss[ií]vel|something went wrong|tente novamente|couldn't post|falha ao publicar/i.test(textOf(element))
        );
        if (error) throw new Error(textOf(error) || 'O Facebook recusou a publicação');
      }
      await sleep(500);
    }
    throw new Error('O Facebook não confirmou a postagem em 65 segundos. Verifique o feed antes de repetir');
  }

  function normalizeComparable(value) {
    return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/gi, ' ').trim().toLowerCase();
  }

  function validateTargetPage(payload) {
    const pageId = String(payload?.pageId || '').trim();
    const url = decodeURIComponent(location.href);
    if (pageId && (url.includes(`/${pageId}`) || url.includes(`id=${pageId}`))) return;
    const pageName = normalizeComparable(payload?.pageName);
    if (!pageName) return;
    const headings = [...document.querySelectorAll('[role="main"] h1, [role="main"] h2, [role="main"] [role="heading"]')]
      .filter(visible)
      .map((element) => normalizeComparable(textOf(element)));
    if (!headings.some((heading) => heading === pageName || heading.includes(pageName))) {
      throw new Error(`A aba não corresponde à Página “${payload.pageName}”. Abra o feed correto e tente novamente`);
    }
  }

  async function publish(payload) {
    if (!payload?.caption) throw new Error('Texto da publicação vazio');
    validateTargetPage(payload);
    const before = new Set(postLinks().map((item) => item.info.fb_post_url));
    const editor = await openComposer();
    await fillEditor(editor, payload.caption);
    if (payload.tipo === 'foto') await attachPhoto(payload.image);

    if (!findComposerDialog() || isCommentContext(findEditor())) {
      throw new Error('Saí do criador de publicação; cancelei para não inserir conteúdo em comentário');
    }
    await submitPost();
    const result = await confirmPost(before, payload.caption);
    return { ok: true, ...result };
  }

  if (typeof window.__viralizeaiOnMessage === 'function') {
    try {
      chrome.runtime.onMessage.removeListener(window.__viralizeaiOnMessage);
      window.__viralizeaiOnMessage = null;
    } catch {
      // Remove o listener legado quando a aba ainda não foi recarregada.
    }
  }
  if (typeof window.__viralizeaiOnMessageV2 === 'function') {
    chrome.runtime.onMessage.removeListener(window.__viralizeaiOnMessageV2);
  }
  window.__viralizeaiOnMessageV2 = (message, _sender, sendResponse) => {
    if (message.type === 'PING') {
      sendResponse({ ok: true, version: window.__viralizeaiContentVersion });
      return false;
    }
    if (message.type === 'PUBLISH') {
      publish(message.payload || {})
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }
    return false;
  };
  chrome.runtime.onMessage.addListener(window.__viralizeaiOnMessageV2);
})();
