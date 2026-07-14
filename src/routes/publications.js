const express = require('express');
const publicationsController = require('../controllers/publicationsController');

const router = express.Router();

router.get('/', publicationsController.listPublications);
router.post('/text', publicationsController.publishTextPost);

module.exports = router;
