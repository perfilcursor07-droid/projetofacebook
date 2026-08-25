const express = require('express');
const controller = require('../controllers/viraisController');

const router = express.Router();

router.post('/pesquisar', controller.pesquisar);
router.post('/gerar', controller.gerar);

module.exports = router;
