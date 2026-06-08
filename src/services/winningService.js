const { queryAll, queryOne, queryRun, generateId } = require('../database/helpers');
const { notifySupplier, notifySupervisor, notifyPurchaser } = require('./notificationService');

function approveWinningResult(db, announcementId, approvedBy) {
    const announcement = queryOne(db, 'SELECT * FROM bidding_announcements WHERE id = ?', [announcementId]);
    if (!announcement) {
        return { success: false, message: '招标公告不存在' };
    }

    const evaluations = queryAll(db,
        'SELECT * FROM evaluations WHERE announcement_id = ? AND is_candidate = 1 ORDER BY ranking',
        [announcementId]
    );

    if (evaluations.length === 0) {
        return { success: false, message: '无中标候选人' };
    }

    const winner = evaluations[0];
    const supplier = queryOne(db, 'SELECT * FROM suppliers WHERE id = ?', [winner.supplier_id]);

    let winAmount = winner.bid_price;
    if (!winAmount || winAmount <= 0) {
        const bidDoc = queryOne(db,
            'SELECT bid_price FROM bid_documents WHERE announcement_id = ? AND supplier_id = ? AND is_valid = 1',
            [announcementId, winner.supplier_id]
        );
        winAmount = (bidDoc && bidDoc.bid_price > 0) ? bidDoc.bid_price : announcement.budget;
    }

    const existingResult = queryOne(db,
        'SELECT * FROM winning_results WHERE announcement_id = ? AND supplier_id = ?',
        [announcementId, winner.supplier_id]
    );

    let resultId;
    if (existingResult) {
        resultId = existingResult.id;
        queryRun(db,
            `UPDATE winning_results SET status = 'approved', win_amount = ?, approved_by = ?, approved_at = datetime('now','localtime') WHERE id = ?`,
            [winAmount, approvedBy, resultId]
        );
    } else {
        resultId = generateId('WIN');
        queryRun(db,
            `INSERT INTO winning_results (id, announcement_id, supplier_id, supplier_name, total_score, win_amount, status, approved_by, approved_at)
             VALUES (?, ?, ?, ?, ?, ?, 'approved', ?, datetime('now','localtime'))`,
            [resultId, announcementId, winner.supplier_id,
             supplier ? supplier.name : '', winner.total_score, winAmount, approvedBy]
        );
    }

    const resultAnnouncementContent = generateResultAnnouncement(announcement, winner, supplier, winAmount);
    const resultAnnId = generateId('RAN');
    queryRun(db, 'UPDATE winning_results SET result_announcement_id = ? WHERE id = ?', [resultAnnId, resultId]);

    const contractId = generateId('CON');
    const contractDraft = generateContractDraft(announcement, winner, supplier, resultId, winAmount);
    queryRun(db,
        `INSERT INTO contracts
         (id, winning_result_id, announcement_id, purchaser_id, purchaser_name, supplier_id, supplier_name,
          title, amount, delivery_date, status, breach_clause, penalty_rate)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
        [contractId, resultId, announcementId, announcement.purchaser_id,
         announcement.purchaser_id, winner.supplier_id,
         supplier ? supplier.name : '',
         announcement.title + '采购合同',
         winAmount,
         announcement.bid_opening_date,
         contractDraft.breach_clause,
         contractDraft.penalty_rate]
    );

    queryRun(db, 'UPDATE winning_results SET contract_id = ? WHERE id = ?', [contractId, resultId]);

    queryRun(db,
        `UPDATE bidding_announcements SET status = 'awarded', updated_at = datetime('now','localtime') WHERE id = ?`,
        [announcementId]
    );

    notifySupplier(db, winner.supplier_id, '中标通知',
        `恭喜您中标项目"${announcement.title}"，中标金额：￥${winAmount.toFixed(2)}，请及时确认合同`,
        'success', announcementId, 'winning_result');
    notifyPurchaser(db, announcement.request_id, '中标结果审批完成',
        `项目"${announcement.title}"中标结果已审批，中标供应商：${supplier ? supplier.name : ''}，中标金额：￥${winAmount.toFixed(2)}，合同草稿已生成`,
        'success');
    notifySupervisor(db, '中标公告已发布',
        `项目"${announcement.title}"中标结果已审批并发布公告，中标金额：￥${winAmount.toFixed(2)}`,
        'info', resultAnnId, 'result_announcement');

    const otherCandidates = evaluations.slice(1);
    otherCandidates.forEach(candidate => {
        notifySupplier(db, candidate.supplier_id, '评标结果通知',
            `项目"${announcement.title}"评标结果已出，您未中标，感谢参与`,
            'info', announcementId, 'evaluation');
    });

    return {
        success: true,
        data: {
            result_id: resultId,
            win_amount: winAmount,
            winner: {
                supplier_id: winner.supplier_id,
                supplier_name: supplier ? supplier.name : '',
                total_score: winner.total_score,
                ranking: winner.ranking
            },
            result_announcement: resultAnnouncementContent,
            contract_id: contractId,
            contract_draft: contractDraft
        }
    };
}

function generateResultAnnouncement(announcement, winner, supplier, winAmount) {
    return {
        title: `中标结果公告 - ${announcement.title}`,
        announcement_no: announcement.announcement_no,
        project_name: announcement.title,
        procurement_method: announcement.procurement_method,
        winner_name: supplier ? supplier.name : '',
        winner_score: winner.total_score,
        win_amount: winAmount,
        published_at: new Date().toISOString()
    };
}

function generateContractDraft(announcement, winner, supplier, resultId, winAmount) {
    const penaltyRate = 0.0005;
    const maxPenaltyRate = 0.05;

    return {
        title: `${announcement.title}采购合同`,
        party_a: announcement.purchaser_id,
        party_b: supplier ? supplier.name : '',
        amount: winAmount,
        signing_date: new Date().toISOString().slice(0, 10),
        delivery_date: announcement.bid_opening_date,
        breach_clause: `逾期交货每日按合同金额的${(penaltyRate * 100).toFixed(2)}%计算违约金，最高不超过合同金额的${(maxPenaltyRate * 100).toFixed(0)}%；验收不合格按合同金额的5%计算违约金`,
        penalty_rate: penaltyRate,
        max_penalty_rate: maxPenaltyRate,
        payment_terms: '合同签订后支付30%，交付验收合格后支付65%，质保期满后支付5%',
        warranty_period: '1年'
    };
}

function listWinningResults(db, filters = {}) {
    let sql = 'SELECT * FROM winning_results WHERE 1=1';
    const params = [];
    if (filters.status) {
        sql += ' AND status = ?';
        params.push(filters.status);
    }
    sql += ' ORDER BY created_at DESC';
    return queryAll(db, sql, params);
}

function getWinningResult(db, resultId) {
    return queryOne(db, 'SELECT * FROM winning_results WHERE id = ?', [resultId]);
}

module.exports = { approveWinningResult, listWinningResults, getWinningResult };
