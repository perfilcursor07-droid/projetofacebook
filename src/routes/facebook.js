const express = require('express');
const facebookController = require('../controllers/facebookController');
const postpulseController = require('../controllers/postpulseController');

const router = express.Router();

router.get('/pages', facebookController.listPages);
router.get('/postpulse/status', postpulseController.statusHandler);
router.post('/postpulse/sync', postpulseController.syncHandler);
router.delete('/postpulse', postpulseController.disconnectHandler);

module.exports = router;
