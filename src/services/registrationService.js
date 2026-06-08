const { queryAll, queryOne, queryRun, generateId } = require('../database/helpers');
const { notifySupplier, notifySupervisor, notifyPurchaser } = require('./notificationService');

const MIN_CREDIT_SCORE = 60;

const CATEGORY_REQUIRED_QUALIFICATIONS = {
    '工程类': ['建筑工程施工总承包', '市政公用工程施工总承包', '甲级', '一级', '特级'],
    '货物类': ['生产许可证', '经营许可证', '产品认证'],
    '服务类': ['资质证书', '行业许可']
};

function checkQualification(supplier, category) {
    if (supplier.status !== 'active') {
        return { passed: false, reason: '供应商状态非正常', missing_qualifications: [] };
    }

    if (supplier.credit_score < MIN_CREDIT_SCORE) {
        return { passed: false, reason: `信用评分${supplier.credit_score}分，低于最低要求${MIN_CREDIT_SCORE}分`, missing_qualifications: [] };
    }

    const requiredQualifications = CATEGORY_REQUIRED_QUALIFICATIONS[category];
    if (!requiredQualifications || requiredQualifications.length === 0) {
        return { passed: true, reason: '资质校验通过' };
    }

    let qualStr = supplier.qualifications || '';
    if (Buffer.isBuffer(qualStr)) {
        qualStr = qualStr.toString('utf8');
    }
    const supplierQualifications = qualStr.split(',').map(q => q.trim()).filter(q => q);
    if (supplierQualifications.length === 0) {
        return {
            passed: false,
            reason: `${category}项目要求供应商具备以下资质之一：${requiredQualifications.join('、')}，该供应商未持有任何资质`,
            missing_qualifications: requiredQualifications
        };
    }

    const hasMatching = requiredQualifications.some(req =>
        supplierQualifications.some(sup => sup.includes(req) || req.includes(sup))
    );

    if (!hasMatching) {
        return {
            passed: false,
            reason: `${category}项目要求供应商具备以下资质之一：${requiredQualifications.join('、')}，该供应商持有资质（${supplierQualifications.join('、')}）均不匹配`,
            missing_qualifications: requiredQualifications
        };
    }

    return { passed: true, reason: '资质校验通过' };
}

function checkCredit(supplier) {
    if (supplier.credit_score < 60) {
        return { status: 'poor', detail: `信用评分${supplier.credit_score}分，属于差等级` };
    } else if (supplier.credit_score < 80) {
        return { status: 'fair', detail: `信用评分${supplier.credit_score}分，属于一般等级` };
    }
    return { status: 'good', detail: `信用评分${supplier.credit_score}分，属于良好等级` };
}

function calculateDepositAmount(budget, method) {
    const rates = {
        '公开招标': 0.02,
        '竞争性谈判': 0.02,
        '竞争性磋商': 0.02,
        '询价采购': 0.01,
        '单一来源': 0.01
    };
    const rate = rates[method] || 0.02;
    let amount = budget * rate;
    amount = Math.max(1000, Math.min(amount, 800000));
    return Math.round(amount * 100) / 100;
}

function generateDepositNotice(supplier, announcement, amount) {
    return {
        notice_no: `BZ${new Date().toISOString().slice(0, 10).replace(/-/g, '')}${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`,
        supplier_name: supplier.name,
        project_title: announcement.title,
        announcement_no: announcement.announcement_no,
        deposit_amount: amount,
        payment_deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
        payment_account: '6225 XXXX XXXX XXXX',
        bank_name: '中国银行XX支行',
        notice: `请于规定期限内缴纳投标保证金￥${amount.toFixed(2)}元，逾期视为放弃投标资格。`
    };
}

