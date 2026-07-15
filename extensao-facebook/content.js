/**
 * Publica POST (não comentário) no Facebook.
 *
 * Fluxo correto (UI do FB):
 * 1. Feed da Página → clicar "No que você está pensando?" / "Criar publicação"
 * 2. Abre role=dialog (modal)
 * 3. Colar texto (+ foto opcional)
 * 4. Clicar botão "Publicar" DENTRO do modal
 *
 * O ícone de aviãozinho costuma ser Caixa de comentário — NÃO usar.
 */

(function () {
  window.__viralizeaiContentVersion = '1.2.0';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function visible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2;
  }

  function textOf(el) {
    return String(el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function normalizeLabel(el) {
    return `${el?.getAttribute?.('aria-label') || ''} ${el?.getAttribute?.('aria-placeholder') || ''} ${textOf(el)}`
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isDisabled(el) {
    if (!el) return true;
    if (el.hasAttribute('disabled')) return true;
    if (el.getAttribute('aria-disabled') === 'true') return true;
    return false;
  }

  async function waitFor(fn, { timeout = 25000, interval = 350, label = 'elemento' } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const value = fn();
        if (value) return value;
      } catch {
        /* ignore */
      }
      await sleep(interval);
    }
    throw new Error(`Timeout aguardando ${label}`);
  }

  function queryAllDeep(selector, root = document) {
    const out = [];
    const visit = (node) => {
      if (!node) return;
      if (node.querySelectorAll) node.querySelectorAll(selector).forEach((el) => out.push(el));
      const tree = node.querySelectorAll ? node.querySelectorAll('*') : [];
      tree.forEach((el) => {
        if (el.shadowRoot) visit(el.shadowRoot);
      });
    };
    visit(root);
    return out;
  }

  /** Detecta caixas de COMENTÁRIO (evitar a todo custo). */
  function isCommentContext(el) {
    if (!el) return true;
    let node = el;
    for (let i = 0; i < 12 && node; i += 1) {
      const label = normalizeLabel(node);
      if (
        /escreva um coment[aá]rio|write a comment|coment[aá]rio|comment as|deixe um coment|leave a comment|responder|reply|respostas p[uú]blicas/i.test(
          label
        )
      ) {
        return true;
      }
      // Artigos de post no feed costumam ter "Curtir" / "Comentar" no mesmo bloco
      if (node.getAttribute && node.getAttribute('data-testid') === 'UFI2Comment/root') return true;
      node = node.parentElement;
    }
    const ph = `${el.getAttribute?.('aria-placeholder') || ''} ${el.getAttribute?.('placeholder') || ''}`;
    if (/coment|comment|responda|reply/i.test(ph)) return true;
    return false;
  }

  function getPostDialog() {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]')).filter(
      visible
    );
    for (const d of dialogs) {
      const label = normalizeLabel(d);
      // Modal de criar post
      if (/criar publica|create post|publica[cç][aã]o|nova publica/i.test(label)) return d;
      // Tem editor e botão Publicar, e NÃO é seletor de emoção etc.
      const hasEditor = d.querySelector('[contenteditable="true"]');
      const hasPublish = Array.from(d.querySelectorAll('[role="button"], button')).some((b) =>
        /^publicar$|^publish$/i.test(normalizeLabel(b).slice(0, 40))
      );
      if (hasEditor && hasPublish && !/coment[aá]rio|comment/i.test(label)) return d;
    }
    // Fallback: maior dialog com contenteditable que não seja comentário
    let best = null;
    let bestArea = 0;
    for (const d of dialogs) {
      const editor = d.querySelector('[contenteditable="true"]');
      if (!editor || !visible(editor) || isCommentContext(editor)) continue;
      const r = d.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) {
        best = d;
        bestArea = area;
      }
    }
    return best;
  }

  function findPostEditor() {
    const dialog = getPostDialog();
    if (!dialog) return null;
    const editors = Array.from(dialog.querySelectorAll('[contenteditable="true"]')).filter(
      (el) => visible(el) && !isCommentContext(el)
    );
    if (!editors.length) return null;
    editors.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return rb.width * rb.height - ra.width * ra.height;
    });
    return editors[0];
  }

  function editorText(editor) {
    return String(editor?.innerText || editor?.textContent || '')
      .replace(/\u200b/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function editorHasContent(editor, expected) {
    const got = editorText(editor);
    if (!got || got.length < 2) return false;
    if (!expected) return true;
    const sample = String(expected).replace(/\s+/g, ' ').trim().slice(0, 40);
    return got.includes(sample.slice(0, 18)) || sample.includes(got.slice(0, 18));
  }

  function findCreatePostOpener() {
    // Preferir elementos no TERÇO SUPERIOR da página (composer do feed, não comentário)
    const patterns = [
      /criar\s+publica[cç][aã]o/i,
      /no que voc[eê]\s+est[aá]\s+pensando/i,
      /what'?s on your mind/i,
      /create post/i,
      /comece a escrever/i,
      /escreva algo/i,
    ];

    const candidates = Array.from(document.querySelectorAll('[role="button"], div, span, a')).filter(
      (el) => {
        if (!visible(el)) return false;
        if (isCommentContext(el)) return false;
        const rect = el.getBoundingClientRect();
        // Composer fica no topo do feed
        if (rect.top > window.innerHeight * 0.55) return false;
        const label = normalizeLabel(el);
        if (!label || label.length > 80) return false;
        return patterns.some((re) => re.test(label));
      }
    );

    // Preferir o mais acima e mais largo
    candidates.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return ra.top - rb.top || rb.width - ra.width;
    });
    return candidates[0] || null;
  }

  async function openPostComposer() {
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
    await sleep(300);

    // Já aberto?
    let editor = findPostEditor();
    if (editor) return editor;

    const opener = findCreatePostOpener();
    if (!opener) {
      throw new Error(
        'Não achei "Criar publicação" / "No que você está pensando?". Abra o feed da Página (topo da página), postando como a Página — não a caixa de comentário.'
      );
    }

    opener.click();
    await sleep(400);

    editor = await waitFor(() => findPostEditor(), {
      timeout: 20000,
      label: 'modal Criar publicação (não comentário)',
    });

    if (isCommentContext(editor)) {
      throw new Error('Abriu uma caixa de comentário em vez do post. Role ao topo da Página e tente de novo.');
    }
    return editor;
  }

  async function setEditorText(editor, text) {
    const value = String(text || '');
    if (!value.trim()) throw new Error('Texto vazio');

    editor.focus();
    await sleep(120);
    try {
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
    } catch {
      /* ignore */
    }

    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', value);
      editor.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt })
      );
    } catch {
      /* ignore */
    }
    await sleep(200);

    if (!editorHasContent(editor, value)) {
      editor.focus();
      document.execCommand('selectAll', false, null);
      const ok = document.execCommand('insertText', false, value);
      if (!ok) {
        editor.textContent = value;
        editor.dispatchEvent(
          new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value })
        );
      }
    }

    // Colapsa seleção
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch {
      /* ignore */
    }

    editor.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(300);

    if (!editorHasContent(editor, value)) {
      throw new Error('Não consegui inserir o texto no modal de criar publicação.');
    }
  }

  async function attachPhoto(image) {
    if (!image?.dataUrl) throw new Error('Imagem ausente');
    const dialog = getPostDialog();
    if (!dialog) throw new Error('Modal de post não aberto');

    const mediaBtn = Array.from(dialog.querySelectorAll('[role="button"], button')).find((el) => {
      if (!visible(el)) return false;
      return /foto\s*\/?\s*v[ií]deo|photo\s*\/?\s*video|adicionar foto|add photo|imagem/i.test(
        normalizeLabel(el)
      );
    });
    if (mediaBtn) {
      mediaBtn.click();
      await sleep(700);
    }

    const input = await waitFor(
      () => {
        const inputs = queryAllDeep('input[type="file"]', dialog);
        return inputs.find((el) => {
          const accept = (el.getAttribute('accept') || '').toLowerCase();
          return !accept || accept.includes('image') || accept.includes('*') || accept.includes('video');
        });
      },
      { timeout: 14000, label: 'input de imagem no modal' }
    );

    const res = await fetch(image.dataUrl);
    const blob = await res.blob();
    const file = new File([blob], image.name || 'viralizeai.jpg', {
      type: image.mime || blob.type || 'image/jpeg',
    });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));

    await waitFor(
      () =>
        dialog.querySelector(
          'img[src^="blob:"], img[src*="scontent"], [aria-label*="Remover"], [aria-label*="Remove"]'
        ),
      { timeout: 30000, label: 'preview da foto' }
    );
    await sleep(600);
  }

  function findPublishInDialog(enabledOnly = true) {
    const dialog = getPostDialog();
    if (!dialog) return null;

    const buttons = Array.from(dialog.querySelectorAll('[role="button"], button')).filter(visible);
    const matches = [];
    for (const el of buttons) {
      const label = normalizeLabel(el);
      // Exato "Publicar" / "Publish" — NÃO "Enviar" (comentário)
      if (!/^(publicar|publish|postar)$/i.test(label) && !/^(publicar|publish) agora$/i.test(label)) {
        continue;
      }
      // Evitar botões fora do rodapé do modal (muito acima)
      matches.push({ el, disabled: isDisabled(el), top: el.getBoundingClientRect().top });
    }
    // Preferir o mais abaixo (rodapé do modal)
    matches.sort((a, b) => b.top - a.top);
    for (const m of matches) {
      if (enabledOnly && m.disabled) continue;
      return m.el;
    }
    return null;
  }

  async function clickElement(el) {
    if (!el) return;
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    await sleep(80);
    el.focus?.();
    try {
      const opts = { bubbles: true, cancelable: true, view: window };
      el.dispatchEvent(new PointerEvent('pointerdown', opts));
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new PointerEvent('pointerup', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.dispatchEvent(new MouseEvent('click', opts));
    } catch {
      el.click();
    }
  }

  async function clickPublish() {
    // Passo intermediário "Avançar" (fluxo de foto)
    const dialog = getPostDialog();
    if (dialog) {
      const next = Array.from(dialog.querySelectorAll('[role="button"], button')).find((el) => {
        if (!visible(el) || isDisabled(el)) return false;
        return /^(avan[cç]ar|next|continuar)$/i.test(normalizeLabel(el));
      });
      if (next) {
        await clickElement(next);
        await sleep(900);
      }
    }

    const btn = await waitFor(() => findPublishInDialog(true), {
      timeout: 25000,
      label: 'botão Publicar no modal de criar post',
    });
    await clickElement(btn);
  }

  async function waitPostDone() {
    const start = Date.now();
    while (Date.now() - start < 45000) {
      const dialog = getPostDialog();
      // Modal fechou = sucesso típico
      if (!dialog) {
        await sleep(600);
        return extractLatestPostLink();
      }
      const editor = findPostEditor();
      if (!editor) {
        await sleep(600);
        return extractLatestPostLink();
      }

      const err = Array.from(dialog.querySelectorAll('div, span')).find((el) => {
        if (!visible(el)) return false;
        return /n[aã]o foi poss[ií]vel|something went wrong|tente novamente|couldn't post/i.test(
          textOf(el)
        );
      });
      if (err) throw new Error(textOf(err) || 'Facebook recusou a publicação');

      await sleep(450);
    }
    throw new Error('Modal ainda aberto — publicação não confirmada');
  }

  function extractLatestPostLink() {
    const anchors = Array.from(
      document.querySelectorAll('a[href*="/posts/"], a[href*="story_fbid"], a[href*="/permalink/"]')
    );
    for (const a of anchors) {
      if (!visible(a)) continue;
      const href = a.href || '';
      if (/facebook\.com\/.+\/posts\/|story_fbid|permalink/i.test(href)) {
        const idMatch =
          href.match(/posts\/(\d+)/) || href.match(/story_fbid=(\d+)/) || href.match(/\/(\d{10,})\//);
        return {
          fb_post_url: href.split('?')[0],
          fb_post_id: idMatch ? idMatch[1] : null,
        };
      }
    }
    return { fb_post_url: null, fb_post_id: null };
  }

  async function publishPayload(payload) {
    if (!payload?.caption) throw new Error('Texto da publicação vazio');

    const editor = await openPostComposer();
    await setEditorText(editor, payload.caption);
    await sleep(400);

    if (payload.tipo === 'foto') {
      await attachPhoto(payload.image);
      await sleep(500);
    }

    // Garantia: ainda estamos no modal de POST
    if (!getPostDialog() || isCommentContext(findPostEditor())) {
      throw new Error('Saiu do modal de post (caiu em comentário). Abortei para não comentar.');
    }

    await clickPublish();
    const linkInfo = await waitPostDone();
    return {
      ok: true,
      fb_post_url: linkInfo.fb_post_url,
      fb_post_id: linkInfo.fb_post_id,
    };
  }

  if (typeof window.__viralizeaiOnMessage === 'function') {
    try {
      chrome.runtime.onMessage.removeListener(window.__viralizeaiOnMessage);
    } catch {
      /* ignore */
    }
  }

  window.__viralizeaiOnMessage = function onMessage(msg, _sender, sendResponse) {
    if (msg.type === 'PING') {
      sendResponse({ ok: true, version: window.__viralizeaiContentVersion });
      return;
    }
    if (msg.type === 'PUBLISH') {
      publishPayload(msg.payload || {})
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
      return true;
    }
  };

  chrome.runtime.onMessage.addListener(window.__viralizeaiOnMessage);
})();
