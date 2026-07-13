const express = require('express');
const publicationsController = require('../controllers/publicationsController');

const router = express.Router();

router.post('/:id/publish', publicationsController.publishClip);

module.exports = router;
