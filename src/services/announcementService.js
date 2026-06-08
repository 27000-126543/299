const { queryAll, queryOne, queryRun, generateId, generateAnnouncementNo } = require('../database/helpers');
const { notifySupplier, notifySupervisor } = require('./notificationService');

function generateAnnouncementContent(request, announcement) {
    return `
【招标公告】

项目名称：${request.title}
项目编号：${announcement.announcement_no}
采购方式：${announcement.procurement_method}
品目分类：${request.category}
预算金额：${(request.budget / 10000).toFixed(2)}万元

一、项目概况
${request.description}

二、资格要求
1. 具有独立承担民事责任的能力
2. 具有良好的商业信誉和健全的财务会计制度
3. 具有履行合同所必需的设备和专业技术能力
4. 参加政府采购活动前三年内无重大违法记录

三、获取招标文件
时间：公告发布之日起至投标截止日前
方式：在线下载

四、投标截止时间
${announcement.deadline}

五、开标时间及地点
时间：${announcement.bid_opening_date}
地点：线上开标大厅

六、联系方式
采购单位：${request.purchaser_name || request.dept_name}
    `.trim();
}

function recommendSuppliers(db, category, announcementId) {
    const suppliers = queryAll(db,
        `SELECT * FROM suppliers WHERE status = 'active' AND (category LIKE ? OR category = '全部')`,
        [`%${category}%`]
    );

    const recommended = suppliers.map(s => {
        let matchScore = 50;
        if (s.category && s.category.includes(category)) matchScore += 30;
        if (s.qualification_level === '甲级' || s.qualification_level === '一级') matchScore += 15;
        if (s.credit_score >= 90) matchScore += 10;
        if (s.credit_score < 60) matchScore -= 20;
        matchScore = Math.max(0, Math.min(100, matchScore));

        return { ...s, matchScore };
    }).sort((a, b) => b.matchScore - a.matchScore).slice(0, 10);

    recommended.forEach(s => {
        const id = generateId('RSUP');
        queryRun(db,
            `INSERT INTO recommended_suppliers (id, announcement_id, supplier_id, match_score) VALUES (?, ?, ?, ?)`,
            [id, announcementId, s.id, s.matchScore]
        );
    });

    return recommended;
}

function createAnnouncement(db, requestId) {
    const request = queryOne(db, 'SELECT * FROM procurement_requests WHERE id = ?', [requestId]);
    if (!request) {
        return { success: false, message: '采购需求不存在' };
    }

    if (request.status !== 'approved') {
        return { success: false, message: '采购需求未通过审核，无法发布公告' };
    }

    const id = generateId('ANN');
    const announcementNo = generateAnnouncementNo();
    const deadline = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const bidOpeningDate = new Date(Date.now() + 22 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    queryRun(db,
        `INSERT INTO bidding_announcements
         (id, request_id, announcement_no, title, procurement_method, category, budget, deadline, bid_opening_date, status, purchaser_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, requestId, announcementNo, request.title, request.recommended_method,
         request.category, request.budget, deadline, bidOpeningDate, 'published', request.purchaser_id]
    );

    const announcement = queryOne(db, 'SELECT * FROM bidding_announcements WHERE id = ?', [id]);
    const content = generateAnnouncementContent(request, announcement);
    queryRun(db, 'UPDATE bidding_announcements SET content = ? WHERE id = ?', [content, id]);

    queryRun(db,
        `UPDATE procurement_requests SET status = 'announced', updated_at = datetime('now','localtime') WHERE id = ?`,
        [requestId]
    );

    const recommendedSuppliers = recommendSuppliers(db, request.category, id);

    const allSuppliers = queryAll(db, "SELECT * FROM suppliers WHERE status = 'active'");
    allSuppliers.forEach(s => {
        notifySupplier(db, s.id, '新的招标公告',
            `项目"${request.title}"已发布招标公告，采购方式：${request.recommended_method}，预算：${(request.budget / 10000).toFixed(2)}万元`,
            'info', id, 'bidding_announcement');
    });

    notifySupervisor(db, '招标公告已发布',
        `项目"${request.title}"招标公告已发布，编号：${announcementNo}`,
        'info', id, 'bidding_announcement');

    return {
        success: true,
        data: {
            id,
            announcement_no: announcementNo,
            content,
            recommended_suppliers: recommendedSuppliers.map(s => ({
                id: s.id, name: s.name, match_score: s.matchScore,
                qualification_level: s.qualification_level, credit_score: s.credit_score
            }))
        }
    };
}

function listAnnouncements(db, filters = {}) {
    let sql = 'SELECT * FROM bidding_announcements WHERE 1=1';
    const params = [];

    if (filters.status) {
        sql += ' AND status = ?';
        params.push(filters.status);
    }
    if (filters.procurement_method) {
        sql += ' AND procurement_method = ?';
        params.push(filters.procurement_method);
    }
    if (filters.category) {
        sql += ' AND category = ?';
        params.push(filters.category);
    }

    sql += ' ORDER BY created_at DESC';
    return queryAll(db, sql, params);
}

function getAnnouncement(db, announcementId) {
    const announcement = queryOne(db, 'SELECT * FROM bidding_announcements WHERE id = ?', [announcementId]);
    if (announcement) {
        announcement.recommended_suppliers = queryAll(db,
            'SELECT rs.*, s.name as supplier_name, s.qualification_level, s.credit_score FROM recommended_suppliers rs JOIN suppliers s ON rs.supplier_id = s.id WHERE rs.announcement_id = ?',
            [announcementId]
        );
    }
    return announcement;
}

module.exports = { createAnnouncement, listAnnouncements, getAnnouncement, recommendSuppliers };
