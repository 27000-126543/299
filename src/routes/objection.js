const express = require('express');
const router = express.Router();
const { getDb, saveDatabase } = require('../database/db');
const { submitObjection, handleObjection, listObjections } = require('../services/objectionService');
const { getAuditTimeline } = require('../services/objectionService');

router.post('/', (req, res) => {
    const { announcement_id, supplier_id, objection_type, objection_content } = req.body;
    if (!announcement_id || !supplier_id || !objection_type || !objection_content) {
        return res.status(400).json({ success: false, message: 'announcement_id/supplier_id/objection_type/objection_content必填' });
    }
    const result = submitObjection(getDb(), { announcementId: announcement_id, supplierId: supplier_id, objectionType: objection_type, objectionContent: objection_content });
    saveDatabase();
    res.status(result.success ? 201 : 400).json(result);
});

router.put('/:objectionId/handle', (req, res) => {
    const { handler_id, handler_name, handling_opinion, conclusion } = req.body;
    if (!conclusion) return res.status(400).json({ success: false, message: 'conclusion必填(upheld/overruled)' });
    const result = handleObjection(getDb(), req.params.objectionId, { handlerId: handler_id, handlerName: handler_name, handlingOpinion: handling_opinion, conclusion });
    saveDatabase();
    res.json(result);
});

router.get('/', (req, res) => {
    const result = listObjections(getDb(), req.query);
    res.json({ success: true, data: result });
});

router.get('/audit/:announcementId', (req, res) => {
    const result = getAuditTimeline(getDb(), req.params.announcementId);
    res.json({ success: true, data: result });
});

module.exports = router;
