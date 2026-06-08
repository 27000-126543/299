const { queryRun } = require('../database/helpers');
const { generateId } = require('../database/helpers');

function createNotification(db, { type, title, content, recipientType, recipientId, relatedId, relatedType }) {
    const id = generateId('NOTI');
    queryRun(db,
        `INSERT INTO notifications (id, type, title, content, recipient_type, recipient_id, related_id, related_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, type, title, content, recipientType, recipientId, relatedId || '', relatedType || '']
    );
    return id;
}

function notifyPurchaser(db, requestId, title, content, type = 'info') {
    const request = db.prepare('SELECT purchaser_id FROM procurement_requests WHERE id = ?').getAsObject([requestId]);
    if (request) {
        createNotification(db, {
            type, title, content,
            recipientType: 'purchaser',
            recipientId: request.purchaser_id,
            relatedId: requestId,
            relatedType: 'procurement_request'
        });
    }
}

function notifySupplier(db, supplierId, title, content, type = 'info', relatedId = '', relatedType = '') {
    createNotification(db, {
        type, title, content,
        recipientType: 'supplier',
        recipientId: supplierId,
        relatedId,
        relatedType
    });
}

function notifySupervisor(db, title, content, type = 'info', relatedId = '', relatedType = '') {
    createNotification(db, {
        type, title, content,
        recipientType: 'supervisor',
        recipientId: 'SUPERVISOR',
        relatedId,
        relatedType
    });
}

module.exports = { createNotification, notifyPurchaser, notifySupplier, notifySupervisor };
