/* Publicador seguro para o composer de Página do Facebook — Manifest V3. */
(function initViralizePublisher() {
  const VERSION = '1.4.0';
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function visible(el) {
    if (!el?.getBoundingClientRect) return false;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 &&
      rect.width > 2 && rect.height > 2;
  }

  function text(el) {
    return String(el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function labels(el) {
    return [...new Set([
      el?.getAttribute?.('aria-label'),
      el?.getAttribute?.('aria-placeholder'),
      el?.getAttribute?.('title'),
      text(el),
    ].map((value) => String(value || '').replace(/\s+/g, ' ').trim()).filter(Boolean))];
  }

  function matches(el, patterns) {
    return labels(el).some((label) => patterns.some((pattern) => pattern.test(label)));
  }

  function disabled(el) {
    return !el || el.disabled || el.hasAttribute?.('disabled') || el.getAttribute?.('aria-disabled') === 'true';
  }

  function commentContext(el) {
    let node = el;
    for (let depth = 0; node && depth < 12; depth += 1, node = node.parentElement) {
      const value = labels(node).join(' ');
      if (/escreva um coment[aá]rio|write a comment|comment as|deixe um coment|leave a comment|responder|reply|respostas p[uú]blicas/i.test(value)) return true;
      if (node.getAttribute?.('data-testid') === 'UFI2Comment/root') return true;
    }
    return false;
  }

  function clickableAncestor(el, boundary) {
    let node = el;
    while (node) {
      if (node.matches?.('button, [role="button"], a[href], [tabindex="0"]') && visible(node) && !disabled(node)) return node;
      if (node === boundary) break;
      node = node.parentElement;
    }
    return null;
  }

  async function waitFor(find, timeout, description) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const result = find();
      if (result) return result;
      await sleep(300);
    }
    throw new Error(`Tempo esgotado aguardando ${description}.`);
  }

  async function click(el) {
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    await sleep(100);
    el.focus?.();
    el.click();
  }

  function dialogEditor(dialog) {
    return Array.from(dialog?.querySelectorAll?.('[contenteditable="true"]') || [])
      .filter((el) => visible(el) && !commentContext(el))
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return br.width * br.height - ar.width * ar.height;
      })[0] || null;
  }

  function composerDialog() {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]')).filter(visible);
    const named = dialogs.find((dialog) => {
      const heading = Array.from(dialog.querySelectorAll('h1, h2, [role="heading"]')).find(visible);
      const isComposer = matches(dialog, [/criar (?:uma )?publica[cç][aã]o/i, /create (?:a )?post/i]) ||
        matches(heading, [/criar (?:uma )?publica[cç][aã]o/i, /create (?:a )?post/i]);
      return isComposer && dialogEditor(dialog);
    });
    if (named) return named;

    return dialogs
      .map((dialog) => ({ dialog, editor: dialogEditor(dialog), rect: dialog.getBoundingClientRect() }))
      .filter((item) => item.editor && !/coment[aá]rio|comment|compartilhar|share/i.test(labels(item.dialog).join(' ').slice(0, 180)))
      .sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height)[0]?.dialog || null;
  }

  function composerOpener() {
    const patterns = [
      /^criar (?:uma )?publica[cç][aã]o$/i,
      /^create (?:a )?post$/i,
      /^no que voc[eê] (?:est[aá] )?pensando[?…]?$/i,
      /^what'?s on your mind[?…]?$/i,
      /^comece a escrever[.…]?$/i,
      /^escreva algo[.…]?$/i,
    ];
    const main = document.querySelector('[role="main"]') || document.querySelector('main') || document.body;
    const found = new Map();

    const collect = (raw) => {
      const target = clickableAncestor(raw, main) || (raw.matches?.('button, [role="button"]') ? raw : null);
      if (!target || !visible(target) || disabled(target) || commentContext(target) || target.closest('[role="article"]')) return;
      const rect = target.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > innerHeight * 1.7 || rect.width * rect.height < 300) return;
      const score = (rect.width >= 220 ? 20 : 0) + (rect.top >= 0 && rect.top <= innerHeight ? 10 : 0) - Math.max(rect.top, 0) / 100;
      if (!found.has(target) || found.get(target) < score) found.set(target, score);
    };

    Array.from(main.querySelectorAll('button, [role="button"], a[href], [tabindex="0"]'))
      .filter((el) => visible(el) && matches(el, patterns))
      .forEach(collect);
    if (!found.size) {
      Array.from(main.querySelectorAll('span, div'))
        .filter((el) => visible(el) && matches(el, patterns))
        .forEach(collect);
    }
    return [...found.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  }

  function openerDiagnostics() {
    const main = document.querySelector('[role="main"]') || document.body;
    const found = Array.from(main.querySelectorAll('button, [role="button"]'))
      .filter(visible).flatMap(labels)
      .filter((label) => /publica|post|pensando|mind|escrev/i.test(label)).slice(0, 6);
    return found.length ? ` Encontrei estes controles parecidos: ${found.join(' | ')}` : '';
  }

  async function openComposer() {
    scrollTo(0, 0);
    await sleep(600);
    let dialog = composerDialog();
    if (dialog) return { dialog, editor: dialogEditor(dialog) };

    const opener = composerOpener();
    if (!opener) {
      throw new Error('Não encontrei o criador de publicação no feed principal. Abra o perfil da Página, confirme que sua conta pode publicar e não abra uma postagem individual.' + openerDiagnostics());
    }
    await click(opener);
    dialog = await waitFor(composerDialog, 25000, 'o modal Criar publicação');
    const editor = dialogEditor(dialog);
    if (!editor || commentContext(editor)) throw new Error('O Facebook abriu um comentário, não o criador de publicação. A ação foi cancelada.');
    return { dialog, editor };
  }

  function editorValue(editor) {
    return text(editor).replace(/\u200b/g, '').trim();
  }

  function editorContains(editor, expected) {
    const actual = editorValue(editor);
    const sample = String(expected || '').replace(/\s+/g, ' ').trim().slice(0, 36);
    return actual.length > 1 && (!sample || actual.includes(sample.slice(0, 18)) || sample.includes(actual.slice(0, 18)));
  }

  async function fillEditor(editor, value) {
    if (!String(value || '').trim()) throw new Error('O texto da matéria está vazio.');
    editor.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    document.execCommand('insertText', false, value);
    editor.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: value }));
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    await sleep(500);
    if (!editorContains(editor, value)) {
      editor.textContent = value;
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      await sleep(500);
    }
    if (!editorContains(editor, value)) throw new Error('O Facebook não aceitou o texto no criador de publicação.');
  }

  async function attachImage(dialog, image) {
    if (!image?.dataUrl) throw new Error('A matéria exige foto, mas a imagem não foi recebida.');
    const media = Array.from(dialog.querySelectorAll('button, [role="button"]')).find((el) =>
      visible(el) && !disabled(el) && matches(el, [/foto\s*\/?\s*v[ií]deo/i, /photo\s*\/?\s*video/i, /adicionar foto/i, /add photo/i])
    );
    if (media) { await click(media); await sleep(800); }

    const input = await waitFor(() => Array.from(dialog.querySelectorAll('input[type="file"]')).find((el) => {
      const accept = String(el.accept || '').toLowerCase();
      return !accept || accept.includes('image') || accept.includes('*');
    }), 18000, 'o campo de foto');
    const blob = await (await fetch(image.dataUrl)).blob();
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], image.name || 'viralizeai.jpg', { type: image.mime || blob.type || 'image/jpeg' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => dialog.querySelector('img[src^="blob:"], img[src*="scontent"], [aria-label*="Remover"], [aria-label*="Remove"]'), 35000, 'a prévia da foto');
  }

  function actionButton(dialog, patterns) {
    return Array.from(dialog?.querySelectorAll?.('button, [role="button"]') || [])
      .filter((el) => visible(el) && !disabled(el) && !commentContext(el) && matches(el, patterns))
      .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0] || null;
  }

  function buttonDiagnostics(dialog) {
    const values = Array.from(dialog?.querySelectorAll?.('button, [role="button"]') || [])
      .filter(visible).flatMap(labels).filter((label) => label.length < 70).slice(-10);
    return values.length ? ` Controles visíveis no modal: ${values.join(' | ')}` : '';
  }

  async function submit(dialog) {
    const next = actionButton(dialog, [/^avan[cç]ar$/i, /^next$/i, /^continuar$/i, /^continue$/i]);
    if (next) { await click(next); await sleep(1200); dialog = composerDialog(); }
    let publish;
    try {
      publish = await waitFor(() => actionButton(composerDialog(), [/^publicar$/i, /^publish$/i, /^postar$/i, /^publicar agora$/i, /^publish now$/i]), 35000, 'o botão Publicar habilitado');
    } catch {
      throw new Error('Não encontrei um botão Publicar habilitado no modal correto.' + buttonDiagnostics(composerDialog()));
    }
    if (!composerDialog() || commentContext(publish)) throw new Error('O modal mudou antes da publicação; cancelei para não comentar ou compartilhar por engano.');
    await click(publish);
  }

  function currentLinks() {
    return Array.from(document.querySelectorAll('a[href*="/posts/"], a[href*="story_fbid"], a[href*="/permalink/"], a[href*="pfbid"]'))
      .filter(visible).map((anchor) => String(anchor.href || '')).filter(Boolean);
  }

  function linkResult(href) {
    const match = href.match(/posts\/(\d+)/) || href.match(/story_fbid=(\d+)/) || href.match(/\/(pfbid[^/?]+)/i);
    return { fb_post_url: href || null, fb_post_id: match?.[1] || null };
  }

  async function confirmPublished(previousLinks) {
    let closedAt = null;
    const deadline = Date.now() + 65000;
    while (Date.now() < deadline) {
      const newLink = currentLinks().find((href) => !previousLinks.has(href));
      if (newLink) return linkResult(newLink);
      const success = Array.from(document.querySelectorAll('[role="alert"], [role="status"], [aria-live]'))
        .filter(visible).some((el) => /publica[cç][aã]o.*(?:criada|publicada|compartilhada)|post.*(?:created|published|shared)|publicado com sucesso/i.test(text(el)));
      if (success) return { fb_post_url: null, fb_post_id: null };
      const dialog = composerDialog();
      if (!dialog) {
        if (!closedAt) closedAt = Date.now();
        if (Date.now() - closedAt > 10000) return { fb_post_url: null, fb_post_id: null };
      } else {
        closedAt = null;
        const error = Array.from(dialog.querySelectorAll('[role="alert"], div, span')).find((el) =>
          visible(el) && /n[aã]o foi poss[ií]vel|something went wrong|tente novamente|couldn't post|falha ao publicar/i.test(text(el))
        );
        if (error) throw new Error(text(error));
      }
      await sleep(500);
    }
    throw new Error('O Facebook não confirmou a publicação. Verifique o feed antes de tentar novamente.');
  }

  async function publish(payload) {
    if (!payload?.caption) throw new Error('Texto da publicação vazio.');
    const opened = await openComposer();
    await fillEditor(opened.editor, payload.caption);
    if (payload.tipo === 'foto') await attachImage(opened.dialog, payload.image);
    if (!composerDialog() || commentContext(dialogEditor(composerDialog()))) throw new Error('Saí do criador de publicação; a operação foi cancelada.');
    const previous = new Set(currentLinks());
    await submit(composerDialog());
    return { ok: true, ...(await confirmPublished(previous)) };
  }

  if (typeof window.__viralizeaiOnMessage === 'function') {
    try { chrome.runtime.onMessage.removeListener(window.__viralizeaiOnMessage); } catch { /* noop */ }
  }
  window.__viralizeaiOnMessage = (message, _sender, respond) => {
    if (message.type === 'PING') { respond({ ok: true, version: VERSION }); return; }
    if (message.type === 'PUBLISH') {
      publish(message.payload || {}).then(respond).catch((error) => respond({ ok: false, error: error.message || String(error) }));
      return true;
    }
  };
  chrome.runtime.onMessage.addListener(window.__viralizeaiOnMessage);
})();
