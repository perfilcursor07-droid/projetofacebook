(function () {
  const initialEl = document.getElementById('claude-initial-status');
  if (!initialEl) return;

  const $ = (id) => document.getElementById(id);
  const buttons = Array.from(document.querySelectorAll('[data-action]'));
  const feedback = $('claude-feedback');
  const progress = $('claude-auth-progress');
  const loginDone = $('claude-login-done');
  const importInput = $('claude-session-file');
  const importButton = $('claude-import-session');
  let busy = false;
  let currentStatus = {};

  try {
    currentStatus = JSON.parse(initialEl.textContent || '{}');
  } catch {
    currentStatus = {};
  }

  const toneClasses = {
    good: ['border-emerald-500/30', 'bg-emerald-500/10', 'text-emerald-300'],
    warn: ['border-amber-500/30', 'bg-amber-500/10', 'text-amber-300'],
    bad: ['border-rose-500/30', 'bg-rose-500/10', 'text-rose-300'],
    neutral: ['border-slate-700', 'bg-slate-800/60', 'text-slate-400'],
  };
  const allToneClasses = Object.values(toneClasses).flat();

  function setBadge(id, label, tone) {
    const el = $(id);
    if (!el) return;
    el.textContent = label;
    el.classList.remove(...allToneClasses);
    el.classList.add(...(toneClasses[tone] || toneClasses.neutral));
  }

  function formatDate(value) {
    if (!value) return 'sem data registrada';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'sem data registrada';
    return date.toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function setFeedback(message, tone) {
    if (!feedback) return;
    if (!message) {
      feedback.classList.add('hidden');
      return;
    }
    feedback.textContent = message;
    feedback.className = 'mt-5 rounded-xl border px-4 py-3 text-sm';
    feedback.classList.add(...(toneClasses[tone] || toneClasses.neutral));
  }

  function syncButtons() {
    const authStatus = currentStatus?.autorizacao?.status;
    const gateway = currentStatus?.gateway || {};
    const chrome = currentStatus?.chrome || {};
    const authActive = authStatus === 'running' || authStatus === 'waiting_login';
    const ferramentasProntas =
      gateway.cliDisponivel !== false &&
      gateway.bunDisponivel !== false &&
      gateway.chromeInstalado !== false;
    buttons.forEach((button) => {
      const action = button.dataset.action;
      const precisaCli = ['start', 'restart', 'authorize', 'switch', 'continue'].includes(action);
      const precisaGatewayOnline = action === 'test';
      const precisaLoginVisual = ['authorize', 'switch', 'continue'].includes(action);
      button.disabled =
        busy ||
        (authActive && action !== 'continue') ||
        (precisaCli && !ferramentasProntas) ||
        (precisaGatewayOnline && gateway.online !== true) ||
        (precisaLoginVisual && chrome.loginVisualDisponivel === false);
    });
    if (loginDone) {
      loginDone.classList.toggle('hidden', authStatus !== 'waiting_login');
      loginDone.disabled =
        busy ||
        authStatus !== 'waiting_login' ||
        !ferramentasProntas ||
        chrome.loginVisualDisponivel === false;
    }
    if (importButton) importButton.disabled = busy || !importInput?.files?.length;
  }

  function render(status) {
    currentStatus = status || {};
    const gateway = currentStatus.gateway || {};
    const chrome = currentStatus.chrome || {};
    const claude = currentStatus.claude || {};
    const security = currentStatus.seguranca || {};
    const auth = currentStatus.autorizacao || {};

    const installAlert = $('gateway-install-alert');
    installAlert?.classList.toggle('hidden', !gateway.pendencia);
    if ($('gateway-install-message')) $('gateway-install-message').textContent = gateway.pendencia || '';

    setBadge('gateway-badge', gateway.online ? 'Online' : 'Offline', gateway.online ? 'good' : 'bad');
    $('gateway-title').textContent = gateway.online ? 'Serviço respondendo' : 'Serviço indisponível';
    $('gateway-detail').textContent = gateway.online
      ? `${gateway.url || 'Gateway local'} · ${gateway.status || 'ok'}`
      : gateway.pendencia || gateway.erro || 'Pronto para iniciar.';

    setBadge('chrome-badge', chrome.conectado ? 'Conectado' : 'Desconectado', chrome.conectado ? 'good' : 'warn');
    $('chrome-title').textContent = chrome.conectado ? 'Navegador disponível' : 'Aguardando navegador';
    $('chrome-detail').textContent = !gateway.chromeInstalado
      ? 'Chrome/Chromium não instalado neste servidor.'
      : chrome.modoHeadless
        ? `${chrome.cdpUrl || 'CDP local'} · modo headless`
        : chrome.cdpUrl || 'CDP local não informado';

    if ($('claude-authorize-hint')) {
      $('claude-authorize-hint').textContent = chrome.loginVisualDisponivel === false
        ? 'Indisponível sem desktop; importe a sessão acima.'
        : 'Atualiza a sessão usando a conta já aberta no Chrome.';
    }
    if ($('claude-switch-hint')) {
      $('claude-switch-hint').textContent = chrome.loginVisualDisponivel === false
        ? 'Troque a conta no seu computador e importe a nova sessão.'
        : 'Sai somente do Claude no Chrome isolado e pede outra conta.';
    }

    let claudeTone = 'bad';
    let claudeBadge = 'Não autorizada';
    let claudeTitle = 'Faça o login no Claude';
    if (claude.valida === true) {
      claudeTone = 'good';
      claudeBadge = 'Válida';
      claudeTitle = 'Sessão pronta para uso';
    } else if (claude.valida === false) {
      claudeTone = 'bad';
      claudeBadge = 'Expirada';
      claudeTitle = 'É necessário entrar novamente';
    } else if (claude.autorizada) {
      claudeTone = 'warn';
      claudeBadge = 'Salva';
      claudeTitle = 'Sessão salva, ainda não validada';
    }
    setBadge('claude-badge', claudeBadge, claudeTone);
    $('claude-title').textContent = claudeTitle;
    $('claude-detail').textContent = claude.motivo || `Atualizada em ${formatDate(claude.atualizadaEm)}`;

    setBadge('model-badge', claude.modeloDisponivel ? 'Disponível' : 'Indisponível', claude.modeloDisponivel ? 'good' : 'warn');
    $('model-title').textContent = claude.modelo || 'claude-sonnet-5';
    $('model-detail').textContent = claude.modeloDisponivel
      ? 'Modelo listado pelo gateway.'
      : 'Inicie e autorize o gateway para confirmar o modelo.';

    const authVisible = ['running', 'waiting_login', 'success', 'error'].includes(auth.status);
    progress?.classList.toggle('hidden', !authVisible);
    if ($('claude-auth-label')) {
      $('claude-auth-label').textContent = auth.status === 'error' ? 'Falha na autorização' : 'Autorização do Claude';
    }
    if ($('claude-auth-message')) $('claude-auth-message').textContent = auth.message || '';

    const securityParts = [
      security.credencialForaDoPublico
        ? 'Credencial fora da pasta pública.'
        : 'Atenção: revise o local da credencial.',
      security.apiKeyProtegida
        ? 'Gateway protegido por Bearer token.'
        : 'Gateway sem Bearer token: mantenha a porta 3456 acessível somente localmente.',
    ];
    $('claude-security-status').textContent = securityParts.join(' ');
    syncButtons();
  }

  async function request(path, options) {
    const response = await fetch(`/api/admin/claude-gateway${path}`, {
      method: options?.method || 'GET',
      headers: {
        Accept: 'application/json',
        ...(options?.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(options?.body ? { body: JSON.stringify(options.body) } : {}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Falha HTTP ${response.status}`);
    return data;
  }

  async function refresh(silent) {
    try {
      const data = await request('/status');
      render(data);
      if (!silent) setFeedback('Status atualizado.', 'good');
    } catch (err) {
      if (!silent) setFeedback(err.message, 'bad');
    }
  }

  async function runAction(action) {
    if (busy) return;
    let path;
    let body;
    let pendingMessage;

    if (action === 'start') {
      path = '/start';
      pendingMessage = 'Iniciando o gateway…';
    } else if (action === 'restart') {
      path = '/restart';
      pendingMessage = 'Reiniciando o gateway…';
    } else if (action === 'test') {
      path = '/test';
      pendingMessage = 'Testando o Sonnet 5…';
    } else if (action === 'authorize') {
      path = '/authorize';
      body = { trocarConta: false };
      pendingMessage = 'Abrindo o Chrome para entrar no Claude…';
    } else if (action === 'switch') {
      const confirmed = window.confirm(
        'Trocar a conta do Claude? Isso apagará somente a sessão do Claude no Chrome isolado e abrirá uma nova tela de login.'
      );
      if (!confirmed) return;
      path = '/authorize';
      body = { trocarConta: true };
      pendingMessage = 'Removendo a sessão atual e abrindo o Chrome…';
    } else if (action === 'continue') {
      path = '/authorize/continue';
      pendingMessage = 'Confirmando o login do Claude…';
    } else {
      return;
    }

    busy = true;
    syncButtons();
    setFeedback(pendingMessage, 'neutral');
    try {
      const data = await request(path, { method: 'POST', body });
      const answer = data.resposta ? `${data.message} Resposta: ${data.resposta}` : data.message;
      setFeedback(answer || 'Operação iniciada.', 'good');
      await refresh(true);
    } catch (err) {
      setFeedback(err.message, 'bad');
      await refresh(true);
    } finally {
      busy = false;
      syncButtons();
    }
  }

  async function importSession() {
    const file = importInput?.files?.[0];
    if (!file || busy) return;
    if (file.size > 512000) {
      setFeedback('O arquivo de sessão excede o limite de 500 KB.', 'bad');
      return;
    }

    busy = true;
    syncButtons();
    setFeedback('Importando a sessão e preparando o gateway…', 'neutral');
    try {
      const raw = await file.text();
      const sessao = JSON.parse(raw);
      const data = await request('/import', { method: 'POST', body: { sessao } });
      setFeedback(data.message || 'Sessão importada.', data.gatewayReiniciado ? 'good' : 'warn');
      importInput.value = '';
      await refresh(true);
    } catch (err) {
      setFeedback(
        err instanceof SyntaxError ? 'O arquivo selecionado não contém JSON válido.' : err.message,
        'bad'
      );
    } finally {
      busy = false;
      syncButtons();
    }
  }

  buttons.forEach((button) => {
    button.addEventListener('click', () => runAction(button.dataset.action));
  });
  $('claude-refresh')?.addEventListener('click', () => refresh(false));
  importInput?.addEventListener('change', syncButtons);
  importButton?.addEventListener('click', importSession);

  render(currentStatus);
  window.setInterval(() => refresh(true), 5000);
})();