function registerSupplier(db, announcementId, supplierId) {
    const announcement = queryOne(db, 'SELECT * FROM bidding_announcements WHERE id = ?', [announcementId]);
    if (!announcement) {
        return { success: false, message: '招标公告不存在' };
    }

    if (announcement.status !== 'published') {
        return { success: false, message: '该公告不在报名期内' };
    }

    const supplier = queryOne(db, 'SELECT * FROM suppliers WHERE id = ?', [supplierId]);
    if (!supplier) {
        return { success: false, message: '供应商不存在' };
    }

    const existing = queryOne(db,
        'SELECT * FROM supplier_registrations WHERE announcement_id = ? AND supplier_id = ?',
        [announcementId, supplierId]
    );
    if (existing) {
        return { success: false, message: '该供应商已报名此项目' };
    }

    const qualCheck = checkQualification(supplier, announcement.category);
    const creditCheck = checkCredit(supplier);

    const id = generateId('REG');
    const checkResult = qualCheck.passed ? 'passed' : 'rejected';

    queryRun(db,
        `INSERT INTO supplier_registrations
         (id, announcement_id, supplier_id, supplier_name, qualification_status, credit_status, check_result, reject_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, announcementId, supplierId, supplier.name,
         qualCheck.passed ? 'passed' : 'failed',
         creditCheck.status,
         checkResult,
         qualCheck.passed ? '' : qualCheck.reason]
    );

    if (!qualCheck.passed) {
        notifySupplier(db, supplierId, '报名被拒绝',
            `您对项目"${announcement.title}"的报名被拒绝，原因：${qualCheck.reason}`,
            'warning', announcementId, 'supplier_registration');
        notifySupervisor(db, '供应商报名被拒绝',
            `供应商"${supplier.name}"对项目"${announcement.title}"的报名因资质不符被拒绝`,
            'warning', announcementId, 'supplier_registration');

        return {
            success: false,
            message: '资质校验未通过，报名被拒绝',
            reason: qualCheck.reason,
            missing_qualifications: qualCheck.missing_qualifications
        };
    }

    const depositAmount = calculateDepositAmount(announcement.budget, announcement.procurement_method);
    queryRun(db,
        'UPDATE supplier_registrations SET deposit_amount = ? WHERE id = ?',
        [depositAmount, id]
    );

    const depositNotice = generateDepositNotice(supplier, announcement, depositAmount);
    const noticeId = generateId('DNO');
    queryRun(db, 'UPDATE supplier_registrations SET deposit_notice_id = ? WHERE id = ?', [noticeId, id]);

    notifySupplier(db, supplierId, '报名成功',
        `您已成功报名项目"${announcement.title}"，请及时缴纳保证金￥${depositAmount.toFixed(2)}元`,
        'success', announcementId, 'supplier_registration');
    notifyPurchaser(db, announcement.request_id, '有供应商报名',
        `供应商"${supplier.name}"已报名项目"${announcement.title}"`,
        'info');
    notifySupervisor(db, '供应商报名通过',
        `供应商"${supplier.name}"已通过资质校验，报名项目"${announcement.title}"`,
        'info', id, 'supplier_registration');

    return {
        success: true,
        data: {
            registration_id: id,
            check_result: checkResult,
            deposit_notice: depositNotice
        }
    };
}

function listRegistrations(db, announcementId) {
    return queryAll(db,
        'SELECT * FROM supplier_registrations WHERE announcement_id = ? ORDER BY registered_at',
        [announcementId]
    );
}

function confirmDeposit(db, registrationId) {
    const reg = queryOne(db, 'SELECT * FROM supplier_registrations WHERE id = ?', [registrationId]);
    if (!reg) {
        return { success: false, message: '报名记录不存在' };
    }
    queryRun(db, 'UPDATE supplier_registrations SET deposit_status = ? WHERE id = ?', ['paid', registrationId]);
    return { success: true, data: { registration_id: registrationId, deposit_status: 'paid' } };
}

module.exports = { registerSupplier, listRegistrations, confirmDeposit, checkQualification, checkCredit, calculateDepositAmount };
