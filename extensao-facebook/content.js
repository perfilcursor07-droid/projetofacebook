/**
 * Content script: publica texto/foto no composer da Página do Facebook.
 * Facebook usa Lexical — precisa paste/input events, não só textContent.
 */

(function () {
  // Permite recarregar a extensão sem precisar fechar a aba (nova versão sobrescreve).
  window.__viralizeaiContentVersion = '1.1.1';

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
    return `${el?.getAttribute?.('aria-label') || ''} ${textOf(el)}`.replace(/\s+/g, ' ').trim();
  }

  function isDisabled(el) {
    if (!el) return true;
    if (el.hasAttribute('disabled')) return true;
    if (el.getAttribute('aria-disabled') === 'true') return true;
    if (el.getAttribute('tabindex') === '-1' && el.getAttribute('aria-disabled') === 'true') return true;
    const cls = String(el.className || '');
    // Heurística: botões cinza/disabled do FB
    if (/\bdisabled\b/i.test(cls)) return true;
    return false;
  }

  async function waitFor(fn, { timeout = 20000, interval = 350, label = 'elemento' } = {}) {
    const start = Date.now();
    let lastErr = null;
    while (Date.now() - start < timeout) {
      try {
        const value = fn();
        if (value) return value;
      } catch (err) {
        lastErr = err;
      }
      await sleep(interval);
    }
    const extra = lastErr ? ` (${lastErr.message})` : '';
    throw new Error(`Timeout aguardando ${label}${extra}`);
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
      const txt = normalizeLabel(el);
      if (want.some((re) => re.test(txt))) return el;
    }
    return null;
  }

  function getComposerDialog() {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]')).filter(
      visible
    );
    if (!dialogs.length) return null;
    // Prefer dialog that has a contenteditable
    const withEditor = dialogs.find((d) => d.querySelector('[contenteditable="true"]'));
    return withEditor || dialogs[dialogs.length - 1];
  }

  function findComposerEditor() {
    const dialog = getComposerDialog();
    const scope = dialog || document;
    const editors = Array.from(scope.querySelectorAll('[contenteditable="true"]')).filter(visible);
    if (!editors.length) return null;
    // Prefer the largest / main post box
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
    // Aceita se começa igual ou tem boa parte do conteúdo (FB pode truncar visual)
    const sample = String(expected).replace(/\s+/g, ' ').trim().slice(0, 40);
    return got.includes(sample.slice(0, 20)) || sample.includes(got.slice(0, 20));
  }

  async function openComposer() {
    let editor = findComposerEditor();
    if (editor && getComposerDialog()) return editor;

    const openers = [
      /criar\s+publica/i,
      /no que voc[eê]\s+est[aá]\s+pensando/i,
      /what'?s on your mind/i,
      /create post/i,
      /escreva algo/i,
      /comece a escrever/i,
    ];

    let opener = null;
    for (const re of openers) {
      opener = findByAriaOrText([re], ['div', 'span', 'button', 'a']);
      if (opener) break;
    }

    if (!opener) {
      opener = Array.from(document.querySelectorAll('[role="button"]')).find((el) => {
        if (!visible(el)) return false;
        return /pensando|publica[cç][aã]o|what's on your mind|create post|escreva/i.test(normalizeLabel(el));
      });
    }

    if (!opener) {
      throw new Error(
        'Composer não encontrado. Abra o feed da Página (facebook.com/…), logado e postando como a Página.'
      );
    }

    opener.click();
    editor = await waitFor(() => findComposerEditor(), {
      timeout: 18000,
      label: 'caixa de texto do composer',
    });
    await sleep(400);
    return editor;
  }

  /** Insere texto de forma que o Lexical/React do FB reconheça. */
  async function setEditorText(editor, text) {
    const value = String(text || '');
    if (!value.trim()) throw new Error('Texto da publicação vazio');

    editor.focus();
    await sleep(150);

    // Limpa
    try {
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
    } catch {
      /* ignore */
    }
    await sleep(80);

    // 1) Paste via ClipboardEvent (melhor para Lexical)
    let pasted = false;
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', value);
      const pasteEvt = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dt,
      });
      pasted = !editor.dispatchEvent(pasteEvt) || true;
      // Alguns browsers exigem que o handler leia clipboardData; se não inseriu, segue fallback
    } catch {
      pasted = false;
    }
    await sleep(250);

    if (!editorHasContent(editor, value)) {
      // 2) execCommand insertText
      editor.focus();
      document.execCommand('selectAll', false, null);
      const ok = document.execCommand('insertText', false, value);
      if (!ok) {
        // 3) beforeinput + inserir nó
        editor.focus();
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);

        editor.dispatchEvent(
          new InputEvent('beforeinput', {
            bubbles: true,
            cancelable: true,
            inputType: 'insertText',
            data: value,
          })
        );
        // last resort
        if (!editorHasContent(editor, value)) {
          editor.textContent = value;
        }
        editor.dispatchEvent(
          new InputEvent('input', {
            bubbles: true,
            cancelable: true,
            inputType: 'insertText',
            data: value,
          })
        );
      }
      await sleep(200);
    }

    // Dispara eventos extras para “acordar” o state do composer
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    editor.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a' }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));

    await sleep(300);

    if (!editorHasContent(editor, value)) {
      throw new Error(
        'Não foi possível inserir o texto no composer do Facebook. Clique na caixa, cole manualmente uma vez e tente de novo; ou recarregue a aba do Facebook.'
      );
    }

    return pasted;
  }

  async function attachPhoto(image) {
    if (!image?.dataUrl) throw new Error('Imagem ausente');

    const mediaBtn = findByAriaOrText(
      [/foto\s*\/?\s*v[ií]deo/i, /photo\s*\/?\s*video/i, /adicionar foto/i, /add photo/i, /imagem/i],
      ['div', 'span', 'button']
    );
    if (mediaBtn) {
      mediaBtn.click();
      await sleep(700);
    }

    const input = await waitFor(
      () => {
        const inputs = queryAllDeep('input[type="file"]');
        return inputs.find((el) => {
          const accept = (el.getAttribute('accept') || '').toLowerCase();
          return !accept || accept.includes('image') || accept.includes('video') || accept.includes('*');
        });
      },
      { timeout: 14000, label: 'input de arquivo de imagem' }
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
      () => {
        const dialog = getComposerDialog() || document.body;
        return dialog.querySelector(
          'img[src^="blob:"], img[src*="scontent"], [aria-label*="Remover"], [aria-label*="Remove"], [aria-label*="Excluir"]'
        );
      },
      { timeout: 30000, label: 'preview da imagem no composer' }
    );
    await sleep(800);
  }

  function findActionButton(patterns, { enabledOnly = true } = {}) {
    const dialog = getComposerDialog() || document;
    const want = patterns.map((p) => (p instanceof RegExp ? p : new RegExp(p, 'i')));
    const buttons = Array.from(dialog.querySelectorAll('[role="button"], button')).filter(visible);

    // Prefer exact / short labels
    const scored = [];
    for (const el of buttons) {
      const label = normalizeLabel(el);
      if (!label || label.length > 60) continue;
      if (!want.some((re) => re.test(label))) continue;
      const exact = want.some((re) => {
        const m = label.match(re);
        return m && m[0].length >= label.length - 2;
      });
      scored.push({ el, label, exact, disabled: isDisabled(el) });
    }

    scored.sort((a, b) => Number(b.exact) - Number(a.exact) || a.label.length - b.label.length);

    for (const item of scored) {
      if (enabledOnly && item.disabled) continue;
      return item.el;
    }
    // Se pediu enabledOnly e só achou disabled, devolve null
    return null;
  }

  function findPublishButton(enabledOnly = true) {
    return findActionButton(
      [
        /^publicar$/i,
        /^publish$/i,
        /^postar$/i,
        /^post$/i,
        /publicar agora/i,
        /publish now/i,
      ],
      { enabledOnly }
    );
  }

  function findNextButton(enabledOnly = true) {
    return findActionButton([/^avan[cç]ar$/i, /^next$/i, /^continuar$/i], { enabledOnly });
  }

  async function clickElement(el) {
    if (!el) return;
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    await sleep(100);
    el.focus?.();
    el.click();
    // Reforço: mouse events (alguns handlers do FB só escutam pointer)
    try {
      const opts = { bubbles: true, cancelable: true, view: window };
      el.dispatchEvent(new PointerEvent('pointerdown', opts));
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new PointerEvent('pointerup', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.dispatchEvent(new MouseEvent('click', opts));
    } catch {
      /* PointerEvent pode falhar em alguns contexts */
      el.click();
    }
  }

  async function ensurePublishReady(editor) {
    // Se existir Avançar habilitado (fluxo de foto), clica
    const next = findNextButton(true);
    if (next) {
      await clickElement(next);
      await sleep(900);
    }

    // Re-foca o editor se o Publicar ainda estiver travado — às vezes desbloqueia
    if (editor && !findPublishButton(true)) {
      editor.focus();
      editor.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: ' ' }));
      editor.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: ' ' }));
      // remove o espaço extra
      try {
        document.execCommand('delete', false, null);
      } catch {
        /* ignore */
      }
      await sleep(400);
    }
  }

  async function clickPublish(editor) {
    await ensurePublishReady(editor);

    let btn = null;
    const start = Date.now();
    while (Date.now() - start < 35000) {
      // Avançar intermediário
      const next = findNextButton(true);
      if (next && !findPublishButton(true)) {
        await clickElement(next);
        await sleep(800);
      }

      btn = findPublishButton(true);
      if (btn) break;

      // Editor ainda sem “commit” visual — tenta cutucar
      if (editor) {
        editor.focus();
        editor.dispatchEvent(new Event('input', { bubbles: true }));
      }
      await sleep(450);
    }

    if (!btn) {
      const disabled = findPublishButton(false);
      if (disabled) {
        throw new Error(
          'Botão Publicar continua desabilitado. Confirme que está postando como a Página (não perfil pessoal), que o texto apareceu na caixa, e tente de novo após recarregar o Facebook.'
        );
      }
      throw new Error(
        'Botão Publicar não encontrado no composer. Abra o feed da Página e deixe o diálogo de criar publicação visível.'
      );
    }

    await clickElement(btn);
  }

  async function waitPublishDone() {
    const start = Date.now();
    while (Date.now() - start < 50000) {
      const dialog = getComposerDialog();
      const editorInDialog = dialog && dialog.querySelector('[contenteditable="true"]');
      if (!editorInDialog) {
        await sleep(700);
        return extractLatestPostLink();
      }

      // Às vezes o FB fecha o editor mas mantém um dialog de "Publicado"
      const publishedToast = findByAriaOrText(
        [/publica[cç][aã]o\s+(feita|conclu|enviada)|your post|post shared|foi publicada/i],
        ['div', 'span']
      );
      if (publishedToast) {
        await sleep(500);
        return extractLatestPostLink();
      }

      const err = findByAriaOrText(
        [/n[aã]o foi poss[ií]vel|something went wrong|tente novamente|couldn't post|falha ao/i],
        ['div', 'span']
      );
      if (err && visible(err)) {
        throw new Error(textOf(err) || 'Facebook recusou a publicação');
      }
      await sleep(500);
    }
    throw new Error('Publicação não confirmada (composer ainda aberto)');
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

    const editor = await openComposer();
    await setEditorText(editor, payload.caption);
    await sleep(500);

    if (payload.tipo === 'foto') {
      await attachPhoto(payload.image);
      await sleep(600);
    }

    await clickPublish(editor);
    const linkInfo = await waitPublishDone();
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
