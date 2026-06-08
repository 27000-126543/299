const express = require('express');
const router = express.Router();
const { getDb, saveDatabase } = require('../database/db');
const { registerSupplier, listRegistrations, confirmDeposit } = require('../services/registrationService');

router.post('/registrations', (req, res) => {
    const { announcement_id, supplier_id } = req.body;
    if (!announcement_id || !supplier_id) {
        return res.status(400).json({ success: false, message: 'announcement_id和supplier_id必填' });
    }
    const result = registerSupplier(getDb(), announcement_id, supplier_id);
    saveDatabase();
    res.status(result.success ? 201 : 400).json(result);
});

router.get('/registrations', (req, res) => {
    const { announcement_id } = req.query;
    if (!announcement_id) return res.status(400).json({ success: false, message: 'announcement_id必填' });
    const result = listRegistrations(getDb(), announcement_id);
    res.json({ success: true, data: result });
});

router.put('/registrations/:id/deposit', (req, res) => {
    const result = confirmDeposit(getDb(), req.params.id);
    saveDatabase();
    res.json(result);
});

module.exports = router;
