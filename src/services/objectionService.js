const { queryAll, queryOne, queryRun, generateId } = require('../database/helpers');
const { notifySupplier, notifySupervisor, notifyPurchaser } = require('./notificationService');

function addAuditLog(db, { announcementId, actionType, operatorId, operatorName, beforeStatus, afterStatus, detail, supplierId, supplierName }) {
    const id = generateId('AUD');
    queryRun(db,
        `INSERT INTO audit_logs (id, announcement_id, action_type, operator_id, operator_name, before_status, after_status, detail, supplier_id, supplier_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, announcementId, actionType, operatorId || '', operatorName || '', beforeStatus || '', afterStatus || '', detail || '', supplierId || '', supplierName || '']
    );
    return id;
}

function getAuditTimeline(db, announcementId) {
    return queryAll(db,
        'SELECT * FROM audit_logs WHERE announcement_id = ? ORDER BY created_at',
        [announcementId]
    );
}

function submitObjection(db, { announcementId, supplierId, objectionType, objectionContent }) {
    const announcement = queryOne(db, 'SELECT * FROM bidding_announcements WHERE id = ?', [announcementId]);
    if (!announcement) {
        return { success: false, message: '招标公告不存在' };
    }
    const supplier = queryOne(db, 'SELECT * FROM suppliers WHERE id = ?', [supplierId]);
    if (!supplier) {
        return { success: false, message: '供应商不存在' };
    }
    const validTypes = ['score', 'ranking', 'qualification_review', 'price_alert', 'other'];
    if (!validTypes.includes(objectionType)) {
        return { success: false, message: `异议类型只能是: ${validTypes.join(', ')}` };
    }

    const id = generateId('OBJ');
    queryRun(db,
        `INSERT INTO objections (id, announcement_id, supplier_id, supplier_name, objection_type, objection_content)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, announcementId, supplierId, supplier.name, objectionType, objectionContent]
    );

    addAuditLog(db, {
        announcementId, actionType: 'objection_submit', operatorId: supplierId, operatorName: supplier.name,
        beforeStatus: 'none', afterStatus: 'pending',
        detail: `供应商"${supplier.name}"提交${objectionType}异议：${objectionContent}`,
        supplierId, supplierName: supplier.name
    });

    notifyPurchaser(db, announcement.request_id, '供应商异议待处理',
        `项目"${announcement.title}"供应商"${supplier.name}"提交了${objectionType}异议，请及时处理`,
        'warning');
    notifySupervisor(db, '供应商异议待处理',
        `项目"${announcement.title}"供应商"${supplier.name}"提交了${objectionType}异议`,
        'warning', id, 'objection');

    return {
        success: true,
        data: {
            objection_id: id,
            announcement_id: announcementId,
            supplier_id: supplierId,
            supplier_name: supplier.name,
            objection_type: objectionType,
            status: 'pending'
        }
    };
}

function handleObjection(db, objectionId, { handlerId, handlerName, handlingOpinion, conclusion }) {
    const objection = queryOne(db, 'SELECT * FROM objections WHERE id = ?', [objectionId]);
    if (!objection) {
        return { success: false, message: '异议记录不存在' };
    }
    if (objection.status !== 'pending') {
        return { success: false, message: '该异议已处理，不能重复处理' };
    }
    if (!['upheld', 'overruled'].includes(conclusion)) {
        return { success: false, message: '结论只能是upheld(异议成立)或overruled(异议不成立)' };
    }

    queryRun(db,
        `UPDATE objections SET status = ?, handler_id = ?, handler_name = ?, handling_opinion = ?, conclusion = ?, handled_at = datetime('now','localtime') WHERE id = ?`,
        [conclusion, handlerId || '', handlerName || '', handlingOpinion || '', conclusion, objectionId]
    );

    const announcement = queryOne(db, 'SELECT * FROM bidding_announcements WHERE id = ?', [objection.announcement_id]);

    addAuditLog(db, {
        announcementId: objection.announcement_id, actionType: 'objection_handle',
        operatorId: handlerId, operatorName: handlerName,
        beforeStatus: 'pending', afterStatus: conclusion,
        detail: `异议处理：${conclusion === 'upheld' ? '异议成立' : '异议不成立'}，处理意见：${handlingOpinion}`,
        supplierId: objection.supplier_id, supplierName: objection.supplier_name
    });

    const conclusionText = conclusion === 'upheld' ? '异议成立' : '异议不成立';
    notifySupplier(db, objection.supplier_id, '异议处理结果',
        `项目"${announcement ? announcement.title : ''}"您提交的异议已处理：${conclusionText}，处理意见：${handlingOpinion}`,
        conclusion === 'upheld' ? 'success' : 'info', objectionId, 'objection');
    notifySupervisor(db, '异议处理完成',
        `项目"${announcement ? announcement.title : ''}"供应商"${objection.supplier_name}"异议已处理：${conclusionText}`,
        'info', objectionId, 'objection');

    return {
        success: true,
        data: {
            objection_id: objectionId,
            status: conclusion,
            handler_name: handlerName,
            conclusion_text: conclusionText
        }
    };
}

function listObjections(db, filters = {}) {
    let sql = 'SELECT * FROM objections WHERE 1=1';
    const params = [];
    if (filters.announcement_id) {
        sql += ' AND announcement_id = ?';
        params.push(filters.announcement_id);
    }
    if (filters.supplier_id) {
        sql += ' AND supplier_id = ?';
        params.push(filters.supplier_id);
    }
    if (filters.status) {
        sql += ' AND status = ?';
        params.push(filters.status);
    }
    sql += ' ORDER BY created_at DESC';
    return queryAll(db, sql, params);
}

function hasPendingObjections(db, announcementId) {
    const result = queryOne(db,
        'SELECT COUNT(*) as cnt FROM objections WHERE announcement_id = ? AND status = ?',
        [announcementId, 'pending']
    );
    return result.cnt > 0;
}

module.exports = { submitObjection, handleObjection, listObjections, hasPendingObjections, addAuditLog, getAuditTimeline };
