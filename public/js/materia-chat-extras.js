/**
 * Extras do chat de matérias (/materia-manual), carregado depois do
 * materia-chat.js. Não altera o chat existente: injeta os controles novos e
 * usa os elementos que já estão na página.
 *
 *  1. Botão "Em alta" ao lado de Escrever/Pautas — lista os assuntos do
 *     momento; clicar em um manda a IA escrever a matéria.
 *  2. Anexar PDF — o texto do arquivo entra no pedido enviado à IA.
 */
(() => {
  const API = '/api/materias-ia/chat-extras';
  const MAX_PDF_NO_PEDIDO = 12000;

  const el = {
    seg: document.querySelector('.mia-chat-seg'),
    tools: document.querySelector('.mia-chat-tools'),
    input: document.getElementById('chat-input'),
    enviar: document.getElementById('chat-enviar'),
    mensagens: document.getElementById('chat-mensagens'),
    vazio: document.getElementById('chat-vazio'),
    status: document.getElementById('chat-status'),
    periodo: document.getElementById('chat-periodo'),
  };

  if (!el.seg || !el.tools || !el.input || !el.enviar || !el.mensagens) return;

  let anexo = null;
  let altaAtiva = false;
  let carregandoAlta = false;

  /* ------------------------------ estilos ------------------------------ */

  const estilos = document.createElement('style');
  estilos.textContent = `
    .mia-x-anexo-btn, .mia-x-alta-btn { cursor: pointer; }
    .mia-x-chip {
      display: inline-flex; align-items: center; gap: .4rem;
      max-width: 100%; margin-top: .5rem; padding: .35rem .5rem .35rem .6rem;
      border: 1px solid rgba(16,185,129,.35); border-radius: .6rem;
      background: rgba(16,185,129,.1); color: #a7f3d0;
      font-size: .75rem; line-height: 1.3;
    }
    .mia-x-chip-nome { max-width: 16rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mia-x-chip-meta { color: #6ee7b7; opacity: .75; }
    .mia-x-chip-x {
      display: flex; align-items: center; justify-content: center;
      width: 1.1rem; height: 1.1rem; border: none; border-radius: .3rem;
      background: transparent; color: #6ee7b7; cursor: pointer; font-size: .9rem; line-height: 1;
    }
    .mia-x-chip-x:hover { background: rgba(244,63,94,.2); color: #fecdd3; }
    .mia-x-alta { border: 1px solid #1e293b; border-radius: .9rem; background: rgba(2,6,23,.4); padding: .75rem; }
    .mia-x-alta-head { display: flex; align-items: center; justify-content: space-between; gap: .75rem; margin-bottom: .6rem; }
    .mia-x-alta-title { margin: 0; font-size: .7rem; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: #64748b; }
    .mia-x-alta-list { display: flex; flex-direction: column; gap: .5rem; }
    .mia-x-card {
      display: flex; gap: .6rem; width: 100%; text-align: left;
      border: 1px solid #1e293b; border-radius: .75rem; background: rgba(15,23,42,.55);
      padding: .6rem .7rem; cursor: pointer; transition: border-color .15s, background .15s;
    }
    .mia-x-card:hover { border-color: rgba(16,185,129,.55); background: rgba(15,23,42,.9); }
    .mia-x-card-pos {
      flex-shrink: 0; display: flex; align-items: center; justify-content: center;
      width: 1.4rem; height: 1.4rem; border-radius: .4rem;
      background: rgba(16,185,129,.12); color: #6ee7b7;
      font-size: .68rem; font-weight: 700; font-variant-numeric: tabular-nums;
    }
    .mia-x-card-txt { min-width: 0; flex: 1; }
    .mia-x-card-tit { display: block; font-size: .8125rem; font-weight: 500; line-height: 1.35; color: #e2e8f0; }
    .mia-x-card-meta { display: block; margin-top: .2rem; font-size: .65rem; color: #64748b; }
    .mia-x-card-res { display: block; margin-top: .25rem; font-size: .7rem; line-height: 1.4; color: #94a3b8; }
    .mia-x-alta-erro { font-size: .75rem; color: #fecdd3; }
  `;
  document.head.appendChild(estilos);

  /* ------------------------------ helpers ------------------------------ */

  function setStatus(texto) {
    if (el.status) el.status.textContent = texto || '';
  }

  async function apiJson(url, opts = {}) {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    const bruto = await res.text();
    let data = null;
    try {
      data = bruto ? JSON.parse(bruto) : null;
    } catch {
      data = null;
    }
    if (!res.ok) throw new Error(data?.error || `Falha na requisição (${res.status})`);
    return data;
  }

  function botaoModo(nome) {
    return document.querySelector(`.chat-modo-btn[data-chat-modo="${nome}"]`);
  }

  /* --------------------------- botão "Em alta" -------------------------- */

  const btnAlta = document.createElement('button');
  btnAlta.type = 'button';
  btnAlta.className = 'mia-chat-seg-btn mia-x-alta-btn';
  btnAlta.setAttribute('aria-pressed', 'false');
  btnAlta.title = 'Lista os assuntos que estão em alta agora para você escolher';
  btnAlta.textContent = 'Em alta';
  el.seg.appendChild(btnAlta);

  function marcarAlta(ativa) {
    altaAtiva = ativa;
    btnAlta.setAttribute('aria-pressed', ativa ? 'true' : 'false');
    btnAlta.classList.toggle('is-active', ativa);
    if (ativa) {
      // Os dois modos nativos saem do estado ativo enquanto o radar manda.
      document.querySelectorAll('.chat-modo-btn').forEach((b) => {
        b.classList.remove('is-active');
        b.setAttribute('aria-pressed', 'false');
      });
      el.input.placeholder = 'Opcional: filtre o radar por um tema. Ex.: pastor, gospel';
    } else {
      el.input.placeholder = 'Descreva o assunto, cole um link ou peça um ajuste…';
    }
  }

  // Voltar para Escrever/Pautas desliga o radar.
  document.querySelectorAll('.chat-modo-btn').forEach((b) => {
    b.addEventListener('click', () => marcarAlta(false));
  });

  function limparBlocosAlta() {
    el.mensagens.querySelectorAll('[data-mia-alta="1"]').forEach((n) => n.remove());
  }

  function pedirMateriaDoTopico(topico) {
    marcarAlta(false);
    botaoModo('escrever')?.click();
    el.input.value = [
      'Escreva uma matéria sobre este assunto que está em alta agora, com furo de reportagem, texto totalmente original e sem plagiar:',
      `Título: ${topico.titulo || ''}`,
      `Veículo: ${topico.veiculo || ''}`,
      `Link: ${topico.url || ''}`,
      'Pesquise também mais informações recentes sobre esse assunto para acrescentar contexto e dados novos.',
    ].join('\n');
    el.input.dispatchEvent(new Event('input', { bubbles: true }));
    el.enviar.click();
  }

  function renderAlta({ topicos, horas, totalAnalisado }) {
    limparBlocosAlta();
    el.vazio?.classList.add('hidden');

    const wrap = document.createElement('div');
    wrap.className = 'mia-msg-ai';
    wrap.dataset.miaAlta = '1';

    const corpo = document.createElement('div');
    corpo.className = 'mia-msg-ai-body';
    const p = document.createElement('p');
    p.textContent = topicos.length
      ? `Estes são os ${topicos.length} assuntos mais quentes das últimas ${horas}h (${totalAnalisado} analisados). Clique em um e eu escrevo a matéria.`
      : `Não achei nada em alta nas últimas ${horas}h. Tente de novo em alguns minutos ou filtre por um tema no campo de texto.`;
    corpo.appendChild(p);
    wrap.appendChild(corpo);

    if (topicos.length) {
      const box = document.createElement('div');
      box.className = 'mia-x-alta';

      const head = document.createElement('div');
      head.className = 'mia-x-alta-head';
      const titulo = document.createElement('p');
      titulo.className = 'mia-x-alta-title';
      titulo.textContent = `Em alta agora (${topicos.length})`;
      head.appendChild(titulo);
      const recarregar = document.createElement('button');
      recarregar.type = 'button';
      recarregar.className = 'mia-chat-ghost-btn';
      recarregar.textContent = 'Atualizar';
      recarregar.addEventListener('click', () => carregarAlta());
      head.appendChild(recarregar);
      box.appendChild(head);

      const lista = document.createElement('div');
      lista.className = 'mia-x-alta-list';

      topicos.forEach((t, i) => {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'mia-x-card';

        const pos = document.createElement('span');
        pos.className = 'mia-x-card-pos';
        pos.textContent = String(i + 1);
        card.appendChild(pos);

        const txt = document.createElement('span');
        txt.className = 'mia-x-card-txt';

        const tit = document.createElement('span');
        tit.className = 'mia-x-card-tit';
        tit.textContent = t.titulo;
        txt.appendChild(tit);

        const meta = document.createElement('span');
        meta.className = 'mia-x-card-meta';
        meta.textContent = [
          t.veiculo || 'Web',
          t.contagemFontes > 1 ? `${t.contagemFontes} fontes` : '',
          t.calor ? `calor ${t.calor}` : '',
        ]
          .filter(Boolean)
          .join(' · ');
        txt.appendChild(meta);

        if (t.resumo) {
          const res = document.createElement('span');
          res.className = 'mia-x-card-res';
          res.textContent = t.resumo.length > 170 ? `${t.resumo.slice(0, 170)}…` : t.resumo;
          txt.appendChild(res);
        }

        card.appendChild(txt);
        card.addEventListener('click', () => pedirMateriaDoTopico(t));
        lista.appendChild(card);
      });

      box.appendChild(lista);
      wrap.appendChild(box);
    }

    el.mensagens.appendChild(wrap);
    wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function carregarAlta() {
    if (carregandoAlta) return;
    carregandoAlta = true;
    const horas = el.periodo?.value === '24h' ? 24 : 48;
    const extras = String(el.input.value || '').replace(/\s+/g, ' ').trim();
    setStatus(extras ? `Buscando o que está em alta sobre “${extras}”…` : 'Buscando o que está em alta agora…');
    btnAlta.disabled = true;
    try {
      const data = await apiJson(`${API}/em-alta`, {
        method: 'POST',
        body: JSON.stringify({ palavrasExtras: extras, horas }),
      });
      renderAlta({
        topicos: data.topicos || [],
        horas: data.horas || horas,
        totalAnalisado: data.totalAnalisado || 0,
      });
      setStatus(`${(data.topicos || []).length} assunto(s) em alta`);
    } catch (err) {
      setStatus(err.message || 'Falha ao buscar o radar');
    } finally {
      carregandoAlta = false;
      btnAlta.disabled = false;
    }
  }

  btnAlta.addEventListener('click', () => {
    marcarAlta(true);
    carregarAlta();
  });

  /* ---------------------------- anexo em PDF ---------------------------- */

  const inputArquivo = document.createElement('input');
  inputArquivo.type = 'file';
  inputArquivo.accept = 'application/pdf,.pdf';
  inputArquivo.hidden = true;
  document.body.appendChild(inputArquivo);

  const btnAnexo = document.createElement('button');
  btnAnexo.type = 'button';
  btnAnexo.className = 'mia-chat-chip mia-x-anexo-btn';
  btnAnexo.title = 'Anexar um PDF para a IA escrever a matéria com base nele';
  btnAnexo.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg> PDF';
  el.tools.appendChild(btnAnexo);

  const chipWrap = document.createElement('div');
  el.tools.parentElement?.appendChild(chipWrap);

  function renderChip() {
    chipWrap.replaceChildren();
    if (!anexo) return;

    const chip = document.createElement('span');
    chip.className = 'mia-x-chip';

    const nome = document.createElement('span');
    nome.className = 'mia-x-chip-nome';
    nome.textContent = anexo.nome;
    chip.appendChild(nome);

    const meta = document.createElement('span');
    meta.className = 'mia-x-chip-meta';
    meta.textContent = [
      anexo.paginas ? `${anexo.paginas} pág.` : '',
      anexo.truncado ? 'texto cortado' : '',
    ]
      .filter(Boolean)
      .join(' · ');
    chip.appendChild(meta);

    const fechar = document.createElement('button');
    fechar.type = 'button';
    fechar.className = 'mia-x-chip-x';
    fechar.setAttribute('aria-label', `Remover ${anexo.nome}`);
    fechar.textContent = '×';
    fechar.addEventListener('click', () => {
      anexo = null;
      renderChip();
      setStatus('PDF removido.');
    });
    chip.appendChild(fechar);

    chipWrap.appendChild(chip);
  }

  btnAnexo.addEventListener('click', () => inputArquivo.click());

  inputArquivo.addEventListener('change', async () => {
    const arquivo = inputArquivo.files?.[0];
    inputArquivo.value = '';
    if (!arquivo) return;

    btnAnexo.disabled = true;
    setStatus(`Lendo ${arquivo.name}…`);
    try {
      const dados = new FormData();
      dados.append('arquivo', arquivo);
      const res = await fetch(`${API}/anexos`, { method: 'POST', body: dados });
      const bruto = await res.text();
      let data = null;
      try {
        data = bruto ? JSON.parse(bruto) : null;
      } catch {
        data = null;
      }
      if (!res.ok) throw new Error(data?.error || `Falha ao enviar o PDF (${res.status})`);

      anexo = data.anexo;
      renderChip();
      setStatus(
        `PDF pronto: ${anexo.nome}. Escreva o que quer e envie — a matéria sai com base nele.`
      );
      el.input.focus();
    } catch (err) {
      anexo = null;
      renderChip();
      setStatus(err.message || 'Falha ao ler o PDF');
    } finally {
      btnAnexo.disabled = false;
    }
  });

  /**
   * Injeta o conteúdo do PDF no pedido pouco antes do chat enviar.
   * Roda na fase de captura, então acontece antes do handler do materia-chat.js.
   */
  function injetarAnexoNoPedido() {
    if (!anexo || el.enviar.disabled) return;
    const base =
      String(el.input.value || '').replace(/\s+$/g, '').trim() ||
      `Faça uma matéria com base no PDF ${anexo.nome}`;
    el.input.value = [
      base,
      '',
      `--- Conteúdo do PDF anexado (${anexo.nome}) ---`,
      String(anexo.texto || '').slice(0, MAX_PDF_NO_PEDIDO),
      '--- fim do PDF ---',
      '',
      'Use o conteúdo do PDF acima como base factual da matéria. Não invente dados que não estejam nele.',
    ].join('\n');
    anexo = null;
    renderChip();
  }

  el.enviar.addEventListener('click', injetarAnexoNoPedido, true);
  el.input.addEventListener(
    'keydown',
    (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) injetarAnexoNoPedido();
    },
    true
  );
})();
