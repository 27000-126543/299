const express = require('express');
const router = express.Router();
const { getDb } = require('../database/db');
const { queryAll, queryOne } = require('../database/helpers');

router.get('/', (req, res) => {
    const { recipient_type, recipient_id, is_read } = req.query;
    let sql = 'SELECT * FROM notifications WHERE 1=1';
    const params = [];

    if (recipient_type) {
        sql += ' AND recipient_type = ?';
        params.push(recipient_type);
    }
    if (recipient_id) {
        sql += ' AND recipient_id = ?';
        params.push(recipient_id);
    }
    if (is_read !== undefined) {
        sql += ' AND is_read = ?';
        params.push(is_read);
    }

    sql += ' ORDER BY created_at DESC LIMIT 100';
    const notifications = queryAll(getDb(), sql, params);
    res.json({ success: true, data: notifications });
});

router.put('/:id/read', (req, res) => {
    const db = getDb();
    const notification = queryOne(db, 'SELECT * FROM notifications WHERE id = ?', [req.params.id]);
    if (!notification) return res.status(404).json({ success: false, message: '通知不存在' });
    db.run('UPDATE notifications SET is_read = 1 WHERE id = ?', [req.params.id]);
    res.json({ success: true });
});

module.exports = router;
