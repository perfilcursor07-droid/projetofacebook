const Users = require('../models/Users');

/**
 * Em desenvolvimento, garante um usuário demo na sessão
 * até o login real (etapa 5) estar pronto.
 */
async function ensureDevUser(req, res, next) {
  try {
    if (req.session.userId) return next();

    let user = await Users.findByEmail('admin@clipador.local');
    if (!user) {
      const bcrypt = require('bcryptjs');
      const [id] = await Users.create({
        nome: 'Admin Clipador',
        email: 'admin@clipador.local',
        senha_hash: await bcrypt.hash('clipador123', 10),
      });
      user = await Users.findById(id);
    }

    req.session.userId = user.id;
    req.session.userName = user.nome;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { ensureDevUser };
