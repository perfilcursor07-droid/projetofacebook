const express = require('express');
const path = require('path');
const session = require('express-session');
const { env } = require('./config/env');
const { ensureDevUser } = require('./middleware/ensureDevUser');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../public/views'));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));
app.use('/media', express.static(path.resolve(env.storagePath)));

app.use(
  session({
    secret: env.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  })
);

app.use((req, res, next) => {
  res.locals.currentPath = req.path;
  next();
});

app.use(ensureDevUser);

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    app: 'Clipador',
    pexels: Boolean(env.pexelsApiKey),
  });
});

function renderPage(res, view, title) {
  res.render(view, { title });
}

app.get('/', (_req, res) => renderPage(res, 'index', 'Início'));
app.get('/busca', (_req, res) => renderPage(res, 'busca', 'Busca'));
app.get('/fila', (_req, res) => renderPage(res, 'fila', 'Fila'));
app.get('/paginas', (_req, res) => renderPage(res, 'paginas', 'Páginas'));
app.get('/dashboard', (_req, res) => renderPage(res, 'dashboard', 'Dashboard'));

app.use('/api/videos', require('./routes/videos'));
app.use('/api/imagens', require('./routes/imagens'));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/facebook', require('./routes/facebook'));
app.use('/api/clips', require('./routes/clips'));
app.use('/api/publications', require('./routes/publications'));

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
