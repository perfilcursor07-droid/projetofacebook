const express = require('express');
const path = require('path');
const session = require('express-session');
const { env } = require('./config/env');
const { requireAuth, attachUser } = require('./middleware/requireAuth');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../public/views'));
// CloudPanel/nginx — cookies e IP corretos atrás do proxy
app.set('trust proxy', 1);

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.static(path.join(__dirname, '../public')));
app.use('/media', express.static(path.resolve(env.storagePath)));

const isProd = env.nodeEnv === 'production';
const { createSessionStore } = require('./config/sessionStore');
app.use(
  session({
    secret: env.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    store: createSessionStore(),
    proxy: isProd,
    cookie: {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  })
);

app.use((req, res, next) => {
  res.locals.currentPath = req.path;
  next();
});

app.use(attachUser);
app.use(require('./routes/accountPages'));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    app: 'ViralizeAI',
    pexels: Boolean(env.pexelsApiKey),
  });
});

function renderPage(res, view, title, extra = {}) {
  res.render(view, { title, ...extra });
}

app.get('/', (req, res) => {
  if (req.session.userId) return res.redirect('/dashboard');
  renderPage(res, 'index', 'Início');
});

app.get('/privacidade', (_req, res) => renderPage(res, 'privacidade', 'Política de Privacidade'));
app.get('/termos', (_req, res) => renderPage(res, 'termos', 'Termos de Serviço'));
app.get('/exclusao-dados', (_req, res) => renderPage(res, 'exclusao-dados', 'Exclusão de dados'));

app.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect('/dashboard');
  const next = String(req.query.next || '/dashboard');
  const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard';
  renderPage(res, 'login', 'Entrar', { next: safeNext, error: null });
});

app.post('/login', async (req, res, next) => {
  try {
    const authController = require('./controllers/authController');
    req.body.redirect = true;
    return authController.login(req, res);
  } catch (err) {
    next(err);
  }
});

app.get('/conteudo', requireAuth, require('./controllers/materiasIaController').listPage);
app.get('/conteudo/lote', requireAuth, require('./controllers/materiasIaController').showLotePage);
app.get('/busca', requireAuth, (_req, res) => renderPage(res, 'busca', 'Vídeo e imagem'));
app.get('/materias-ia', requireAuth, require('./controllers/materiasIaController').listPage);
app.get('/biblioteca', requireAuth, require('./controllers/bibliotecaController').listPage);
app.get('/biblioteca/fontes/:id', requireAuth, require('./controllers/bibliotecaController').fontePage);
app.get('/biblioteca/preparar/:postId', requireAuth, require('./controllers/bibliotecaController').prepararPage);
app.get('/minhas-materias', requireAuth, require('./controllers/materiasIaController').listMinhasMaterias);
app.get('/materias-ia/:id', requireAuth, require('./controllers/materiasIaController').showMatter);
app.get('/fila', requireAuth, (_req, res) => renderPage(res, 'fila', 'Produção'));
app.get('/fila/corte/:id', requireAuth, require('./controllers/clipsController').showClipPage);
app.get('/paginas', requireAuth, (_req, res) => renderPage(res, 'paginas', 'Páginas'));
app.get('/dashboard', requireAuth, require('./controllers/dashboardController').show);
app.get('/cookies', requireAuth, (_req, res) => renderPage(res, 'cookies', 'Cookies do YouTube'));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/videos', requireAuth, require('./routes/videos'));
app.use('/api/imagens', requireAuth, require('./routes/imagens'));
app.use('/api/facebook', requireAuth, require('./routes/facebook'));
app.use('/api/clips', requireAuth, require('./routes/clips'));
app.use('/api/publications', requireAuth, require('./routes/publications'));
app.use('/api/materias-ia', requireAuth, require('./routes/materiasIa'));
app.use('/api/biblioteca', requireAuth, require('./routes/biblioteca'));
app.use('/api/youtube-cookies', requireAuth, require('./routes/ytCookies'));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Rota não encontrada' });
  }
  res.status(404).render('404', {
    title: 'Não encontrado',
    path: req.path,
  });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  const status = err.status || 500;
  if (res.headersSent) return;
  res.status(status).json({
    error: err.message || 'Erro interno do servidor',
  });
});

module.exports = app;
