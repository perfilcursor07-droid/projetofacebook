/* Módulo Grupos (/grupos): cadastro, organização por nicho e marcação de padrões.
   A publicação usa o Ayrshare (cada grupo tem sua Profile-Key). */
(() => {
  const app = document.getElementById('grupos-app');
  if (!app) return;

  const API = '/api/grupos';
  const listaEl = document.getElementById('grupos-lista');
  const vazioEl = document.getElementById('grupos-vazio');
  const filtroEl = document.getElementById('filtro-nichos');
  const statusEl = document.getElementById('grupos-status');
  const datalist = document.getElementById('nichos-existentes');

  const modal = document.getElementById('grupo-modal');
  const form = document.getElementById('grupo-form');
  const modalTitulo = document.getElementById('modal-titulo');

  const campos = {
    id: document.getElementById('g-id'),
    nome: document.getElementById('g-nome'),
    nicho: document.getElementById('g-nicho'),
    url: document.getElementById('g-url'),
    key: document.getElementById('g-key'),
    obs: document.getElementById('g-obs'),
    padrao: document.getElementById('g-padrao'),
    ativo: document.getElementById('g-ativo'),
  };

  let grupos = [];
  let nichoAtivo = 'todos';

  function escapeHtml(t) {
    return String(t || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function mostrarStatus(msg, tipo = 'ok') {
    statusEl.textContent = msg;
    statusEl.className =
      'mt-4 rounded-lg px-4 py-2.5 text-sm ' +
      (tipo === 'erro'
        ? 'border border-rose-500/30 bg-rose-500/10 text-rose-200'
        : 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-200');
    statusEl.classList.remove('hidden');
    if (tipo === 'ok') setTimeout(() => statusEl.classList.add('hidden'), 4000);
  }

  async function api(url, opts = {}) {
    const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Falha (${res.status})`);
    return data;
  }

  async function carregar() {
    try {
      const data = await api(API);
      grupos = data.grupos || [];
      render();
    } catch (err) {
      mostrarStatus(err.message, 'erro');
    }
  }

  function nichos() {
    return [...new Set(grupos.map((g) => (g.nicho || 'Sem nicho').trim()).filter(Boolean))].sort();
  }

  function renderFiltros() {
    const lista = nichos();
    const chip = (val, label, count) => {
      const ativo = nichoAtivo === val;
      return `<button type="button" class="chip-nicho rounded-full px-3 py-1 text-[11px] font-medium transition ${
        ativo ? 'bg-emerald-500 text-slate-950' : 'border border-slate-700 text-slate-300 hover:border-slate-500'
      }" data-nicho="${escapeHtml(val)}">${escapeHtml(label)} (${count})</button>`;
    };
    const html = [chip('todos', 'Todos', grupos.length)];
    for (const n of lista) {
      html.push(chip(n, n, grupos.filter((g) => (g.nicho || 'Sem nicho') === n).length));
    }
    filtroEl.innerHTML = html.join('');
    if (datalist) {
      datalist.innerHTML = lista
        .filter((n) => n !== 'Sem nicho')
        .map((n) => `<option value="${escapeHtml(n)}"></option>`)
        .join('');
    }
  }

  function cardGrupo(g) {
    const statusPk = g.tem_profile_key
      ? '<span class="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">Conectado</span>'
      : '<span class="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-300">Sem Profile-Key</span>';
    const inativo = g.ativo ? '' : '<span class="rounded-full bg-slate-700/50 px-2 py-0.5 text-[10px] text-slate-300">Inativo</span>';
    const padrao = g.padrao ? '<span class="rounded-full bg-sky-500/15 px-2 py-0.5 text-[10px] font-semibold text-sky-300">Padrão</span>' : '';
    const erro = g.ultimo_erro
      ? `<p class="mt-1 text-[11px] text-rose-300">Último erro: ${escapeHtml(g.ultimo_erro).slice(0, 140)}</p>`
      : '';
    const link = g.url
      ? `<a href="${escapeHtml(g.url)}" target="_blank" rel="noopener" class="text-[11px] text-sky-400 hover:text-sky-300">Abrir grupo ↗</a>`
      : '';

    return `
      <article class="rounded-xl border border-slate-800 bg-slate-900/50 p-3.5 ${g.ativo ? '' : 'opacity-70'}" data-id="${g.id}">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-1.5">
              <h3 class="truncate text-sm font-semibold text-white">${escapeHtml(g.nome)}</h3>
              ${statusPk}${padrao}${inativo}
            </div>
            <p class="mt-0.5 text-[11px] text-slate-500">${escapeHtml(g.nicho || 'Sem nicho')}${link ? ' · ' : ''}${link}</p>
            ${erro}
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <label class="inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-slate-400">
              <input type="checkbox" class="toggle-padrao accent-emerald-500" data-id="${g.id}" ${g.padrao ? 'checked' : ''} /> padrão
            </label>
            <button type="button" class="btn-editar rounded-lg border border-slate-700 px-2.5 py-1 text-[11px] text-slate-300 hover:border-emerald-500 hover:text-white" data-id="${g.id}">Editar</button>
            <button type="button" class="btn-remover rounded-lg border border-rose-500/30 px-2.5 py-1 text-[11px] text-rose-300 hover:bg-rose-500/10" data-id="${g.id}">Remover</button>
          </div>
        </div>
      </article>`;
  }

  function render() {
    renderFiltros();
    vazioEl.classList.toggle('hidden', grupos.length > 0);

    const filtrados = grupos.filter((g) => {
      if (nichoAtivo === 'todos') return true;
      return (g.nicho || 'Sem nicho') === nichoAtivo;
    });

    // Agrupa por nicho
    const porNicho = {};
    for (const g of filtrados) {
      const n = g.nicho || 'Sem nicho';
      (porNicho[n] = porNicho[n] || []).push(g);
    }

    const blocos = Object.keys(porNicho)
      .sort()
      .map((n) => {
        const cards = porNicho[n].map(cardGrupo).join('');
        return `
          <section>
            <div class="mb-2 flex items-center gap-2">
              <h2 class="text-xs font-semibold uppercase tracking-wider text-slate-500">${escapeHtml(n)}</h2>
              <span class="h-px flex-1 bg-slate-800"></span>
              <span class="text-[11px] text-slate-600">${porNicho[n].length}</span>
            </div>
            <div class="grid gap-2 lg:grid-cols-2">${cards}</div>
          </section>`;
      });

    listaEl.innerHTML = blocos.join('');
  }

  /* ---------------- modal ---------------- */
  function abrirModal(g = null) {
    form.reset();
    campos.id.value = g?.id || '';
    campos.nome.value = g?.nome || '';
    campos.nicho.value = g?.nicho || '';
    campos.url.value = g?.url || '';
    campos.key.value = '';
    campos.obs.value = g?.observacoes || '';
    campos.padrao.checked = Boolean(g?.padrao);
    campos.ativo.checked = g ? Boolean(g.ativo) : true;
    campos.key.placeholder = g?.tem_profile_key
      ? 'Profile-Key já salva — preencha só para trocar'
      : 'chave do User Profile que tem este grupo conectado';
    modalTitulo.textContent = g ? 'Editar grupo' : 'Novo grupo';
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    campos.nome.focus();
  }

  function fecharModal() {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = campos.id.value;
    const payload = {
      nome: campos.nome.value.trim(),
      nicho: campos.nicho.value.trim(),
      url: campos.url.value.trim(),
      observacoes: campos.obs.value.trim(),
      padrao: campos.padrao.checked,
      ativo: campos.ativo.checked,
    };
    // Só envia a chave se foi preenchida (evita apagar a existente ao editar)
    if (campos.key.value.trim()) payload.ayrshareProfileKey = campos.key.value.trim();
    else if (!id) payload.ayrshareProfileKey = '';

    try {
      if (id) await api(`${API}/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      else await api(API, { method: 'POST', body: JSON.stringify(payload) });
      fecharModal();
      await carregar();
      mostrarStatus(id ? 'Grupo atualizado.' : 'Grupo cadastrado.');
    } catch (err) {
      mostrarStatus(err.message, 'erro');
    }
  });

  document.getElementById('btn-novo').addEventListener('click', () => abrirModal());
  document.getElementById('modal-fechar').addEventListener('click', fecharModal);
  document.getElementById('modal-cancelar').addEventListener('click', fecharModal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) fecharModal();
  });

  /* ---------------- ações da lista ---------------- */
  filtroEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.chip-nicho');
    if (!btn) return;
    nichoAtivo = btn.dataset.nicho;
    render();
  });

  listaEl.addEventListener('click', async (e) => {
    const editar = e.target.closest('.btn-editar');
    const remover = e.target.closest('.btn-remover');
    if (editar) {
      const g = grupos.find((x) => String(x.id) === editar.dataset.id);
      if (g) abrirModal(g);
      return;
    }
    if (remover) {
      const g = grupos.find((x) => String(x.id) === remover.dataset.id);
      if (!g) return;
      if (!confirm(`Remover o grupo "${g.nome}"?`)) return;
      try {
        await api(`${API}/${g.id}`, { method: 'DELETE' });
        await carregar();
        mostrarStatus('Grupo removido.');
      } catch (err) {
        mostrarStatus(err.message, 'erro');
      }
    }
  });

  listaEl.addEventListener('change', async (e) => {
    const toggle = e.target.closest('.toggle-padrao');
    if (!toggle) return;
    const id = toggle.dataset.id;
    try {
      await api(`${API}/${id}`, { method: 'PATCH', body: JSON.stringify({ padrao: toggle.checked }) });
      const g = grupos.find((x) => String(x.id) === id);
      if (g) g.padrao = toggle.checked;
    } catch (err) {
      toggle.checked = !toggle.checked;
      mostrarStatus(err.message, 'erro');
    }
  });

  carregar();
})();
