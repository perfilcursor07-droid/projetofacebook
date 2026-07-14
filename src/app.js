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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));
app.use('/media', express.static(path.resolve(env.storagePath)));

const isProd = env.nodeEnv === 'production';
app.use(
  session({
    secret: env.sessionSecret,
    resave: false,
    saveUninitialized: false,
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

app.get('/busca', requireAuth, (_req, res) => renderPage(res, 'busca', 'Busca'));
app.get('/materias-ia', requireAuth, require('./controllers/materiasIaController').listPage);
app.get('/minhas-materias', requireAuth, require('./controllers/materiasIaController').listMinhasMaterias);
app.get('/materias-ia/:id', requireAuth, require('./controllers/materiasIaController').showMatter);
app.get('/fila', requireAuth, (_req, res) => renderPage(res, 'fila', 'Fila'));
app.get('/paginas', requireAuth, (_req, res) => renderPage(res, 'paginas', 'Páginas'));
app.get('/dashboard', requireAuth, require('./controllers/dashboardController').show);

app.use('/api/auth', require('./routes/auth'));
app.use('/api/videos', requireAuth, require('./routes/videos'));
app.use('/api/imagens', requireAuth, require('./routes/imagens'));
app.use('/api/facebook', requireAuth, require('./routes/facebook'));
app.use('/api/clips', requireAuth, require('./routes/clips'));
app.use('/api/publications', requireAuth, require('./routes/publications'));
app.use('/api/materias-ia', requireAuth, require('./routes/materiasIa'));

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
