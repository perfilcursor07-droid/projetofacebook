/**
 * Content script: publica texto/foto no composer da Página do Facebook.
 * Facebook usa Lexical — precisa paste/input events, não só textContent.
 */

(function () {
  // Permite recarregar a extensão sem precisar fechar a aba (nova versão sobrescreve).
  window.__viralizeaiContentVersion = '1.1.2';

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

  function findActionButton(patterns, { enabledOnly = true, root = null } = {}) {
    const scope = root || getComposerDialog() || document;
    const want = patterns.map((p) => (p instanceof RegExp ? p : new RegExp(p, 'i')));
    const buttons = Array.from(scope.querySelectorAll('[role="button"], button')).filter(visible);

    const scored = [];
    for (const el of buttons) {
      const label = normalizeLabel(el);
      if (!label || label.length > 80) continue;
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
    return null;
  }

  /** Botão redondo azul com aviãozinho (composer inline do feed da Página). */
  function findSendPlaneButton(enabledOnly = true) {
    const editor = findComposerEditor();
    const container =
      editor?.closest('[role="dialog"]') ||
      editor?.closest('form') ||
      editor?.closest('[data-pagelet]') ||
      editor?.parentElement?.parentElement?.parentElement ||
      getComposerDialog() ||
      document;

    // 1) aria-label Enviar / Send / Publicar (ícone sem texto visível)
    const byLabel = findActionButton(
      [
        /^enviar$/i,
        /^send$/i,
        /^publicar$/i,
        /^publish$/i,
        /^postar$/i,
        /enviar publica/i,
        /send post/i,
        /postar agora/i,
      ],
      { enabledOnly, root: container }
    );
    if (byLabel) return byLabel;

    // 2) Botões próximos ao editor contendo SVG (avião / seta)
    const buttons = Array.from(container.querySelectorAll('[role="button"], button')).filter(visible);
    const editorRect = editor ? editor.getBoundingClientRect() : null;

    const candidates = [];
    for (const el of buttons) {
      if (enabledOnly && isDisabled(el)) continue;
      const label = normalizeLabel(el);
      // Ignora ícones da toolbar (emoji, foto, etc.) pelo label
      if (/emoji|foto|v[ií]deo|gif|local|marc|felt|sticker|imagem|feeling|check.?in/i.test(label)) {
        continue;
      }

      const rect = el.getBoundingClientRect();
      // Preferir botão à direita / abaixo do editor, pequeno (ícone)
      if (editorRect) {
        const belowOrSame = rect.top >= editorRect.top - 40;
        const toTheRight = rect.left >= editorRect.left + editorRect.width * 0.4;
        if (!belowOrSame) continue;
        if (!toTheRight && rect.width > 80) continue;
      }

      const svg = el.querySelector('svg');
      if (!svg) continue;

      const paths = Array.from(svg.querySelectorAll('path'))
        .map((p) => p.getAttribute('d') || '')
        .join(' ');
      // Heurística de aviãozinho / send: path curto-médio e botão pequeno/circular
      const looksIcon = rect.width <= 64 && rect.height <= 64;
      const looksPlane =
        /M\d|send|airplane/i.test(paths) ||
        (looksIcon && paths.length > 20 && paths.length < 900);

      // Cor azul do FB no botão (bg)
      const style = window.getComputedStyle(el);
      const bg = style.backgroundColor || '';
      const isBlue =
        /rgb\(\s*(22|24|8|26|45|56|66|15|28)\s*,\s*(11[0-9]|12[0-9]|13[0-9]|99|108|119|13[0-9])\s*,/i.test(
          bg
        ) ||
        /rgb\(\s*24\s*,\s*119\s*,\s*242\s*\)/i.test(bg) ||
        style.color.includes('rgb(255') && looksIcon;

      if (looksPlane || (looksIcon && isBlue && !label)) {
        candidates.push({
          el,
          score:
            (looksIcon ? 3 : 0) +
            (isBlue ? 4 : 0) +
            (editorRect ? Math.max(0, 200 - Math.abs(rect.top - editorRect.bottom)) / 50 : 0),
        });
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.el || null;
  }

  function findPublishButton(enabledOnly = true) {
    // Composer modal antigo
    const classic = findActionButton(
      [
        /^publicar$/i,
        /^publish$/i,
        /^postar$/i,
        /^post$/i,
        /^enviar$/i,
        /^send$/i,
        /publicar agora/i,
        /publish now/i,
      ],
      { enabledOnly }
    );
    if (classic) return classic;
    // Composer inline do feed (aviãozinho)
    return findSendPlaneButton(enabledOnly);
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

  /** Ctrl/Cmd+Enter — atalho nativo do composer do Facebook. */
  async function submitViaKeyboard(editor) {
    if (!editor) return false;
    editor.focus();
    await sleep(80);
    const mod = { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', which: 13, keyCode: 13 };
    editor.dispatchEvent(new KeyboardEvent('keydown', { ...mod, ctrlKey: true }));
    editor.dispatchEvent(new KeyboardEvent('keydown', { ...mod, metaKey: true }));
    editor.dispatchEvent(new KeyboardEvent('keypress', { ...mod, ctrlKey: true }));
    editor.dispatchEvent(new KeyboardEvent('keyup', { ...mod, ctrlKey: true }));
    await sleep(500);
    return true;
  }

  async function ensurePublishReady(editor) {
    const next = findNextButton(true);
    if (next) {
      await clickElement(next);
      await sleep(900);
    }

    // Tira seleção residual do paste (na print os hashtags ficavam selecionados)
    if (editor) {
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
      editor.focus();
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(250);
    }
  }

  async function clickPublish(editor) {
    await ensurePublishReady(editor);

    let btn = null;
    const start = Date.now();
    while (Date.now() - start < 20000) {
      const next = findNextButton(true);
      if (next && !findPublishButton(true)) {
        await clickElement(next);
        await sleep(800);
      }

      btn = findPublishButton(true);
      if (btn) break;

      if (editor) {
        editor.focus();
        editor.dispatchEvent(new Event('input', { bubbles: true }));
      }
      await sleep(400);
    }

    if (btn) {
      await clickElement(btn);
      return;
    }

    // Fallback: Ctrl+Enter
    await submitViaKeyboard(editor);
    await sleep(800);

    // Se o editor ainda está ali com o mesmo texto, o atalho não funcionou
    const stillOpen = findComposerEditor();
    if (stillOpen && editorHasContent(stillOpen, editorText(editor).slice(0, 30))) {
      const disabled = findPublishButton(false);
      if (disabled) {
        await clickElement(disabled); // tentativa forçada
        await sleep(600);
        return;
      }
      throw new Error(
        'Não achei o botão Enviar (aviãozinho azul). Confirme o composer do feed da Página e atualize a extensão.'
      );
    }
  }

  async function waitPublishDone(previousText) {
    const start = Date.now();
    const sample = String(previousText || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40);

    while (Date.now() - start < 50000) {
      const dialog = getComposerDialog();
      const editor = findComposerEditor();
      const editorInDialog = dialog && dialog.querySelector('[contenteditable="true"]');

      // Modal clássico fechou
      if (dialog && !editorInDialog) {
        await sleep(700);
        return extractLatestPostLink();
      }

      // Composer inline: texto sumiu / caixa vazia = enviou
      if (editor) {
        const now = editorText(editor);
        const cleared =
          !now ||
          now.length < 3 ||
          (sample && !now.includes(sample.slice(0, 18)) && now.length < sample.length / 2);
        if (cleared) {
          await sleep(700);
          return extractLatestPostLink();
        }
      } else if (!dialog) {
        // Editor sumiu por completo
        await sleep(700);
        return extractLatestPostLink();
      }

      const publishedToast = findByAriaOrText(
        [/publica[cç][aã]o\s+(feita|conclu|enviada)|your post|post shared|foi publicada|enviado/i],
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
    throw new Error('Publicação não confirmada (texto ainda no composer)');
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

    const captionSnapshot = payload.caption;
    await clickPublish(editor);
    const linkInfo = await waitPublishDone(captionSnapshot);
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
