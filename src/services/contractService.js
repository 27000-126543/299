const { queryAll, queryOne, queryRun, generateId } = require('../database/helpers');
const { notifySupplier, notifySupervisor, notifyPurchaser } = require('./notificationService');

function confirmContract(db, contractId) {
    const contract = queryOne(db, 'SELECT * FROM contracts WHERE id = ?', [contractId]);
    if (!contract) {
        return { success: false, message: '合同不存在' };
    }
    queryRun(db,
        `UPDATE contracts SET status = 'in_effect', signing_date = datetime('now','localtime'), updated_at = datetime('now','localtime') WHERE id = ?`,
        [contractId]
    );
    notifySupplier(db, contract.supplier_id, '合同已生效',
        `合同"${contract.title}"已确认生效，请按约定履行`,
        'success', contractId, 'contract');
    notifyPurchaser(db, getRequestIdByContract(db, contractId), '合同已生效',
        `合同"${contract.title}"已确认生效`,
        'success');
    notifySupervisor(db, '合同已生效',
        `合同"${contract.title}"已确认生效，供应商：${contract.supplier_name}，金额：￥${contract.amount.toFixed(2)}`,
        'info', contractId, 'contract');
    return { success: true, data: { contract_id: contractId, status: 'in_effect' } };
}

function getRequestIdByContract(db, contractId) {
    const contract = queryOne(db, 'SELECT * FROM contracts WHERE id = ?', [contractId]);
    if (!contract) return '';
    const announcement = queryOne(db, 'SELECT * FROM bidding_announcements WHERE id = ?', [contract.announcement_id]);
    return announcement ? announcement.request_id : '';
}

