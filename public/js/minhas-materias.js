(function initMinhasMaterias() {
  const list = document.getElementById('mia-matters-list');
  if (!list) return;

  function formatNum(n) {
    const v = Number(n);
    if (!Number.isFinite(v) || v < 0) return null;
    if (v >= 1000000) return (v / 1000000).toFixed(1).replace(/\.0$/, '') + ' mi';
    if (v >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + ' mil';
    return String(Math.round(v));
  }

  function viralInfo(likes, comments, views) {
    const l = Number(likes) || 0;
    const c = Number(comments) || 0;
    const v = Number(views) || 0;
    const score = l + c * 3 + Math.min(v, 5000) / 50;
    if (score >= 400 || l >= 200 || c >= 50) {
      return { label: 'Viralizou', cls: 'bg-rose-500/20 text-rose-200 ring-rose-500/30' };
    }
    if (score >= 80 || l >= 40 || c >= 10) {
      return { label: 'Bom', cls: 'bg-amber-500/15 text-amber-200 ring-amber-500/25' };
    }
    if (l > 0 || c > 0 || v > 0) {
      return { label: 'Baixo', cls: 'bg-slate-700/40 text-slate-400 ring-slate-600/40' };
    }
    return null;
  }

  function atualizarBadgeViral(row, likes, comments, views) {
    if (!row) return;
    let badge = row.querySelector('.mia-viral-badge');
    const info = viralInfo(likes, comments, views);
    if (!info) {
      if (badge) badge.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement('span');
      badge.className =
        'mia-viral-badge shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ring-1';
      const status = row.querySelector('.min-w-0 .shrink-0');
      if (status && status.parentNode) {
        status.insertAdjacentElement('afterend', badge);
      } else {
        row.querySelector('.min-w-0')?.prepend(badge);
      }
    }
    badge.className =
      'mia-viral-badge shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ring-1 ' +
      info.cls;
    badge.textContent = info.label;
  }

  /**
   * Atualiza engajamento de um botão .mia-matter-views.
   * @param {HTMLElement} viewsBtn
   * @param {{ force?: boolean, silent?: boolean }} opts
   */
  async function fetchEngajamento(viewsBtn, { force = false, silent = false } = {}) {
    const id = viewsBtn?.dataset?.id;
    if (!id) return null;

    const likesEl = viewsBtn.querySelector('.mia-likes-label');
    const commentsEl = viewsBtn.querySelector('.mia-comments-label');
    const viewsEl = viewsBtn.querySelector('.mia-views-label');
    const prev = {
      likes: likesEl?.textContent,
      comments: commentsEl?.textContent,
      views: viewsEl?.textContent,
    };

    if (likesEl) likesEl.textContent = '…';
    if (commentsEl) commentsEl.textContent = '…';
    if (viewsEl) viewsEl.textContent = '…';
    viewsBtn.disabled = true;

    try {
      const qs = force ? '?force=1' : '';
      const res = await fetch('/api/materias-ia/matters/' + id + '/views' + qs, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Falha ao buscar engajamento');

      if (likesEl) {
        likesEl.textContent =
          data.likes != null ? formatNum(data.likes) + ' curtidas' : prev.likes || 'curtidas';
      }
      if (commentsEl) {
        commentsEl.textContent =
          data.comments != null
            ? formatNum(data.comments) + ' coment.'
            : prev.comments || 'coment.';
      }
      if (viewsEl) {
        viewsEl.textContent =
          data.views != null ? formatNum(data.views) + ' views' : prev.views || 'views';
      }

      const row = viewsBtn.closest('.mia-matter-row');
      atualizarBadgeViral(row, data.likes, data.comments, data.views);

      if (data.viral?.label) {
        viewsBtn.title =
          data.viral.label +
          (data.fonte ? ' · via ' + data.fonte : '') +
          (data.cached ? ' · em cache' : '') +
          (data.message ? ' — ' + data.message : '');
      } else if (data.message) {
        viewsBtn.title = data.message;
      }
      return data;
    } catch (err) {
      if (likesEl) likesEl.textContent = prev.likes || 'curtidas';
      if (commentsEl) commentsEl.textContent = prev.comments || 'coment.';
      if (viewsEl) viewsEl.textContent = prev.views || 'views';
      if (!silent) alert(err.message || 'Erro ao buscar engajamento');
      return null;
    } finally {
      viewsBtn.disabled = false;
    }
  }

  /** Ao abrir a página: atualiza engajamento de todas as publicadas visíveis (respeita cache 30 min no servidor). */
  async function autoAtualizarEngajamento() {
    const buttons = Array.from(list.querySelectorAll('.mia-matter-views'));
    if (!buttons.length) return;

    for (const btn of buttons) {
      await fetchEngajamento(btn, { force: false, silent: true });
    }
  }

  list.addEventListener('click', async (e) => {
    const removeBtn = e.target.closest('.mia-matter-remove');
    const variacaoBtn = e.target.closest('.mia-matter-variacao');
    const reelBtn = e.target.closest('.mia-matter-reel');
    const viewsBtn = e.target.closest('.mia-matter-views');

    if (reelBtn) {
      e.preventDefault();
      const id = reelBtn.dataset.id;
      const titulo = reelBtn.dataset.titulo || 'esta matéria';
      if (!id) return;
      const regenerar = reelBtn.dataset.hasVideo === '1';
      const msg = regenerar
        ? 'Regenerar o Reel narrado de "' +
          titulo +
          '"?\n\nA voz (ElevenLabs) + imagem serão montadas de novo. Pode levar 1–2 minutos.'
        : 'Gerar Reel narrado de "' +
          titulo +
          '"?\n\nUsa a imagem da matéria + narração em voz (ElevenLabs). Pode levar 1–2 minutos.';
      if (!confirm(msg)) return;

      reelBtn.disabled = true;
      const old = reelBtn.textContent;
      reelBtn.textContent = '…';
      try {
        const res = await fetch('/api/materias-ia/matters/' + id + '/gerar-reel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Falha ao gerar Reel');
        const dest =
          data.redirect || (data.matter?.id ? '/materias-ia/' + data.matter.id : null);
        if (dest) {
          window.location.href = dest;
          return;
        }
        alert('Reel gerado.');
        window.location.reload();
      } catch (err) {
        alert(err.message || 'Erro ao gerar Reel');
      } finally {
        reelBtn.disabled = false;
        reelBtn.textContent = old;
      }
      return;
    }

    if (viewsBtn) {
      e.preventDefault();
      await fetchEngajamento(viewsBtn, { force: true, silent: false });
      return;
    }

    if (variacaoBtn) {
      e.preventDefault();
      const id = variacaoBtn.dataset.id;
      const titulo = variacaoBtn.dataset.titulo || 'esta matéria';
      if (!id) return;
      if (
        !confirm(
          'Criar uma NOVA matéria no tema de "' +
            titulo +
            '"?\n\nA IA busca infos novas (Brave) e reescreve sem plagiar o texto atual.'
        )
      ) {
        return;
      }
      variacaoBtn.disabled = true;
      const old = variacaoBtn.textContent;
      variacaoBtn.textContent = '…';
      try {
        const res = await fetch('/api/materias-ia/matters/' + id + '/variacao', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Falha ao gerar variação');
        const dest =
          data.redirect || (data.matter?.id ? '/materias-ia/' + data.matter.id : null);
        if (dest) {
          window.location.href = dest;
          return;
        }
        alert('Matéria gerada, mas sem redirecionamento.');
      } catch (err) {
        alert(err.message || 'Erro ao gerar nova matéria');
      } finally {
        variacaoBtn.disabled = false;
        variacaoBtn.textContent = old;
      }
      return;
    }

    if (!removeBtn) return;
    e.preventDefault();
    const id = removeBtn.dataset.id;
    const titulo = removeBtn.dataset.titulo || 'esta matéria';
    if (!id) return;
    if (!confirm('Remover "' + titulo + '"? Essa ação não pode ser desfeita.')) return;

    removeBtn.disabled = true;
    removeBtn.textContent = '…';
    try {
      const res = await fetch('/api/materias-ia/matters/' + id, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Falha ao remover');
      window.location.reload();
    } catch (err) {
      removeBtn.disabled = false;
      removeBtn.textContent = '×';
      alert(err.message || 'Erro ao remover');
    }
  });

  // Dispara após o paint — não bloqueia a lista
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => {
      setTimeout(autoAtualizarEngajamento, 50);
    });
  } else {
    setTimeout(autoAtualizarEngajamento, 100);
  }
})();
