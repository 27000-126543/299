const express = require('express');
const router = express.Router();
const { getDb, saveDatabase } = require('../database/db');
const { openBids, submitBidDocument, getBidOpeningResult } = require('../services/bidOpeningService');

router.post('/bid-openings', (req, res) => {
    const { announcement_id } = req.body;
    if (!announcement_id) return res.status(400).json({ success: false, message: 'announcement_id必填' });
    const result = openBids(getDb(), announcement_id);
    saveDatabase();
    res.status(result.success ? 201 : 400).json(result);
});

router.post('/bid-documents', (req, res) => {
    const result = submitBidDocument(getDb(), req.body);
    if (result.success) saveDatabase();
    res.status(result.success ? 201 : 400).json(result);
});

router.get('/bid-openings/:announcementId', (req, res) => {
    const result = getBidOpeningResult(getDb(), req.params.announcementId);
    if (!result) return res.status(404).json({ success: false, message: '开标记录不存在' });
    res.json({ success: true, data: result });
});

module.exports = router;
