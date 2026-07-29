/* Agenda biblioteca — sem window.confirm (ações diretas) */
(function () {
  const msgEl = document.getElementById('agenda-msg');
  const busyEl = document.getElementById('agenda-busy');
  const busyText = document.getElementById('agenda-busy-text');
  const listEl = document.getElementById('agenda-list');
  const countEl = document.getElementById('agenda-count');
  const checkAll = document.getElementById('agenda-check-all');
  const btnLoteConfirmar = document.getElementById('agenda-lote-confirmar');
  const btnLotePublicar = document.getElementById('agenda-lote-publicar');
  const btnLoteExcluir = document.getElementById('agenda-lote-excluir');

  function setBusy(on, text) {
    if (!busyEl) return;
    busyEl.classList.toggle('hidden', !on);
    if (busyText && text) busyText.textContent = text;
  }

  function setMsg(text, isError) {
    if (!msgEl) return;
    if (!text) {
      msgEl.classList.add('hidden');
      return;
    }
    msgEl.textContent = text;
    msgEl.className =
      'text-sm sm:col-span-2 lg:col-span-12 ' + (isError ? 'text-rose-300' : 'text-emerald-300');
    msgEl.classList.remove('hidden');
  }

  async function api(url, opts) {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      ...opts,
    });
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = {};
    }
    if (!res.ok) {
      const msg =
        data.error ||
        data.message ||
        (res.status === 504 || res.status === 502
          ? 'Tempo esgotado no servidor. Tente com menos itens (ex.: 10–20) e rode de novo — a agenda continua do último horário.'
          : null) ||
        (text && text.length < 200 && !text.trim().startsWith('<') ? text.trim() : null) ||
        res.statusText ||
        'Erro ao montar a agenda';
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function selectedIds() {
    return Array.from(document.querySelectorAll('.agenda-check:checked')).map((el) =>
      Number(el.value)
    );
  }

  function syncLoteButtons() {
    const n = selectedIds().length;
    const disabled = n === 0;
    [btnLoteConfirmar, btnLotePublicar, btnLoteExcluir].forEach((btn) => {
      if (btn) btn.disabled = disabled;
    });
  }

  checkAll?.addEventListener('change', () => {
    document.querySelectorAll('.agenda-check').forEach((el) => {
      el.checked = Boolean(checkAll.checked);
    });
    syncLoteButtons();
  });

  listEl?.addEventListener('change', (e) => {
    if (e.target.classList.contains('agenda-check')) syncLoteButtons();
  });

  document.getElementById('agenda-montar-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const page = document.getElementById('agenda-page')?.value || '';
    const max = Number(document.getElementById('agenda-max')?.value || 20);
    if (!page) {
      setMsg('Selecione a Página do Facebook.', true);
      return;
    }
    try {
      setBusy(true, 'Montando agenda de amanhã (pode demorar se for gerar várias matérias)…');
      setMsg('');
      const data = await api('/api/biblioteca/agenda/montar', {
        method: 'POST',
        body: JSON.stringify({
          facebook_page_id: page,
          max_itens: max,
          somente_sites: true,
        }),
      });
      const de = data.de ? String(data.de).replace('T', ' ') : null;
      const ate = data.ate ? String(data.ate).replace('T', ' ') : null;
      const cont = data.continuidade
        ? ` (após ${String(data.continuidade).replace('T', ' ')})`
        : '';
      setMsg(
        `${data.criados || 0} item(ns) pré-agendado(s)${cont}` +
          (de && ate ? `: ${de} → ${ate}` : data.dia ? ` para ${data.dia}` : '') +
          '.' +
          (data.erros?.length ? ` ${data.erros.length} aviso(s)/falha(s).` : ''),
        false
      );
      location.reload();
    } catch (err) {
      setMsg(err.message, true);
    } finally {
      setBusy(false);
    }
  });

  async function runLote(acao) {
    const ids = selectedIds();
    if (!ids.length) return;
    try {
      setBusy(true, 'Aplicando ação em lote…');
      const data = await api('/api/biblioteca/agenda/lote', {
        method: 'POST',
        body: JSON.stringify({ ids, acao }),
      });
      const fail = data.erros?.length || 0;
      setMsg(`${data.ok || 0} ok` + (fail ? `, ${fail} erro(s)` : ''), fail > 0);
      location.reload();
    } catch (err) {
      setMsg(err.message, true);
    } finally {
      setBusy(false);
    }
  }

  btnLoteConfirmar?.addEventListener('click', () => runLote('confirmar'));
  btnLotePublicar?.addEventListener('click', () => runLote('publicar'));
  btnLoteExcluir?.addEventListener('click', () => runLote('excluir'));

  listEl?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-id]');
    if (!btn || !btn.className.includes('agenda-btn-')) return;
    const id = Number(btn.dataset.id);
    if (!id) return;

    try {
      if (btn.classList.contains('agenda-btn-confirmar')) {
        setBusy(true, 'Confirmando agendamento…');
        await api('/api/biblioteca/agenda/' + id + '/confirmar', { method: 'POST', body: '{}' });
      } else if (btn.classList.contains('agenda-btn-publicar')) {
        setBusy(true, 'Publicando…');
        await api('/api/biblioteca/agenda/' + id + '/publicar', { method: 'POST', body: '{}' });
      } else if (btn.classList.contains('agenda-btn-excluir')) {
        setBusy(true, 'Excluindo…');
        await api('/api/biblioteca/agenda/' + id, { method: 'DELETE' });
      } else {
        return;
      }
      location.reload();
    } catch (err) {
      alert(err.message);
    } finally {
      setBusy(false);
    }
  });

  let horaTimer = null;
  listEl?.addEventListener('change', async (e) => {
    const input = e.target.closest('.agenda-hora');
    if (!input) return;
    const id = Number(input.dataset.id);
    const value = input.value;
    if (!id || !value) return;
    clearTimeout(horaTimer);
    horaTimer = setTimeout(async () => {
      try {
        await api('/api/biblioteca/agenda/' + id, {
          method: 'PATCH',
          body: JSON.stringify({ proposed_at: value }),
        });
      } catch (err) {
        alert(err.message);
      }
    }, 400);
  });

  syncLoteButtons();
  if (countEl && listEl) {
    const n = listEl.querySelectorAll('.agenda-row').length;
    countEl.textContent = '(' + n + ')';
  }
})();