function checkContractDelays(db) {
    const contracts = queryAll(db,
        "SELECT * FROM contracts WHERE status = 'in_effect' AND delivery_date < date('now','localtime')"
    );

    const results = [];
    contracts.forEach(contract => {
        const existingOrder = queryOne(db,
            "SELECT * FROM breach_orders WHERE contract_id = ? AND breach_type = 'delivery_delay' AND status = 'pending'",
            [contract.id]
        );
        if (existingOrder) return;

        const deliveryDate = new Date(contract.delivery_date);
        const today = new Date();
        const delayDays = Math.ceil((today - deliveryDate) / (1000 * 60 * 60 * 24));

        if (delayDays <= 0) return;

        const penaltyAmount = Math.round(contract.amount * contract.penalty_rate * delayDays * 100) / 100;
        const maxPenalty = contract.amount * 0.05;
        const actualPenalty = Math.min(penaltyAmount, maxPenalty);

        const orderId = generateId('BRH');
        const calculationDetail = `合同金额：￥${contract.amount.toFixed(2)}，逾期天数：${delayDays}天，日违约金率：${(contract.penalty_rate * 100).toFixed(2)}%，违约金=合同金额×日违约金率×逾期天数=￥${penaltyAmount.toFixed(2)}，最高限额5%=￥${maxPenalty.toFixed(2)}，实际违约金=￥${actualPenalty.toFixed(2)}`;

        queryRun(db,
            `INSERT INTO breach_orders (id, contract_id, supplier_id, supplier_name, breach_type, breach_description, penalty_amount, calculation_detail, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
            [orderId, contract.id, contract.supplier_id, contract.supplier_name,
             'delivery_delay', `逾期交货${delayDays}天`,
             actualPenalty, calculationDetail]
        );

        results.push({
            order_id: orderId,
            contract_id: contract.id,
            supplier_name: contract.supplier_name,
            breach_type: 'delivery_delay',
            delay_days: delayDays,
            penalty_amount: actualPenalty,
            calculation_detail: calculationDetail
        });

        notifySupplier(db, contract.supplier_id, '违约工单-逾期交货',
            `合同"${contract.title}"逾期交货${delayDays}天，违约金￥${actualPenalty.toFixed(2)}`,
            'warning', orderId, 'breach_order');
        notifyPurchaser(db, getRequestIdByContract(db, contract.id), '供应商逾期交货',
            `合同"${contract.title}"供应商逾期交货${delayDays}天，已生成违约工单`,
            'warning');
        notifySupervisor(db, '违约工单-逾期交货',
            `合同"${contract.title}"供应商"${contract.supplier_name}"逾期交货${delayDays}天`,
            'warning', orderId, 'breach_order');
    });

    return results;
}

function failAcceptance(db, contractId, failReason) {
    const contract = queryOne(db, 'SELECT * FROM contracts WHERE id = ?', [contractId]);
    if (!contract) {
        return { success: false, message: '合同不存在' };
    }

    const penaltyRate = 0.05;
    const penaltyAmount = Math.round(contract.amount * penaltyRate * 100) / 100;
    const calculationDetail = `合同金额：￥${contract.amount.toFixed(2)}，验收不合格违约金率：5%，违约金=合同金额×5%=￥${penaltyAmount.toFixed(2)}`;

    const orderId = generateId('BRH');
    queryRun(db,
        `INSERT INTO breach_orders (id, contract_id, supplier_id, supplier_name, breach_type, breach_description, penalty_amount, calculation_detail, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        [orderId, contractId, contract.supplier_id, contract.supplier_name,
         'acceptance_fail', failReason || '验收不合格',
         penaltyAmount, calculationDetail]
    );

    notifySupplier(db, contract.supplier_id, '违约工单-验收不合格',
        `合同"${contract.title}"验收不合格，违约金￥${penaltyAmount.toFixed(2)}，原因：${failReason}`,
        'warning', orderId, 'breach_order');
    notifyPurchaser(db, getRequestIdByContract(db, contractId), '验收不合格',
        `合同"${contract.title}"验收不合格，已生成违约工单`,
        'warning');
    notifySupervisor(db, '违约工单-验收不合格',
        `合同"${contract.title}"供应商"${contract.supplier_name}"验收不合格`,
        'warning', orderId, 'breach_order');

    return {
        success: true,
        data: {
            order_id: orderId,
            contract_id: contractId,
            breach_type: 'acceptance_fail',
            penalty_amount: penaltyAmount,
            calculation_detail: calculationDetail
        }
    };
}

function acceptContract(db, contractId) {
    const contract = queryOne(db, 'SELECT * FROM contracts WHERE id = ?', [contractId]);
    if (!contract) {
        return { success: false, message: '合同不存在' };
    }
    queryRun(db,
        `UPDATE contracts SET status = 'accepted', acceptance_date = datetime('now','localtime'), updated_at = datetime('now','localtime') WHERE id = ?`,
        [contractId]
    );
    notifySupplier(db, contract.supplier_id, '合同验收合格',
        `合同"${contract.title}"验收合格`,
        'success', contractId, 'contract');
    notifyPurchaser(db, getRequestIdByContract(db, contractId), '合同验收合格',
        `合同"${contract.title}"验收合格`,
        'success');
    notifySupervisor(db, '合同验收合格',
        `合同"${contract.title}"验收合格，供应商：${contract.supplier_name}`,
        'info', contractId, 'contract');
    return { success: true, data: { contract_id: contractId, status: 'accepted' } };
}

function listBreachOrders(db, filters = {}) {
    let sql = 'SELECT * FROM breach_orders WHERE 1=1';
    const params = [];
    if (filters.status) {
        sql += ' AND status = ?';
        params.push(filters.status);
    }
    if (filters.contract_id) {
        sql += ' AND contract_id = ?';
        params.push(filters.contract_id);
    }
    if (filters.breach_type) {
        sql += ' AND breach_type = ?';
        params.push(filters.breach_type);
    }
    sql += ' ORDER BY created_at DESC';
    return queryAll(db, sql, params);
}

function resolveBreachOrder(db, orderId) {
    queryRun(db,
        `UPDATE breach_orders SET status = 'resolved', resolved_at = datetime('now','localtime') WHERE id = ?`,
        [orderId]
    );
    return { success: true, data: { order_id: orderId, status: 'resolved' } };
}

function listContracts(db, filters = {}) {
    let sql = 'SELECT * FROM contracts WHERE 1=1';
    const params = [];
    if (filters.status) {
        sql += ' AND status = ?';
        params.push(filters.status);
    }
    sql += ' ORDER BY created_at DESC';
    return queryAll(db, sql, params);
}

function getContract(db, contractId) {
    return queryOne(db, 'SELECT * FROM contracts WHERE id = ?', [contractId]);
}

module.exports = {
    confirmContract, checkContractDelays, failAcceptance, acceptContract,
    listBreachOrders, resolveBreachOrder, listContracts, getContract
};
