const express = require('express');
const router = express.Router();
const { getDb, saveDatabase } = require('../database/db');
const { createAnnouncement, listAnnouncements, getAnnouncement } = require('../services/announcementService');

router.post('/announcements', (req, res) => {
    const { request_id } = req.body;
    if (!request_id) return res.status(400).json({ success: false, message: 'request_id必填' });
    const result = createAnnouncement(getDb(), request_id);
    if (result.success) saveDatabase();
    res.status(result.success ? 201 : 400).json(result);
});

router.get('/announcements', (req, res) => {
    const result = listAnnouncements(getDb(), req.query);
    res.json({ success: true, data: result });
});

router.get('/announcements/:id', (req, res) => {
    const result = getAnnouncement(getDb(), req.params.id);
    if (!result) return res.status(404).json({ success: false, message: '公告不存在' });
    res.json({ success: true, data: result });
});

module.exports = router;
