(function () {
  const initialEl = document.getElementById('claude-initial-status');
  if (!initialEl) return;
  const providersInitialEl = document.getElementById('ai-providers-initial');

  const $ = (id) => document.getElementById(id);
  const buttons = Array.from(document.querySelectorAll('[data-action]'));
  const providerButtons = Array.from(document.querySelectorAll('[data-ai-action]'));
  const feedback = $('claude-feedback');
  const progress = $('claude-auth-progress');
  const loginDone = $('claude-login-done');
  let busy = false;
  let currentStatus = {};
  let providerSettings = { providers: [], selectedProvider: 'claude' };
  let providerBusy = false;

  try {
    currentStatus = JSON.parse(initialEl.textContent || '{}');
  } catch {
    currentStatus = {};
  }
  try {
    providerSettings = JSON.parse(providersInitialEl?.textContent || '{}');
  } catch {
    providerSettings = { providers: [], selectedProvider: 'claude' };
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
    feedback.className = 'mt-4 rounded-lg border px-3 py-2 text-xs';
    feedback.classList.add(...(toneClasses[tone] || toneClasses.neutral));
  }

  function setProviderFeedback(message, tone) {
    const element = $('ai-provider-feedback');
    if (!element) return;
    if (!message) {
      element.classList.add('hidden');
      return;
    }
    element.textContent = message;
    element.className = 'mt-3 rounded-lg border px-3 py-2 text-xs';
    element.classList.add(...(toneClasses[tone] || toneClasses.neutral));
  }

  function providerById(provider) {
    return (providerSettings.providers || []).find((item) => item.provider === provider) || null;
  }

  function renderProviders(settings) {
    providerSettings = settings || providerSettings;
    const selected = providerById(providerSettings.selectedProvider);
    if ($('ai-selected-summary')) {
      $('ai-selected-summary').textContent = selected
        ? `${selected.label} · ${selected.model}`
        : 'Nenhum provedor selecionado';
    }

    document.querySelectorAll('[data-provider-card]').forEach((card) => {
      const provider = card.dataset.providerCard;
      const item = providerById(provider);
      if (!item) return;
      const isSelected = providerSettings.selectedProvider === provider;
      card.classList.toggle('border-violet-500/60', isSelected);
      card.classList.toggle('bg-violet-500/5', isSelected);
      card.classList.toggle('border-slate-800', !isSelected);

      const badge = card.querySelector('.ai-provider-badge');
      if (badge) {
        badge.textContent = isSelected ? 'Em uso' : item.configured ? 'Conectado' : 'Não conectado';
        badge.classList.remove(...allToneClasses);
        badge.classList.add(
          ...(toneClasses[isSelected ? 'good' : item.configured ? 'neutral' : 'warn'])
        );
      }

      const modelInput = card.querySelector('[data-provider-model]');
      if (modelInput && document.activeElement !== modelInput) modelInput.value = item.model || '';
      const keyInput = card.querySelector('[data-provider-key]');
      if (keyInput) {
        keyInput.placeholder = item.configured
          ? `Conectado${item.credentialSource ? ` via ${item.credentialSource}` : ''} — deixe vazio para manter`
          : 'Cole a chave aqui';
      }
      const remove = card.querySelector('.ai-provider-remove');
      remove?.classList.toggle('hidden', !item.configured || item.credentialSource !== 'painel');
      const select = card.querySelector('.ai-provider-select');
      if (select) {
        select.textContent = isSelected ? 'Selecionado no Matéria manual' : 'Usar no Matéria manual';
        select.disabled = providerBusy || isSelected;
        select.classList.toggle('opacity-60', isSelected);
      }
      const test = card.querySelector('.ai-provider-test');
      if (test) {
        test.textContent = item.lastTest?.at
          ? `${item.lastTest.status === 'success' ? 'Último teste aprovado' : 'Último teste falhou'} · ${formatDate(item.lastTest.at)}`
          : item.configured
            ? 'Credencial pronta para teste.'
            : 'Cadastre a credencial para conectar.';
      }
    });

    providerButtons.forEach((button) => {
      const selectedButton = button.dataset.aiAction === 'select' &&
        button.dataset.provider === providerSettings.selectedProvider;
      button.disabled = providerBusy || selectedButton;
    });
  }

  async function providerRequest(path, options = {}) {
    const response = await fetch(`/api/admin/ai-providers${path}`, {
      method: options.method || 'GET',
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Falha HTTP ${response.status}`);
    return data;
  }

  function providerForm(provider) {
    return {
      model: document.querySelector(`[data-provider-model="${provider}"]`)?.value.trim() || '',
      apiKey: document.querySelector(`[data-provider-key="${provider}"]`)?.value.trim() || '',
    };
  }

  async function refreshProviders() {
    const data = await providerRequest('');
    renderProviders(data);
    return data;
  }

  async function saveProvider(provider, { silent = false } = {}) {
    const form = providerForm(provider);
    const data = await providerRequest(`/${provider}`, {
      method: 'PUT',
      body: form,
    });
    const keyInput = document.querySelector(`[data-provider-key="${provider}"]`);
    if (keyInput) keyInput.value = '';
    await refreshProviders();
    if (!silent) setProviderFeedback(`${data.provider.label} salvo com segurança.`, 'good');
    return data;
  }

  async function runProviderAction(action, provider) {
    if (providerBusy) return;
    providerBusy = true;
    renderProviders(providerSettings);
    try {
      const form = providerForm(provider);
      if (action === 'save') {
        await saveProvider(provider);
      } else if (action === 'test') {
        if (form.apiKey) await saveProvider(provider, { silent: true });
        setProviderFeedback(`Testando ${providerById(provider)?.label || provider}…`, 'neutral');
        const data = await providerRequest(`/${provider}/test`, {
          method: 'POST',
          body: { model: form.model },
        });
        await refreshProviders();
        setProviderFeedback(data.message || 'Conexão validada.', 'good');
      } else if (action === 'select') {
        if (form.apiKey) await saveProvider(provider, { silent: true });
        const data = await providerRequest(`/${provider}/select`, {
          method: 'POST',
          body: { model: form.model },
        });
        renderProviders(data);
        setProviderFeedback(
          `${providerById(provider)?.label || provider} será usado em matérias, títulos e ajustes do Matéria manual.`,
          'good'
        );
      } else if (action === 'remove') {
        if (!window.confirm('Remover esta chave salva do servidor?')) return;
        await providerRequest(`/${provider}/key`, { method: 'DELETE' });
        await refreshProviders();
        setProviderFeedback('Chave salva removida.', 'good');
      }
    } catch (err) {
      setProviderFeedback(err.message, 'bad');
      await refreshProviders().catch(() => {});
    } finally {
      providerBusy = false;
      renderProviders(providerSettings);
    }
  }

  function syncButtons() {
    const authStatus = currentStatus?.autorizacao?.status;
    const authActive = ['running', 'waiting_login', 'waiting_browser_login'].includes(authStatus);
    buttons.forEach((button) => {
      const action = button.dataset.action;
      button.disabled = busy || (authActive && action !== 'continue');
    });
    if (loginDone) {
      loginDone.classList.toggle('hidden', authStatus !== 'waiting_login');
      loginDone.disabled = busy || authStatus !== 'waiting_login';
    }
  }

  function render(status) {
    currentStatus = status || {};
    const gateway = currentStatus.gateway || {};
    const chrome = currentStatus.chrome || {};
    const claude = currentStatus.claude || {};
    const security = currentStatus.seguranca || {};
    const auth = currentStatus.autorizacao || {};
    const desktop = currentStatus.desktop || {};

    setBadge('gateway-badge', gateway.online ? 'Online' : 'Offline', gateway.online ? 'good' : 'bad');
    $('gateway-title').textContent = gateway.online ? 'Serviço respondendo' : 'Serviço indisponível';
    $('gateway-detail').textContent = gateway.online
      ? `${gateway.url || 'Gateway local'} · ${gateway.status || 'ok'}`
      : gateway.erro || (gateway.cliDisponivel ? 'Pronto para iniciar.' : 'Código-fonte do gateway não encontrado.');

    setBadge('chrome-badge', chrome.conectado ? 'Conectado' : 'Desconectado', chrome.conectado ? 'good' : 'warn');
    $('chrome-title').textContent = chrome.conectado ? 'Navegador disponível' : 'Aguardando navegador';
    $('chrome-detail').textContent = chrome.cdpUrl || 'CDP local não informado';

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

    const desktopSection = $('claude-server-desktop');
    desktopSection?.classList.toggle('hidden', !desktop.necessario);
    if (desktop.necessario) {
      setBadge(
        'desktop-badge',
        desktop.online ? 'Online' : desktop.configurado ? 'Offline' : 'Não instalado',
        desktop.online ? 'good' : 'warn'
      );
      if ($('desktop-detail')) {
        $('desktop-detail').textContent = desktop.online
          ? `Desktop privado disponível em 127.0.0.1:${desktop.porta}.`
          : desktop.configurado
            ? 'Inicie os processos claude-xvfb, claude-vnc e claude-novnc no PM2.'
            : 'Execute o instalador do desktop privado e recarregue o PM2.';
      }
      if ($('desktop-ssh-command')) $('desktop-ssh-command').textContent = desktop.comandoSsh || '';
      if ($('desktop-open')) $('desktop-open').href = desktop.urlLocal || '#';
    }

    const authVisible = ['running', 'waiting_login', 'waiting_browser_login', 'success', 'error'].includes(auth.status);
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

  buttons.forEach((button) => {
    button.addEventListener('click', () => runAction(button.dataset.action));
  });
  providerButtons.forEach((button) => {
    button.addEventListener('click', () =>
      runProviderAction(button.dataset.aiAction, button.dataset.provider)
    );
  });
  $('claude-refresh')?.addEventListener('click', () => refresh(false));
  $('desktop-copy')?.addEventListener('click', async () => {
    const command = $('desktop-ssh-command')?.textContent || '';
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      setFeedback('Comando do túnel SSH copiado.', 'good');
    } catch {
      setFeedback('Não foi possível copiar automaticamente. Selecione o comando e copie.', 'warn');
    }
  });

  render(currentStatus);
  renderProviders(providerSettings);
  window.setInterval(() => refresh(true), 5000);
})();
