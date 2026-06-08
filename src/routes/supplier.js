const express = require('express');
const router = express.Router();
const { getDb, saveDatabase } = require('../database/db');
const { queryAll, queryOne, queryRun, generateId } = require('../database/helpers');

router.get('/', (req, res) => {
    const suppliers = queryAll(getDb(), 'SELECT * FROM suppliers ORDER BY registered_at DESC');
    res.json({ success: true, data: suppliers });
});

router.get('/:id', (req, res) => {
    const supplier = queryOne(getDb(), 'SELECT * FROM suppliers WHERE id = ?', [req.params.id]);
    if (!supplier) return res.status(404).json({ success: false, message: '供应商不存在' });
    res.json({ success: true, data: supplier });
});

router.post('/', (req, res) => {
    const db = getDb();
    const id = generateId('SUP');
    const { name, unified_code, category, qualification_level, contact_person, contact_phone, email, address } = req.body;
    if (!name || !unified_code) {
        return res.status(400).json({ success: false, message: 'name和unified_code必填' });
    }
    try {
        queryRun(db,
            `INSERT INTO suppliers (id, name, unified_code, category, qualification_level, contact_person, contact_phone, email, address)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, name, unified_code, category || '', qualification_level || '',
             contact_person || '', contact_phone || '', email || '', address || '']
        );
        saveDatabase();
        res.status(201).json({ success: true, data: { id, name, unified_code } });
    } catch (err) {
        res.status(400).json({ success: false, message: '供应商已存在或数据格式错误' });
    }
});

router.put('/:id/credit', (req, res) => {
    const db = getDb();
    const { credit_score } = req.body;
    if (credit_score === undefined || credit_score < 0 || credit_score > 100) {
        return res.status(400).json({ success: false, message: 'credit_score必须在0-100之间' });
    }
    queryRun(db, 'UPDATE suppliers SET credit_score = ? WHERE id = ?', [credit_score, req.params.id]);
    saveDatabase();
    res.json({ success: true, data: { id: req.params.id, credit_score } });
});

module.exports = router;
