# Clipador — dicas locais

## Banco
```bash
npm run migrate
npm run seed
```

Usuário seed: `admin@clipador.local` / `clipador123`

## App
```bash
npm run dev
```

## Matéria com IA (DeepSeek)

1. Preencha `DEEPSEEK_API_KEY` no `.env`.
2. Instale Python 3.9+ no PATH.
3. Instale o Whisper local (gratuito):

```bash
pip install -r scripts/requirements.txt
```

No Windows, se `pip` não achar o Python:

```bash
py -m pip install -r scripts/requirements.txt
```

Fluxo sugerido:
- Vídeo: buscar (Pexels / YouTube / TikTok `@usuario`) ou importar link → baixar → cortar → **Extrair fala** → **Gerar matéria** → revisar → publicar Reel.
- Imagem: baixar → informar tipo de matéria → **Gerar matéria** → revisar → publicar foto + texto.

### Busca YouTube / TikTok
- **YouTube:** qualquer termo em `/busca` com a fonte YouTube.
- **TikTok:** o yt-dlp não tem busca por hashtag estável; use `@usuario` para listar o perfil, ou cole o link do vídeo.
