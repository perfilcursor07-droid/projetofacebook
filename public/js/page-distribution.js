(() => {
  'use strict';
  const panel = document.querySelector('[data-page-distribution]');
  if (!panel) return;
  const mode = panel.dataset.pageDistribution;
  const content = panel.querySelector('[data-pd-content]');
  const status = panel.querySelector('[data-pd-status]');
  const base = '/api/page-distribution';
  let data;
  let busy = false;
  let timer;
  const el = (tag, text, cls) => {
    const n = document.createElement(tag);
    if (text != null) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  };
  const say = (text, error = false) => { status.textContent = text; status.classList.toggle('pd-error', error); };
  async function request(url, method = 'GET', body) {
    const form = body instanceof FormData;
    const res = await fetch(base + url, { method, headers: form ? {} : { 'Content-Type': 'application/json' },
      ...(body ? { body: form ? body : JSON.stringify(body) } : {}) });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Não foi possível concluir.');
    return result;
  }
  function button(label, action, primary = false) {
    const b = el('button', label, primary ? 'pd-primary' : '');
    b.type = 'button';
    b.addEventListener('click', async () => {
      if (busy) return;
      busy = true; b.disabled = true;
      try { await action(); } catch (e) { say(e.message, true); }
      finally { busy = false; b.disabled = false; }
    });
    return b;
  }
  function link(label, href) {
    const a = el('a', label, 'pd-button'); a.href = href; return a;
  }
  function checkbox(label, checked) {
    const wrap = el('label'); const input = el('input'); input.type = 'checkbox'; input.checked = checked;
    wrap.append(input, el('span', label)); return { wrap, input };
  }
  function renderSettings() {
    content.replaceChildren();
    const enabled = checkbox('Ativar versões por página nesta conta', data.enabled);
    content.append(enabled.wrap);
    const list = el('div', null, 'pd-grid');
    const checks = data.pages.map((p) => {
      const c = checkbox(p.name, p.selected); c.input.value = p.id; list.append(c.wrap); return c.input;
    });
    content.append(list, button('Salvar páginas', async () => {
      data = await request('/settings', 'PUT', { enabled: enabled.input.checked,
        pageIds: checks.filter((c) => c.checked).map((c) => Number(c.value)) });
      renderSettings(); say('Configuração salva. O envio acontece somente ao publicar no editor.');
    }, true), link('Definir marca por página', '/minha-marca'));
    say(data.pages.length ? 'A seleção vale para o botão Publicar das matérias. Agendamentos continuam individuais.' : 'Conecte uma página primeiro.');
  }
  function field(parent, label, value, type = 'text') {
    const wrap = el('label', null, 'pd-field'); const input = el('input'); input.type = type;
    input.value = value || ''; wrap.append(el('span', label), input); parent.append(wrap); return input;
  }
  function renderBrands() {
    content.replaceChildren();
    const selected = data.pages.filter((p) => p.selected);
    if (!selected.length) { content.append(link('Selecionar páginas', '/paginas')); say('Marque as páginas em Páginas para configurar suas marcas.'); return; }
    selected.forEach((p) => {
      const block = el('details', null, 'pd-item');
      block.append(el('summary', p.name + (p.brand ? ' · Marca própria' : ' · Marca da conta')));
      const custom = checkbox('Usar marca própria nesta página', Boolean(p.brand)); block.append(custom.wrap);
      const grid = el('div', null, 'pd-grid'); block.append(grid);
      const modelWrap = el('label', null, 'pd-field'); const model = el('select');
      data.models.forEach((m) => { const option = el('option', m.name); option.value = m.id; model.append(option); });
      model.value = p.brand?.model || data.defaults?.model || data.models[0].id;
      modelWrap.append(el('span', 'Modelo da arte'), model); grid.append(modelWrap);
      const name = field(grid, 'Nome da marca', p.brand?.name ?? p.name);
      const primary = field(grid, 'Cor principal', p.brand?.primary || data.defaults?.primary || '#ffbd59', 'color');
      const secondary = field(grid, 'Cor secundária', p.brand?.secondary || data.defaults?.secondary || '#fb923c', 'color');
      const category = field(grid, 'Categoria', p.brand?.category ?? 'ÚLTIMAS');
      const footer = field(grid, 'Rodapé', p.brand?.footer ?? '');
      const logo = field(grid, 'Logo própria (opcional)', '', 'file'); logo.accept = 'image/png,image/jpeg,image/webp';
      const toggle = () => { grid.hidden = !custom.input.checked; }; custom.input.addEventListener('change', toggle); toggle();
      block.append(el('p', 'Fonte, tamanho e detalhes do modelo são copiados da Minha marca salva ao salvar esta configuração. Sem nova logo, mantém a própria ou copia a da conta. As versões já preparadas conservam a marca usada.', 'pd-help'));
      block.append(button('Salvar marca desta página', async () => {
        const payload = { custom: custom.input.checked, model: model.value, name: name.value,
          primary: primary.value, secondary: secondary.value, category: category.value, footer: footer.value };
        const form = new FormData(); form.append('config', JSON.stringify(payload));
        if (logo.files[0] && custom.input.checked) form.append('logo', logo.files[0]);
        data = await request('/brands/' + p.id, 'PUT', form);
        renderBrands(); say('Marca salva para ' + p.name + '. Será aplicada nas próximas versões.');
      }, true));
      content.append(block);
    });
    say('Opcional: cada página pode ter seu modelo, suas cores e sua logo.');
  }
  const states = { pending: 'Aguardando preparo', queued: 'Na fila de preparo', preparing: 'Criando e conferindo',
    ready: 'Pronta para revisar', error: 'Preparo não concluído', sending: 'Enviando', sent: 'Enviada', blocked: 'Não enviada — corrigir bloqueio', uncertain: 'Conferir envio na página' };
  const url = '/matters/' + Number(panel.dataset.matterId);
  async function refresh() {
    data = await request(url); renderEditor();
    clearTimeout(timer);
    if (data.items.some((i) => ['queued', 'preparing', 'sending'].includes(i.state))) {
      timer = setTimeout(() => refresh().catch((e) => say(e.message + ' Use Atualizar andamento.', true)), 4000);
    }
  }
  function ready() {
    return data.pages.length > 0 && data.pages.every((p) => data.items.some((i) => Number(i.pageId) === Number(p.id) &&
      (['sent', 'sending', 'uncertain', 'blocked'].includes(i.state) || i.state === 'ready' && !i.stale)));
  }
  async function prepare() {
    await window.saveMatterForDistribution?.();
    say('Preparando títulos, textos e artes por página…');
    await request(url + '/prepare', 'POST', {}); await refresh();
    say('Preparo iniciado. Você pode continuar no editor; somente este painel será atualizado.');
  }
  async function publish() {
    await window.saveMatterForDistribution?.();
    await refresh();
    if (!ready()) { await prepare(); say('Versões em preparo. Quando estiverem prontas, clique em Publicar nas páginas.'); return; }
    if (!data.items.some((i) => i.selected && i.state === 'ready')) {
      say('Nenhuma versão pronta para enviar. Nas bloqueadas, corrija o motivo e use Liberar nova tentativa.', true); return;
    }
    await request(url + '/publish', 'POST', {}); await refresh();
    say('Envio iniciado. Acompanhe o resultado de cada página abaixo.');
  }
  function renderEditor() {
    const open = new Set([...content.querySelectorAll('details[open]')].map((e) => e.dataset.item));
    content.replaceChildren();
    if (data.sourceId) {
      content.append(link('Abrir matéria principal', '/materias-ia/' + data.sourceId));
      say('Esta é uma versão exclusiva de uma página.'); return;
    }
    if (!data.enabled) {
      content.append(link('Configurar páginas', '/paginas')); say('Desativado. A publicação usa o destino individual da matéria.'); return;
    }
    content.append(el('p', 'Facebook: ' + data.pages.map((p) => p.name).join(', '), 'pd-help'));
    content.append(el('p', 'A principal fica preservada. Cada versão terá seu próprio registro em Matérias salvas. Nos Reels, o vídeo é mantido; título e legenda variam.', 'pd-help'));
    content.append(button('Preparar versões', prepare), button('Publicar nas ' + data.pages.length + ' páginas', publish, true),
      button('Atualizar andamento', refresh), link('Configurar destinos', '/paginas'));
    data.items.forEach((i) => {
      const item = el('details', null, 'pd-item'); item.dataset.item = String(i.id); item.open = open.has(String(i.id));
      item.append(el('summary', i.pageName + ' · ' + (states[i.state] || i.state) + (!i.selected ? ' · Fora da seleção' : '') + (i.stale && i.state === 'ready' ? ' · Principal alterada' : '')));
      if (i.title) item.append(el('strong', i.title));
      if (i.image && (/^https?:\/\//i.test(i.image) || /^\/media\//.test(i.image))) { const image = el('img'); image.src = i.image; image.alt = 'Arte para ' + i.pageName; image.loading = 'lazy'; item.append(image); }
      if (i.text) item.append(el('p', i.text));
      if (i.error) item.append(el('p', i.error, 'pd-error'));
      if (i.selected && ['blocked', 'uncertain'].includes(i.state)) {
        if (/Profile Key/i.test(i.error || '')) item.append(link('Configurar Profile Key', '/paginas'));
        if (/identity verification/i.test(i.error || '')) {
          const support = link('Concluir verificação na Meta', 'https://www.facebook.com/business-support-home');
          support.target = '_blank'; support.rel = 'noopener noreferrer'; item.append(support);
        }
        item.append(button('Liberar nova tentativa', async () => {
          const confirmed = i.state === 'uncertain'
            ? window.confirm('Você conferiu na página e no provedor que este post não foi publicado nem está pendente? Uma nova tentativa pode duplicar um envio ainda em processamento.')
            : window.confirm('O bloqueio desta página já foi resolvido? A versão será liberada para você publicar novamente.');
          if (!confirmed) return;
          await request(url + '/items/' + i.id + '/retry', 'POST', { confirmedNotPublished: i.state === 'uncertain' });
          await refresh(); say('Versão liberada. Clique em Publicar nas páginas para enviar somente as prontas.');
        }));
      }
      if (i.matterId) item.append(link('Revisar versão', '/materias-ia/' + i.matterId));
      content.append(item);
    });
    say('Gerar ou salvar não publica. Páginas já enviadas não são reenviadas pelo grupo.');
  }
  const initial = (mode === 'editor' ? refresh() : request('/settings').then((r) => {
    data = r; if (mode === 'brands') renderBrands(); else renderSettings();
  }));
  initial.catch((e) => say(e.message, true));
  if (mode === 'editor') {
    window.pageDistribution = { async handlePublish() {
      await initial;
      if (!data.enabled || data.sourceId) return false;
      if (busy) return true;
      busy = true;
      try { await publish(); panel.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
      finally { busy = false; }
      return true;
    } };
  }
})();
