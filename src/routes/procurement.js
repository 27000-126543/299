const express = require('express');
const router = express.Router();
const { getDb, saveDatabase } = require('../database/db');
const { submitRequest, reviewRequest, listRequests, getRequest } = require('../services/procurementService');

router.post('/requests', (req, res) => {
    const result = submitRequest(getDb(), req.body);
    if (result.success) saveDatabase();
    res.status(result.success ? 201 : 400).json(result);
});

router.get('/requests', (req, res) => {
    const result = listRequests(getDb(), req.query);
    res.json({ success: true, data: result });
});

router.get('/requests/:id', (req, res) => {
    const result = getRequest(getDb(), req.params.id);
    if (!result) return res.status(404).json({ success: false, message: '需求不存在' });
    res.json({ success: true, data: result });
});

router.put('/requests/:id/review', (req, res) => {
    const { action, reject_reason } = req.body;
    if (!action || !['approve', 'reject'].includes(action)) {
        return res.status(400).json({ success: false, message: 'action参数必须为approve或reject' });
    }
    const result = reviewRequest(getDb(), req.params.id, action, reject_reason);
    if (result.success) saveDatabase();
    res.json(result);
});

module.exports = router;
