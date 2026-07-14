/**
 * Exige sessão autenticada.
 * Páginas → redirect /login; APIs → 401 JSON.
 */
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();

  const isApi = req.originalUrl.startsWith('/api/') || req.xhr || req.headers.accept?.includes('application/json');
  if (isApi) {
    return res.status(401).json({ error: 'Faça login para continuar' });
  }

  const nextUrl = encodeURIComponent(req.originalUrl || '/busca');
  return res.redirect(`/login?next=${nextUrl}`);
}

/**
 * Disponibiliza o usuário da sessão nas views.
 */
function attachUser(req, res, next) {
  res.locals.user = req.session?.userId
    ? { id: req.session.userId, nome: req.session.userName || 'Admin' }
    : null;
  next();
}

module.exports = { requireAuth, attachUser };
