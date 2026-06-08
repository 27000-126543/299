const express = require('express');
const router = express.Router();
const { getDb, saveDatabase } = require('../database/db');
const {
    confirmContract, failAcceptance, acceptContract,
    listBreachOrders, resolveBreachOrder, listContracts, getContract, checkContractDelays
} = require('../services/contractService');

router.put('/contracts/:id/confirm', (req, res) => {
    const result = confirmContract(getDb(), req.params.id);
    saveDatabase();
    res.json(result);
});

router.put('/contracts/:id/accept', (req, res) => {
    const result = acceptContract(getDb(), req.params.id);
    saveDatabase();
    res.json(result);
});

router.post('/contracts/:id/fail-acceptance', (req, res) => {
    const { reason } = req.body;
    const result = failAcceptance(getDb(), req.params.id, reason);
    saveDatabase();
    res.json(result);
});

router.get('/contracts', (req, res) => {
    const result = listContracts(getDb(), req.query);
    res.json({ success: true, data: result });
});

router.get('/contracts/:id', (req, res) => {
    const result = getContract(getDb(), req.params.id);
    if (!result) return res.status(404).json({ success: false, message: '合同不存在' });
    res.json({ success: true, data: result });
});

router.post('/contracts/check-delays', (req, res) => {
    const results = checkContractDelays(getDb());
    saveDatabase();
    res.json({ success: true, data: results });
});

router.get('/breach-orders', (req, res) => {
    const result = listBreachOrders(getDb(), req.query);
    res.json({ success: true, data: result });
});

router.put('/breach-orders/:id/resolve', (req, res) => {
    const result = resolveBreachOrder(getDb(), req.params.id);
    saveDatabase();
    res.json(result);
});

module.exports = router;
