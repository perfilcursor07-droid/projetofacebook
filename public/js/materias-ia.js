(function initMateriasIa() {
  let miaTopicos = [];
  const statusMia = document.getElementById('mia-status');
  const listEl = document.getElementById('mia-topicos');
  const pageSelect = document.getElementById('mia-page');
  const generatingEl = document.getElementById('mia-generating');
  const generatingText = document.getElementById('mia-generating-text');
  if (!pageSelect) return;

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function limparTextoUi(texto) {
    return String(texto || '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/?[^>]+>/g, ' ')
      .replace(/https?:\/\/\S+/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function setGenerating(on, message) {
    if (!generatingEl) return;
    if (message && generatingText) generatingText.textContent = message;
    generatingEl.classList.toggle('hidden', !on);
    document.body.style.overflow = on ? 'hidden' : '';
  }

  async function loadPages() {
    try {
      const res = await fetch('/api/facebook/pages');
      const data = await res.json();
      const pages = data.pages || [];
      const selects = document.querySelectorAll('.mia-page-select');
      const html = !pages.length
        ? '<option value="">Conecte uma página em /paginas</option>'
        : pages
            .map((p) => `<option value="${p.id}">${escapeHtml(p.page_name)}</option>`)
            .join('');
      selects.forEach((el) => {
        el.innerHTML = html;
      });
      if (!selects.length && pageSelect) {
        pageSelect.innerHTML = html;
      }
    } catch {
      document.querySelectorAll('.mia-page-select').forEach((el) => {
        el.innerHTML = '<option value="">Erro ao carregar páginas</option>';
      });
      if (pageSelect) pageSelect.innerHTML = '<option value="">Erro ao carregar páginas</option>';
    }
  }
  loadPages();

  document.querySelectorAll('.mia-modo-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mia-modo-btn').forEach((b) => {
        const on = b === btn;
        b.classList.toggle('bg-emerald-500', on);
        b.classList.toggle('text-slate-950', on);
        b.classList.toggle('font-semibold', on);
        b.classList.toggle('text-slate-300', !on);
      });
      const modo = btn.dataset.miaModo;
      document.getElementById('mia-buscar')?.classList.toggle('hidden', modo !== 'buscar');
      document.getElementById('mia-alta')?.classList.toggle('hidden', modo !== 'alta');
      document.getElementById('mia-link')?.classList.toggle('hidden', modo !== 'link');
      document.getElementById('mia-auto')?.classList.toggle('hidden', modo !== 'auto');
      if (modo === 'auto') loadMonitores();
    });
  });

  document.querySelectorAll('.mia-tag').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = document.getElementById('mia-keywords');
      const tag = btn.dataset.tag;
      const cur = input.value.trim();
      input.value = cur ? (cur.includes(tag) ? cur : cur + ', ' + tag) : tag;
    });
  });

  function renderTopicos(alvo, topicos) {
    miaTopicos = topicos;
    const countEl = document.getElementById('mia-topicos-count');
    if (countEl && alvo.id === 'mia-topicos') {
      countEl.textContent = topicos.length ? topicos.length + ' pauta(s)' : '';
    }
    alvo.innerHTML =
      topicos
        .map((t, i) => {
          const titulo = limparTextoUi(t.titulo);
          const resumo = limparTextoUi(t.resumo);
          const fonte = limparTextoUi(t.veiculo || t.fonte || '');
          const meta = [
            fonte,
            t.calor ? 'calor ' + t.calor : '',
            t.contagemFontes ? t.contagemFontes + ' fontes' : '',
            t.jaPublicado ? 'já usado nesta Página' : '',
          ]
            .filter(Boolean)
            .join(' · ');
          const border = t.jaPublicado ? 'border-amber-500/40 opacity-70' : 'border-slate-800 hover:border-emerald-500/40';
          return `
          <label class="flex gap-3 rounded-xl border ${border} bg-slate-950/50 p-4 cursor-pointer">
            <input type="checkbox" class="mia-check mt-1 accent-emerald-500" data-idx="${i}" ${t.jaPublicado ? 'title="Já usado"' : ''} />
            <span class="min-w-0 flex-1">
              <span class="block text-sm font-medium text-white">${escapeHtml(titulo)}${t.jaPublicado ? ' <span class="text-amber-300 text-xs font-normal">(já publicado)</span>' : ''}</span>
              <span class="mt-1 block text-xs text-slate-500">${escapeHtml(meta)}</span>
              ${resumo ? `<span class="mt-1 block text-xs text-slate-400">${escapeHtml(resumo.slice(0, 180))}${resumo.length > 180 ? '…' : ''}</span>` : ''}
              ${t.link ? `<a href="${escapeHtml(t.link)}" target="_blank" rel="noopener" class="mt-2 inline-block text-xs text-sky-400 hover:text-sky-300">Abrir fonte →</a>` : ''}
            </span>
          </label>`;
        })
        .join('') ||
      '<p class="rounded-xl border border-dashed border-slate-700 px-4 py-8 text-center text-sm text-slate-400">Nenhum assunto encontrado. Tente outras palavras-chave.</p>';
  }

  function selecionados() {
    const panel = document.querySelector('.mia-panel:not(.hidden)') || document;
    return [...panel.querySelectorAll('.mia-check:checked')]
      .map((c) => miaTopicos[Number(c.dataset.idx)])
      .filter(Boolean);
  }

  async function gerarSelecionado(statusEl, { publicar = false } = {}) {
    const sel = selecionados();
    if (!sel.length) {
      statusEl.textContent = 'Marque 1 assunto na lista';
      return;
    }
    if (publicar && !pageSelect.value) {
      statusEl.textContent = 'Selecione a Página do Facebook';
      return;
    }

    const tipoEl = document.getElementById('mia-tipo');
    setGenerating(
      true,
      publicar
        ? 'Gerando e publicando na Página. Aguarde…'
        : 'Apurando fontes, escrevendo o texto e montando a arte. Em seguida você verá a matéria salva para editar.'
    );
    statusEl.textContent = publicar ? 'Gerando e publicando…' : 'Gerando matéria…';

    try {
      const res = await fetch('/api/materias-ia/gerar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topico: sel[0],
          facebookPageId: pageSelect.value ? Number(pageSelect.value) : null,
          tipoPublicacao: tipoEl ? tipoEl.value : 'texto',
          status: publicar ? 'publicado' : 'rascunho',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Falha ao gerar');

      const matterId = data.matter?.id;
      if (!matterId) throw new Error('Matéria gerada, mas sem ID para abrir');

      if (publicar && data.link) {
        statusEl.innerHTML =
          'Publicado ✓ <a class="text-sky-400 hover:underline" href="' +
          escapeHtml(data.link) +
          '" target="_blank" rel="noopener">Ver post</a>';
      } else {
        statusEl.textContent = 'Abrindo matéria gerada…';
      }

      if (generatingText) {
        generatingText.textContent = 'Matéria pronta! Abrindo a tela de edição…';
      }
      window.location.href = '/materias-ia/' + matterId;
    } catch (err) {
      setGenerating(false);
      statusEl.textContent = err.message;
    }
  }

  document.getElementById('mia-btn-buscar')?.addEventListener('click', async () => {
    const palavrasChave = document.getElementById('mia-keywords').value.trim();
    if (!palavrasChave) {
      statusMia.textContent = 'Informe palavras-chave';
      return;
    }
    const onde = document.getElementById('mia-onde').value;
    const periodo = document.getElementById('mia-periodo').value;
    const diasPorPeriodo = { '24h': 1, '3d': 3, '7d': 7, '30d': 30, '90d': 90, '180d': 180 };
    const diasRecentes = diasPorPeriodo[periodo] || 7;
    statusMia.textContent = 'Buscando assuntos…';
    try {
      const res = await fetch('/api/materias-ia/pesquisar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          palavrasChave,
          quantidadePorNicho: Number(document.getElementById('mia-qtd').value || 8),
          diasRecentes,
          periodo,
          incluirRedes: onde === 'tudo',
          somenteRedes: onde === 'redes',
          facebookPageId: pageSelect.value ? Number(pageSelect.value) : null,
          filtrarPeriodo: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Falha na busca');
      renderTopicos(listEl, data.topicos || []);
      const usados = (data.topicos || []).filter((t) => t.jaPublicado).length;
      statusMia.textContent =
        (data.topicos || []).length +
        ' assunto(s)' +
        (usados ? ' · ' + usados + ' já usados nesta Página' : '');
    } catch (err) {
      statusMia.textContent = err.message;
    }
  });

  document.getElementById('mia-btn-alta')?.addEventListener('click', async () => {
    const st = document.getElementById('mia-alta-status');
    st.textContent = 'Varrendo radar…';
    try {
      const res = await fetch('/api/materias-ia/em-alta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          palavrasExtras: document.getElementById('mia-alta-extras').value,
          horas: 24,
          facebookPageId: pageSelect.value ? Number(pageSelect.value) : null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Falha no radar');
      renderTopicos(document.getElementById('mia-alta-topicos'), data.topicos || []);
      st.textContent =
        (data.topicos || []).length + ' em alta · analisados ' + (data.totalAnalisado || 0);
    } catch (err) {
      st.textContent = err.message;
    }
  });

  document.getElementById('mia-btn-link')?.addEventListener('click', async () => {
    const st = document.getElementById('mia-link-status');
    const urlEl = document.getElementById('mia-link-url');
    const pageEl = document.getElementById('mia-link-page');
    const tipoEl = document.getElementById('mia-link-tipo');
    const url = (urlEl?.value || '').trim();
    if (!url) {
      st.textContent = 'Cole o link da notícia, Facebook ou Instagram';
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      st.textContent = 'O link precisa começar com http:// ou https://';
      return;
    }

    setGenerating(
      true,
      'Lendo o link (texto + imagem), montando o furo e reescrevendo. Em seguida você revisa a matéria.'
    );
    st.textContent = 'Extraindo conteúdo do link e gerando matéria…';

    try {
      const res = await fetch('/api/materias-ia/reescrever-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          facebookPageId: pageEl?.value ? Number(pageEl.value) : null,
          tipoPublicacao: tipoEl?.value || 'foto',
          status: 'rascunho',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Falha ao reescrever');

      const matterId = data.matter?.id;
      if (!matterId) throw new Error('Matéria gerada, mas sem ID para abrir');

      st.textContent = 'Abrindo matéria gerada…';
      if (generatingText) {
        generatingText.textContent = 'Matéria pronta! Abrindo a tela de edição…';
      }
      window.location.href = '/materias-ia/' + matterId;
    } catch (err) {
      setGenerating(false);
      st.textContent = err.message;
    }
  });

  document.getElementById('mia-link-url')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('mia-btn-link')?.click();
    }
  });

  document
    .getElementById('mia-btn-preview')
    ?.addEventListener('click', () => gerarSelecionado(statusMia, { publicar: false }));
  document.getElementById('mia-btn-preview-alta')?.addEventListener('click', () => {
    const st = document.getElementById('mia-alta-status');
    gerarSelecionado(st || statusMia, { publicar: false });
  });

  document.getElementById('mia-btn-lote')?.addEventListener('click', async () => {
    const sel = selecionados();
    if (!sel.length) {
      statusMia.textContent = 'Marque tópicos';
      return;
    }
    if (!pageSelect.value) {
      statusMia.textContent = 'Selecione a Página';
      return;
    }
    setGenerating(true, 'Gerando e publicando o lote selecionado…');
    statusMia.textContent = 'Gerando e enfileirando publicação…';
    try {
      const res = await fetch('/api/materias-ia/gerar-lote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topicos: sel,
          facebookPageId: Number(pageSelect.value),
          tipoPublicacao: document.getElementById('mia-tipo').value,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Falha no lote');
      setGenerating(false);
      statusMia.textContent =
        `Criados: ${(data.criados || []).length} · Erros: ${(data.erros || []).length}`;
      const firstId = data.criados?.[0]?.matterId;
      if (firstId && (data.criados || []).length === 1) {
        window.location.href = '/materias-ia/' + firstId;
      } else {
        window.location.reload();
      }
    } catch (err) {
      setGenerating(false);
      statusMia.textContent = err.message;
    }
  });

  async function loadMonitores() {
    const box = document.getElementById('mia-monitores');
    try {
      const res = await fetch('/api/materias-ia/monitor');
      const data = await res.json();
      const list = data.monitores || [];
      box.innerHTML =
        list
          .map(
            (m) => `
            <div class="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-800 bg-slate-950/50 p-4 text-sm">
              <div>
                <div class="font-medium text-white">${escapeHtml(m.palavras_chave)}</div>
                <div class="text-xs text-slate-500">a cada ${m.intervalo_minutos} min · ${m.posts_por_ciclo}/ciclo · ${m.ativo ? 'ativo' : 'pausado'} · publicados ${m.total_publicados || 0}</div>
                ${m.ultimo_erro ? `<div class="text-xs text-rose-300">${escapeHtml(m.ultimo_erro)}</div>` : ''}
              </div>
              <button type="button" class="mia-mon-toggle rounded border border-slate-600 px-3 py-1 text-xs text-slate-300" data-id="${m.id}" data-ativo="${m.ativo ? '1' : '0'}">${m.ativo ? 'Pausar' : 'Retomar'}</button>
            </div>`
          )
          .join('') || '<p class="text-sm text-slate-400">Nenhuma automação ainda.</p>';
    } catch (err) {
      box.innerHTML = `<p class="text-sm text-rose-300">${escapeHtml(err.message)}</p>`;
    }
  }

  document.getElementById('mia-btn-auto')?.addEventListener('click', async () => {
    const st = document.getElementById('mia-auto-status');
    if (!pageSelect.value) {
      st.textContent = 'Selecione a Página na aba Buscar';
      return;
    }
    st.textContent = 'Criando…';
    try {
      const res = await fetch('/api/materias-ia/monitor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          facebookPageId: Number(pageSelect.value),
          palavrasChave: document.getElementById('mia-auto-kw').value,
          intervaloMinutos: Number(document.getElementById('mia-auto-intervalo').value || 30),
          postsPorCiclo: Number(document.getElementById('mia-auto-qtd').value || 1),
          tipoPublicacao: document.getElementById('mia-auto-tipo').value,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Falha');
      st.textContent = 'Automação criada ✓';
      loadMonitores();
    } catch (err) {
      st.textContent = err.message;
    }
  });

  document.getElementById('mia-monitores')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('.mia-mon-toggle');
    if (!btn) return;
    const ativo = btn.dataset.ativo === '1';
    const url = '/api/materias-ia/monitor/' + btn.dataset.id + (ativo ? '/pausar' : '/retomar');
    await fetch(url, { method: 'POST' });
    loadMonitores();
  });
})();
