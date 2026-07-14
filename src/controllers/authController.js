const bcrypt = require('bcryptjs');
const Users = require('../models/Users');

function safeNext(value) {
  const next = String(value || '/dashboard');
  return next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard';
}

async function login(req, res) {
  try {
    const loginId = String(req.body.login || req.body.email || '').trim().toLowerCase();
    const senha = String(req.body.senha || req.body.password || '');
    const next = safeNext(req.body.next);
    const wantsHtml = Boolean(req.body.redirect) || Boolean(req.headers.accept?.includes('text/html'));

    if (!loginId || !senha) {
      if (wantsHtml) {
        return res.status(400).render('login', {
          title: 'Entrar',
          next,
          error: 'Informe usuário e senha',
        });
      }
      return res.status(400).json({ error: 'Informe usuário e senha' });
    }

    const user = await Users.findByEmail(loginId);
    const ok = user ? await bcrypt.compare(senha, user.senha_hash) : false;
    if (!ok) {
      if (wantsHtml) {
        return res.status(401).render('login', {
          title: 'Entrar',
          next,
          error: 'Usuário ou senha inválidos',
        });
      }
      return res.status(401).json({ error: 'Usuário ou senha inválidos' });
    }

    req.session.userId = user.id;
    req.session.userName = user.nome;

    if (wantsHtml) return res.redirect(next);

    return res.json({
      ok: true,
      user: { id: user.id, nome: user.nome, email: user.email },
      next,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao fazer login' });
  }
}

function logout(req, res) {
  req.session.destroy((err) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Erro ao sair' });
    }
    res.clearCookie('connect.sid');
    if (req.method === 'GET' || req.headers.accept?.includes('text/html') || req.query.redirect) {
      return res.redirect('/');
    }
    return res.json({ ok: true });
  });
}

function me(req, res) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Não autenticado' });
  }
  return res.json({
    user: {
      id: req.session.userId,
      nome: req.session.userName,
    },
  });
}

module.exports = { login, logout, me };
