# Login do Claude no servidor

O `token-free-gateway` executa as chamadas dentro do Chrome conectado por CDP.
Por isso, uma sessão criada no Windows pode ser recusada quando é reutilizada
em outro Chrome e outro IP. Em produção, autorize a conta no Chrome do próprio
servidor.

## 1. Instalar o desktop virtual

Como `root`:

```bash
cd /home/viralizeai/htdocs/www.viralizeai.online
bash scripts/install-claude-desktop.sh
```

Como usuário `viralizeai`:

```bash
cd /home/viralizeai/htdocs/www.viralizeai.online
npm run claude-desktop:start
pm2 startOrReload ecosystem.config.cjs --only viralizeai --update-env
pm2 save
```

## 2. Abrir o desktop com segurança

No PowerShell do computador local, mantenha aberto:

```powershell
ssh -N -L 6080:127.0.0.1:6080 viralizeai@www.viralizeai.online
```

Depois abra `http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=remote`.
As portas 5900 e 6080 permanecem ligadas somente no loopback do servidor; não
as publique no CloudPanel, nginx ou firewall.

## 3. Autorizar

Em `/claude`, clique em **Entrar novamente**. Faça o login na janela do Chrome
que aparecer no desktop privado. O `webauth` detecta o cookie, salva a sessão e
reinicia o gateway automaticamente.

Para diagnosticar sem exibir credenciais:

```bash
npm run check:claude-production
npm run check:claude-production -- --chat
```
