const express = require('express');
const facebookController = require('../controllers/facebookController');
const authController = require('../controllers/authController');
const { requireAuth } = require('../middleware/requireAuth');

const router = express.Router();

router.post('/login', authController.login);
router.post('/logout', authController.logout);
router.get('/logout', authController.logout);
router.get('/me', requireAuth, authController.me);

router.get('/facebook', requireAuth, facebookController.facebookLogin);
router.get('/facebook/callback', requireAuth, facebookController.facebookCallback);

module.exports = router;
