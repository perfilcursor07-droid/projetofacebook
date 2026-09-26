/**
 * Abre uma aba no Chrome compartilhado (gateway, leitor de artigos, imagens
 * do ChatGPT) SEM trazê-la para a frente.
 *
 * `context.newPage()` ativa a aba nova. Como a pesquisa e as gerações de
 * imagem abrem e fecham abas o tempo todo, a janela ficava pulando entre
 * elas e o desktop do noVNC "piscava", atrapalhando quem entra para fazer
 * login. `Target.createTarget` com `background: true` cria a aba atrás da
 * atual; se algo falhar, volta ao `newPage()` comum.
 */
async function novaAbaEmSegundoPlano(browser, context) {
  let cdp = null;
  let targetId = null;
  try {
    cdp = await browser.newBrowserCDPSession();
    const antes = new Set(context.pages());
    ({ targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', background: true }));
    const limite = Date.now() + 5000;
    while (Date.now() < limite) {
      for (const pagina of context.pages()) {
        if (antes.has(pagina)) continue;
        const sessao = await context.newCDPSession(pagina).catch(() => null);
        if (!sessao) continue;
        const info = await sessao.send('Target.getTargetInfo').catch(() => null);
        await sessao.detach().catch(() => {});
        if (info?.targetInfo?.targetId === targetId) return pagina;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // Não achou a aba criada: fecha para não deixar uma aba vazia sobrando.
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  } catch {
    if (cdp && targetId) await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  } finally {
    if (cdp) await cdp.detach().catch(() => {});
  }
  return context.newPage();
}

module.exports = { novaAbaEmSegundoPlano };
