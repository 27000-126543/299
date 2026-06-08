const { queryAll, queryOne, queryRun, generateId } = require('../database/helpers');
const { notifyPurchaser, notifySupervisor } = require('./notificationService');

const REQUIRED_FIELDS = ['title', 'category', 'budget', 'description', 'delivery_date', 'delivery_address'];

const PROCUREMENT_METHODS = [
    { name: '公开招标', minBudget: 2000000, description: '预算金额≥200万元，适用公开招标' },
    { name: '竞争性谈判', minBudget: 200000, maxBudget: 2000000, description: '预算金额20万-200万元，适用竞争性谈判' },
    { name: '竞争性磋商', minBudget: 200000, maxBudget: 2000000, description: '预算金额20万-200万元，适用竞争性磋商' },
    { name: '询价采购', minBudget: 0, maxBudget: 200000, description: '预算金额<20万元，适用询价采购' },
    { name: '单一来源', minBudget: 0, description: '特殊情形，只能从唯一供应商处采购' }
];

function validateCompleteness(data) {
    const missing = [];
    const warnings = [];

    REQUIRED_FIELDS.forEach(field => {
        if (!data[field] || (typeof data[field] === 'string' && data[field].trim() === '')) {
            missing.push(field);
        }
    });

    if (data.budget && data.budget <= 0) {
        missing.push('budget_invalid');
    }

    if (!data.quantity || data.quantity <= 0) {
        warnings.push('quantity_missing');
    }

    if (!data.specs) {
        warnings.push('specs_missing');
    }

    const totalFields = REQUIRED_FIELDS.length + 2;
    const filledFields = totalFields - missing.length - (warnings.length > 0 ? 0 : 0);
    const score = Math.round((filledFields / totalFields) * 100);

    return {
        isComplete: missing.length === 0,
        missingFields: missing,
        warnings,
        score
    };
}

function recommendProcurementMethod(budget, category) {
    const rules = PROCUREMENT_METHODS.filter(m =>
        budget >= (m.minBudget || 0) &&
        (!m.maxBudget || budget < m.maxBudget)
    );

    let recommended;
    let reason;

    if (category === '工程类' && budget >= 2000000) {
        recommended = '公开招标';
        reason = `工程类项目预算${(budget / 10000).toFixed(2)}万元≥200万元，依法必须公开招标`;
    } else if (category === '服务类' && budget >= 2000000) {
        recommended = '公开招标';
        reason = `服务类项目预算${(budget / 10000).toFixed(2)}万元≥200万元，依法必须公开招标`;
    } else if (rules.length > 0) {
        recommended = rules[0].name;
        reason = rules[0].description;
    } else {
        recommended = '公开招标';
        reason = '默认推荐公开招标';
    }

    return { method: recommended, reason };
}

function submitRequest(db, data) {
    const validation = validateCompleteness(data);
    if (!validation.isComplete) {
        return {
            success: false,
            message: '需求信息不完整，请补充必填项',
            missingFields: validation.missingFields,
            score: validation.score
        };
    }

    const id = generateId('REQ');
    const recommendation = recommendProcurementMethod(data.budget, data.category);

    queryRun(db,
        `INSERT INTO procurement_requests
         (id, title, category, budget, quantity, description, specs, delivery_date, delivery_address,
          purchaser_id, purchaser_name, dept_name, status, recommended_method, method_reason, completeness_score)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, data.title, data.category, data.budget, data.quantity || null,
         data.description, data.specs || null, data.delivery_date, data.delivery_address,
         data.purchaser_id, data.purchaser_name || '', data.dept_name || '',
         'submitted', recommendation.method, recommendation.reason, validation.score]
    );

    notifySupervisor(db, '新采购需求待审核',
        `采购人${data.purchaser_name || ''}提交了新需求：${data.title}，预算${(data.budget / 10000).toFixed(2)}万元`,
        'info', id, 'procurement_request');

    return {
        success: true,
        data: {
            id,
            recommended_method: recommendation.method,
            method_reason: recommendation.reason,
            completeness_score: validation.score,
            status: 'submitted'
        }
    };
}

function reviewRequest(db, requestId, action, rejectReason = '') {
    const request = queryOne(db, 'SELECT * FROM procurement_requests WHERE id = ?', [requestId]);
    if (!request) {
        return { success: false, message: '需求不存在' };
    }

    if (request.status !== 'submitted') {
        return { success: false, message: '当前状态不允许审核' };
    }

    if (action === 'approve') {
        queryRun(db,
            `UPDATE procurement_requests SET status = 'approved', updated_at = datetime('now','localtime') WHERE id = ?`,
            [requestId]
        );
        notifyPurchaser(db, requestId, '采购需求已通过审核',
            `您提交的采购需求"${request.title}"已通过审核，推荐采购方式：${request.recommended_method}`,
            'success');
        notifySupervisor(db, '采购需求审核通过',
            `采购需求"${request.title}"已通过审核，推荐采购方式：${request.recommended_method}`,
            'info', requestId, 'procurement_request');
    } else if (action === 'reject') {
        queryRun(db,
            `UPDATE procurement_requests SET status = 'rejected', reject_reason = ?, updated_at = datetime('now','localtime') WHERE id = ?`,
            [rejectReason, requestId]
        );
        notifyPurchaser(db, requestId, '采购需求被退回',
            `您提交的采购需求"${request.title}"被退回，原因：${rejectReason}`,
            'warning');
    }

    return {
        success: true,
        data: { id: requestId, status: action === 'approve' ? 'approved' : 'rejected' }
    };
}

function listRequests(db, filters = {}) {
    let sql = 'SELECT * FROM procurement_requests WHERE 1=1';
    const params = [];

    if (filters.status) {
        sql += ' AND status = ?';
        params.push(filters.status);
    }
    if (filters.purchaser_id) {
        sql += ' AND purchaser_id = ?';
        params.push(filters.purchaser_id);
    }
    if (filters.category) {
        sql += ' AND category = ?';
        params.push(filters.category);
    }

    sql += ' ORDER BY created_at DESC';

    if (filters.limit) {
        sql += ' LIMIT ?';
        params.push(filters.limit);
    }
    if (filters.offset) {
        sql += ' OFFSET ?';
        params.push(filters.offset);
    }

    return queryAll(db, sql, params);
}

function getRequest(db, requestId) {
    return queryOne(db, 'SELECT * FROM procurement_requests WHERE id = ?', [requestId]);
}

module.exports = {
    submitRequest, reviewRequest, listRequests, getRequest,
    validateCompleteness, recommendProcurementMethod
};
