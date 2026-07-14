const bcrypt = require('bcryptjs');
const Users = require('../models/Users');

const ACCESS_LEVELS = new Set(['usuario', 'administrador']);

function clean(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function redirectWith(res, type, message) {
  return res.redirect(`/usuarios?${type}=${encodeURIComponent(message)}`);
}

async function index(req, res, next) {
  try {
    const users = await Users.list();
    return res.render('usuarios', {
      title: 'Usuários',
      users,
      success: req.query.success || null,
      error: req.query.error || null,
    });
  } catch (err) {
    return next(err);
  }
}

async function create(req, res, next) {
  try {
    const nome = clean(req.body.nome, 150);
    const email = clean(req.body.email, 191).toLowerCase();
    const senha = String(req.body.senha || '');
    const nivelAcesso = ACCESS_LEVELS.has(req.body.nivel_acesso) ? req.body.nivel_acesso : 'usuario';

    if (nome.length < 2) return redirectWith(res, 'error', 'Informe o nome do usuário');
    if (!email) return redirectWith(res, 'error', 'Informe o usuário ou e-mail de acesso');
    if (senha.length < 8) return redirectWith(res, 'error', 'A senha deve ter pelo menos 8 caracteres');
    if (await Users.findByEmail(email)) return redirectWith(res, 'error', 'Este acesso já está cadastrado');

    await Users.create({
      nome,
      email,
      senha_hash: await bcrypt.hash(senha, 12),
      nivel_acesso: nivelAcesso,
      marca_nome: nome.slice(0, 120),
      marca_categoria: 'ÚLTIMAS',
    });
    return redirectWith(res, 'success', 'Usuário cadastrado com sucesso');
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return redirectWith(res, 'error', 'Este acesso já está cadastrado');
    return next(err);
  }
}

async function updateAccess(req, res, next) {
  try {
    const id = Number(req.params.id);
    const nivelAcesso = String(req.body.nivel_acesso || '');
    if (!Number.isInteger(id) || id < 1 || !ACCESS_LEVELS.has(nivelAcesso)) {
      return redirectWith(res, 'error', 'Dados de nível de acesso inválidos');
    }
    if (id === Number(req.user.id) && nivelAcesso !== 'administrador') {
      return redirectWith(res, 'error', 'Você não pode remover seu próprio acesso administrativo');
    }

    const target = await Users.findById(id);
    if (!target) return redirectWith(res, 'error', 'Usuário não encontrado');

    if (target.nivel_acesso === 'administrador' && nivelAcesso !== 'administrador') {
      const admins = Number((await Users.countByAccess('administrador'))?.total || 0);
      if (admins <= 1) {
        return redirectWith(res, 'error', 'É necessário manter ao menos um administrador');
      }
    }

    await Users.update(id, { nivel_acesso: nivelAcesso });
    return redirectWith(res, 'success', 'Nível de acesso atualizado');
  } catch (err) {
    return next(err);
  }
}

async function remove(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      return redirectWith(res, 'error', 'Usuário inválido');
    }
    if (id === Number(req.user.id)) {
      return redirectWith(res, 'error', 'Você não pode remover a própria conta');
    }

    const target = await Users.findById(id);
    if (!target) return redirectWith(res, 'error', 'Usuário não encontrado');

    if (target.nivel_acesso === 'administrador') {
      const admins = Number((await Users.countByAccess('administrador'))?.total || 0);
      if (admins <= 1) {
        return redirectWith(res, 'error', 'É necessário manter ao menos um administrador');
      }
    }

    await Users.remove(id);
    return redirectWith(res, 'success', 'Usuário removido com sucesso');
  } catch (err) {
    return next(err);
  }
}

async function resetPassword(req, res, next) {
  try {
    const id = Number(req.params.id);
    const senha = String(req.body.senha || '');
    if (!Number.isInteger(id) || id < 1) {
      return redirectWith(res, 'error', 'Usuário inválido');
    }
    if (senha.length < 8) {
      return redirectWith(res, 'error', 'A nova senha deve ter pelo menos 8 caracteres');
    }
    if (!(await Users.findById(id))) {
      return redirectWith(res, 'error', 'Usuário não encontrado');
    }

    await Users.update(id, { senha_hash: await bcrypt.hash(senha, 12) });
    return redirectWith(res, 'success', 'Senha redefinida com sucesso');
  } catch (err) {
    return next(err);
  }
}

module.exports = { index, create, updateAccess, remove, resetPassword };
