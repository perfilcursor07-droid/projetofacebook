const express = require('express');
const facebookController = require('../controllers/facebookController');

const router = express.Router();

router.get('/pages', facebookController.listPages);

module.exports = router;
