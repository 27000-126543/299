const express = require('express');
const router = express.Router();
const { getDb, saveDatabase } = require('../database/db');
const { evaluateBids, getEvaluationResults, getEvaluationHistory, reviewQualification } = require('../services/evaluationService');

router.post('/evaluations', (req, res) => {
    const { announcement_id } = req.body;
    if (!announcement_id) return res.status(400).json({ success: false, message: 'announcement_id必填' });
    const result = evaluateBids(getDb(), announcement_id);
    saveDatabase();
    res.status(result.success ? 201 : 400).json(result);
});

router.get('/evaluations/:announcementId', (req, res) => {
    const result = getEvaluationResults(getDb(), req.params.announcementId);
    res.json({ success: true, data: result });
});

router.get('/history/:announcementId', (req, res) => {
    const result = getEvaluationHistory(getDb(), req.params.announcementId);
    res.json({ success: true, data: result });
});

router.put('/qualification-review/:reviewId', (req, res) => {
    const { status, reviewed_by } = req.body;
    if (!status) return res.status(400).json({ success: false, message: 'status必填(passed/failed)' });
    const result = reviewQualification(getDb(), req.params.reviewId, status, reviewed_by || 'supervisor');
    saveDatabase();
    res.json(result);
});

module.exports = router;
