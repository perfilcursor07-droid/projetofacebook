/**
 * Content script: publica texto/foto no composer da Página do Facebook.
 * Seletores com fallback — a UI do FB muda com frequência.
 */

(function () {
  if (window.__viralizeaiContentBound) return;
  window.__viralizeaiContentBound = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function visible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function textOf(el) {
    return String(el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  async function waitFor(fn, { timeout = 20000, interval = 400, label = 'elemento' } = {}) {
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
      if (node.querySelectorAll) {
        node.querySelectorAll(selector).forEach((el) => out.push(el));
      }
      const tree = node.querySelectorAll ? node.querySelectorAll('*') : [];
      tree.forEach((el) => {
        if (el.shadowRoot) visit(el.shadowRoot);
      });
    };
    visit(root);
    return out;
  }

  function findByAriaOrText(patterns, tagHints = ['div', 'span', 'button', 'a']) {
    const want = patterns.map((p) => (p instanceof RegExp ? p : new RegExp(p, 'i')));
    const candidates = Array.from(document.querySelectorAll(tagHints.join(',')));
    for (const el of candidates) {
      if (!visible(el)) continue;
      const aria = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('role') || ''}`;
      const txt = `${aria} ${textOf(el)}`;
      if (want.some((re) => re.test(txt))) return el;
    }
    return null;
  }

  function findContentEditableNear(trigger) {
    const editors = Array.from(document.querySelectorAll('[contenteditable="true"]')).filter(visible);
    if (!editors.length) return null;
    // Prefer editors inside dialogs/composers
    const inDialog = editors.find((el) => el.closest('[role="dialog"], [role="alertdialog"]'));
    if (inDialog) return inDialog;
    if (trigger) {
      const close = editors.find((el) => trigger.contains(el) || el.contains(trigger));
      if (close) return close;
    }
    return editors[editors.length - 1];
  }

  async function openComposer() {
    // Already open?
    let editor = findContentEditableNear();
    if (editor && editor.closest('[role="dialog"]')) return editor;

    const openers = [
      /criar\s+publica/i,
      /no que voc[eê]\s+est[aá]\s+pensando/i,
      /what'?s on your mind/i,
      /create post/i,
      /escreva algo/i,
    ];

    let opener = null;
    for (const re of openers) {
      opener = findByAriaOrText([re], ['div', 'span', 'button', 'a']);
      if (opener) break;
    }

    if (!opener) {
      // Feed composer strip often has role=button with placeholder text
      opener = Array.from(document.querySelectorAll('[role="button"]')).find((el) => {
        if (!visible(el)) return false;
        const t = textOf(el);
        return /pensando|publica|what's on your mind|create/i.test(t);
      });
    }

    if (!opener) {
      throw new Error(
        'Composer do Facebook não encontrado. Abra a Página certa (modo Página) e o feed da Página.'
      );
    }

    opener.click();
    editor = await waitFor(() => findContentEditableNear(opener), {
      timeout: 15000,
      label: 'caixa de texto do composer',
    });
    return editor;
  }

  function setEditorText(editor, text) {
    editor.focus();
    // Select all + insert via execCommand (Facebook's React listens to these)
    document.execCommand('selectAll', false, null);
    const ok = document.execCommand('insertText', false, text);
    if (!ok) {
      editor.textContent = '';
      const node = document.createTextNode(text);
      editor.appendChild(node);
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    }
    editor.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function attachPhoto(image) {
    if (!image?.dataUrl) throw new Error('Imagem ausente');

    // Try Photo/Video button first to reveal file input
    const mediaBtn = findByAriaOrText(
      [/foto\s*\/?\s*v[ií]deo/i, /photo\s*\/?\s*video/i, /adicionar foto/i, /add photo/i],
      ['div', 'span', 'button']
    );
    if (mediaBtn) mediaBtn.click();

    await sleep(600);

    const input = await waitFor(
      () => {
        const inputs = queryAllDeep('input[type="file"]');
        return inputs.find((el) => {
          const accept = (el.getAttribute('accept') || '').toLowerCase();
          return !accept || accept.includes('image') || accept.includes('*');
        });
      },
      { timeout: 12000, label: 'input de arquivo de imagem' }
    );

    const res = await fetch(image.dataUrl);
    const blob = await res.blob();
    const file = new File([blob], image.name || 'viralizeai.jpg', {
      type: image.mime || blob.type || 'image/jpeg',
    });

    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('input', { bubbles: true }));

    // Wait until a preview image appears in the dialog
    await waitFor(
      () => {
        const dialog = document.querySelector('[role="dialog"]') || document.body;
        return dialog.querySelector('img[src^="blob:"], img[src*="scontent"], [aria-label*="Remover"], [aria-label*="Remove"]');
      },
      { timeout: 25000, label: 'preview da imagem no composer' }
    );
  }

  function findPublishButton() {
    const dialog = document.querySelector('[role="dialog"]') || document;
    const buttons = Array.from(dialog.querySelectorAll('[role="button"], button')).filter(visible);
    const preferred = buttons.find((el) => {
      const t = `${el.getAttribute('aria-label') || ''} ${textOf(el)}`.trim();
      return /^(publicar|postar|post|publish)$/i.test(t) || /publicar agora|publish now/i.test(t);
    });
    if (preferred && !preferred.getAttribute('aria-disabled') && preferred.getAttribute('aria-disabled') !== 'true') {
      return preferred;
    }
    // Fallback: blue primary-looking button labeled Publicar
    return buttons.find((el) => /publicar|publish|postar/i.test(textOf(el))) || null;
  }

  async function clickPublish() {
    const btn = await waitFor(() => {
      const b = findPublishButton();
      if (!b) return null;
      if (b.getAttribute('aria-disabled') === 'true' || b.hasAttribute('disabled')) return null;
      return b;
    }, { timeout: 20000, label: 'botão Publicar habilitado' });

    btn.click();
  }

  async function waitPublishDone() {
    // Composer dialog should close; optionally a toast may appear.
    const start = Date.now();
    while (Date.now() - start < 45000) {
      const dialog = document.querySelector('[role="dialog"]');
      const editorInDialog = dialog && dialog.querySelector('[contenteditable="true"]');
      if (!editorInDialog) {
        await sleep(800);
        return extractLatestPostLink();
      }
      // Error banners
      const err = findByAriaOrText([/n[aã]o foi poss[ií]vel|something went wrong|tente novamente/i], [
        'div',
        'span',
      ]);
      if (err && visible(err)) {
        throw new Error(textOf(err) || 'Facebook recusou a publicação');
      }
      await sleep(500);
    }
    throw new Error('Publicação não confirmada (composer ainda aberto)');
  }

  function extractLatestPostLink() {
    const anchors = Array.from(document.querySelectorAll('a[href*="/posts/"], a[href*="story_fbid"], a[href*="/permalink/"]'));
    for (const a of anchors) {
      if (!visible(a)) continue;
      const href = a.href || '';
      if (/facebook\.com\/.+\/posts\/|story_fbid|permalink/i.test(href)) {
        const idMatch = href.match(/posts\/(\d+)/) || href.match(/story_fbid=(\d+)/) || href.match(/\/(\d{10,})\//);
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

    const editor = await openComposer();
    setEditorText(editor, payload.caption);
    await sleep(400);

    if (payload.tipo === 'foto') {
      await attachPhoto(payload.image);
      await sleep(500);
    }

    await clickPublish();
    const linkInfo = await waitPublishDone();
    return {
      ok: true,
      fb_post_url: linkInfo.fb_post_url,
      fb_post_id: linkInfo.fb_post_id,
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'PING') {
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'PUBLISH') {
      publishPayload(msg.payload || {})
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
      return true;
    }
  });
})();
