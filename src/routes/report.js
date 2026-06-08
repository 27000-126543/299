const express = require('express');
const router = express.Router();
const { getDb, saveDatabase } = require('../database/db');
const { generateDailyReport, getReport, listReports, exportReportToExcel } = require('../services/reportService');

router.post('/reports/generate', (req, res) => {
    const { report_date } = req.body;
    const report = generateDailyReport(getDb(), report_date);
    saveDatabase();
    res.json({ success: true, data: report });
});

router.get('/reports', (req, res) => {
    const result = listReports(getDb(), req.query);
    res.json({ success: true, data: result });
});

router.get('/reports/:date', (req, res) => {
    const result = getReport(getDb(), req.params.date);
    if (!result) return res.status(404).json({ success: false, message: '报告不存在' });
    res.json({ success: true, data: result });
});

router.get('/reports/export/excel', async (req, res) => {
    try {
        const buffer = await exportReportToExcel(getDb(), req.query);
        const dateStr = req.query.start_date || req.query.end_date || new Date().toISOString().slice(0, 10);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=procurement_report_${dateStr}.xlsx`);
        res.send(Buffer.from(buffer));
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
