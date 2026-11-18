'use strict';
const express = require('express');
const { db } = require('../db');
const { log, history } = require('../services/audit');

const router = express.Router();

router.get('/historial', (req, res) => {
  res.render('history/index', {
    title: 'Historial de cambios',
    entries: history(req.user.id, 200),
  });
});

module.exports = router;
