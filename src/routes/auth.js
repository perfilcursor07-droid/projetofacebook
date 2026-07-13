const express = require('express');
const facebookController = require('../controllers/facebookController');

const router = express.Router();

router.get('/facebook', facebookController.facebookLogin);
router.get('/facebook/callback', facebookController.facebookCallback);

module.exports = router;
