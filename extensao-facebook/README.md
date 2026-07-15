# Extensão ViralizeAI — Publicação no Facebook (sem Graph API)

Publica matérias enfileiradas no ViralizeAI usando a sessão já logada do usuário no `facebook.com` (Chrome / Edge, Manifest V3).

## Aviso

A automação clica na interface web do Facebook. Isso pode conflitar com os Termos de Uso da Meta. Use apenas na **sua** conta/Página, por sua conta e risco. O caminho via Graph API do site continua disponível.

## Pré-requisitos

1. Conta no ViralizeAI com Página Facebook conectada em `/paginas`.
2. Migrar o banco (`api_tokens`):

```bash
npm run migrate
```

3. Node do site rodando (local ou produção).

## 1. Gerar token no site

1. Entre em `/extensao`.
2. Informe um nome de dispositivo e clique em **Gerar token**.
3. **Copie o token imediatamente** (`vza_…`) — ele só aparece uma vez.

## 2. Baixar e instalar a extensão

1. No site, abra `/extensao` (logado) e clique em **Baixar extensão (.zip)**  
   — ou acesse diretamente `/extensao/baixar`.
2. Descompacte o ZIP. A pasta será `viralizeai-extensao-facebook`.
3. Instale no navegador:

### Chrome

1. Abra `chrome://extensions`
2. Ative **Modo do desenvolvedor**
3. **Carregar sem compactação** → selecione a pasta descompactada

### Edge

1. Abra `edge://extensions`
2. Ative **Modo do desenvolvedor**
3. **Carregar expansão descompactada** → pasta descompactada

> Em desenvolvimento local você também pode carregar a pasta `extensao-facebook/` do repositório sem baixar o ZIP.

## 3. Conectar

1. Abra o popup da extensão.
2. **URL da API**: `https://www.viralizeai.online` (ou `http://localhost:3010` em local).
3. Cole o token e clique em **Conectar**.
4. Escolha a Página cujo `page_id` corresponde à aba aberta no Facebook.

## 4. Enfileirar e publicar

1. Edite uma matéria → **Enviar para extensão** (status `pronto`).
2. No Facebook, abra a **Página** correta (feed da Página, logado como a Página ou pronto para postar nela).
3. No popup: **Atualizar fila** → **Publicar** ou **Publicar próxima**.
4. Opcional: ative **Publicação automática** (intervalo mínimo **3 minutos**).

## API usada pela extensão

Todas com `Authorization: Bearer <token>`:

| Método | Rota | Uso |
|--------|------|-----|
| GET | `/api/extensao/paginas` | Páginas do usuário |
| GET | `/api/extensao/pendentes?page_id=` | Fila (`pronto` / `agendado` vencido) |
| POST | `/api/extensao/matters/:id/heartbeat` | Evita duplicidade |
| POST | `/api/extensao/matters/:id/resultado` | Sucesso ou erro |

Gestão de tokens (sessão do site): `POST/GET /api/extensao/tokens`, `POST /api/extensao/tokens/:id/revogar`.

## Troubleshooting

| Sintoma | O que checar |
|---------|----------------|
| Token inválido | Gere outro em `/extensao`; token antigo pode ter sido revogado |
| Composer não encontrado | Estar no feed da Página certa; UI do FB mudou — atualize seletores em `content.js` |
| Timeout na imagem | URL `/media/...` precisa ser acessível pela extensão (domínio em `host_permissions`) |
| Intervalo mínimo | Auto/manual respeitam ≥ 3 min entre posts |
| Outra extensão publicando | Heartbeat 3 min — aguarde ou use só um navegador |

## Estrutura

```
extensao-facebook/
  manifest.json
  popup.html / popup.js / popup.css
  background.js          # polling, heartbeat, resultado
  content.js             # composer no facebook.com
  icons/
  README.md
```

Após alterar arquivos da extensão, em `chrome://extensions` clique em **Recarregar** na extensão.
