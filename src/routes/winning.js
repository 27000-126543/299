const express = require('express');
const router = express.Router();
const { getDb, saveDatabase } = require('../database/db');
const { approveWinningResult, listWinningResults, getWinningResult } = require('../services/winningService');

router.post('/approve', (req, res) => {
    const { announcement_id, approved_by } = req.body;
    if (!announcement_id) return res.status(400).json({ success: false, message: 'announcement_id必填' });
    const result = approveWinningResult(getDb(), announcement_id, approved_by || 'admin');
    saveDatabase();
    res.json(result);
});

router.get('/', (req, res) => {
    const result = listWinningResults(getDb(), req.query);
    res.json({ success: true, data: result });
});

router.get('/:id', (req, res) => {
    const result = getWinningResult(getDb(), req.params.id);
    if (!result) return res.status(404).json({ success: false, message: '中标结果不存在' });
    res.json({ success: true, data: result });
});

module.exports = router;
