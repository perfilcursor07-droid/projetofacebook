const express = require('express');
const facebookController = require('../controllers/facebookController');
const postpulseController = require('../controllers/postpulseController');
const postsyncerController = require('../controllers/postsyncerController');

const router = express.Router();

router.get('/pages', facebookController.listPages);
router.put('/pages/default', facebookController.setDefaultPage);
router.post('/pages/default', facebookController.setDefaultPage);
router.get('/postpulse/status', postpulseController.statusHandler);
router.post('/postpulse/sync', postpulseController.syncHandler);
router.post('/postpulse/link', postpulseController.linkHandler);
router.delete('/postpulse', postpulseController.disconnectHandler);

router.get('/postsyncer/status', postsyncerController.statusHandler);
router.post('/postsyncer/sync', postsyncerController.syncHandler);
router.post('/postsyncer/link', postsyncerController.linkHandler);

module.exports = router;
