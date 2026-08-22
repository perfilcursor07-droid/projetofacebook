# Token-Free Gateway no CloudPanel

O gateway e o Chrome precisam rodar no mesmo servidor do ViralizeAI. A porta
3456 permanece ligada somente em `127.0.0.1`; não publique as portas 3456 ou
9222 no proxy ou firewall.

## 1. Instalar o Chrome como root

Confirme primeiro a arquitetura:

```bash
dpkg --print-architecture
```

Em servidor Ubuntu `amd64`, baixe o pacote `.deb` oficial do Google Chrome e
instale-o pelo gerenciador de pacotes do sistema. O Chrome exige permissão de
administrador.

## 2. Preparar o gateway como usuário do site

```bash
su - viralizeai
cd /home/viralizeai/htdocs/www.viralizeai.online
npm run gateway:setup
```

O instalador adiciona Bun ao usuário quando necessário, baixa uma revisão fixa
do `token-free-gateway`, instala as dependências e aplica os ajustes do Sonnet 5,
Chrome headless e bind local.

## 3. Configurar o `.env`

Use o mesmo valor aleatório em `TFG_API_KEY` e
`TOKEN_FREE_GATEWAY_API_KEY`:

```dotenv
AI_PROVIDER=token-free
TFG_API_KEY=COLOQUE_UM_SEGREDO_LONGO_AQUI
TOKEN_FREE_GATEWAY_API_KEY=COLOQUE_O_MESMO_SEGREDO_AQUI
TOKEN_FREE_GATEWAY_BASE_URL=http://127.0.0.1:3456/v1
TOKEN_FREE_GATEWAY_MODEL=claude-sonnet-5
TOKEN_FREE_GATEWAY_TAREFAS=conversa
```

Recarregue o app depois de editar:

```bash
pm2 reload viralizeai --update-env
pm2 save
```

## 4. Importar a sessão

Em um computador com Chrome, execute `token-free-gateway webauth` e entre na
conta do Claude. Depois, em `/claude`, selecione o arquivo:

- Windows: `C:\Users\SEU-USUARIO\.token-free-gateway\auth-profiles.json`
- Linux/macOS: `~/.token-free-gateway/auth-profiles.json`

O painel importa somente `claude-web`, grava o arquivo no servidor com permissão
`0600` e tenta reiniciar o gateway. Outros perfis presentes no arquivo do
servidor são preservados.

## 5. Verificar

Na página `/claude`, os estados esperados são:

- Gateway: Online
- Chrome isolado: Conectado, modo headless
- Conta Claude: Válida
- Modelo: `claude-sonnet-5` disponível

Também é possível conferir pelo SSH:

```bash
curl http://127.0.0.1:3456/health
npm run gateway:status
```
