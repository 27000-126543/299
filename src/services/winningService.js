const { queryAll, queryOne, queryRun, generateId } = require('../database/helpers');
const { notifySupplier, notifySupervisor, notifyPurchaser } = require('./notificationService');
const { hasPendingObjections, addAuditLog } = require('./objectionService');

function approveWinningResult(db, announcementId, approvedBy) {
    const announcement = queryOne(db, 'SELECT * FROM bidding_announcements WHERE id = ?', [announcementId]);
    if (!announcement) {
        return { success: false, message: '招标公告不存在' };
    }

    if (hasPendingObjections(db, announcementId)) {
        const pendingObjections = queryAll(db,
            'SELECT * FROM objections WHERE announcement_id = ? AND status = ?',
            [announcementId, 'pending']
        );
        addAuditLog(db, {
            announcementId, actionType: 'winning_approval_blocked',
            operatorId: approvedBy, operatorName: approvedBy,
            beforeStatus: announcement.status, afterStatus: announcement.status,
            detail: `中标审批被拦截：存在${pendingObjections.length}条未处理异议`
        });
        return {
            success: false,
            message: `存在${pendingObjections.length}条未处理异议，请先处理异议后再审批中标`,
            data: {
                pending_objections: pendingObjections.map(o => ({
                    objection_id: o.id,
                    supplier_name: o.supplier_name,
                    objection_type: o.objection_type,
                    objection_content: o.objection_content,
                    status: o.status
                }))
            }
        };
    }

    const evaluations = queryAll(db,
        'SELECT * FROM evaluations WHERE announcement_id = ? AND is_candidate = 1 ORDER BY ranking',
        [announcementId]
    );

    if (evaluations.length === 0) {
        return { success: false, message: '无中标候选人' };
    }

    const passedEvaluations = evaluations.filter(e => e.qualification_review_status === 'passed');
    const pendingEvaluations = evaluations.filter(e => e.qualification_review_status === 'pending' || !e.qualification_review_status);
    const failedEvaluations = evaluations.filter(e => e.qualification_review_status === 'failed');

    if (passedEvaluations.length === 0) {
        addAuditLog(db, {
            announcementId, actionType: 'winning_approval_blocked',
            operatorId: approvedBy, operatorName: approvedBy,
            beforeStatus: announcement.status, afterStatus: announcement.status,
            detail: `中标审批失败：所有候选人均未通过资格复核（${failedEvaluations.length}人不通过，${pendingEvaluations.length}人待复核）`
        });
        return {
            success: false,
            message: `所有候选人均未通过资格复核（${failedEvaluations.length}人不通过，${pendingEvaluations.length}人待复核），无法审批中标`,
            data: {
                failed_candidates: failedEvaluations.map(e => ({ supplier_name: e.supplier_name, ranking: e.ranking, review_status: 'failed' })),
                pending_candidates: pendingEvaluations.map(e => ({ supplier_name: e.supplier_name, ranking: e.ranking, review_status: 'pending' }))
            }
        };
    }

    const winner = passedEvaluations[0];
    const supplier = queryOne(db, 'SELECT * FROM suppliers WHERE id = ?', [winner.supplier_id]);

    let winAmount = winner.bid_price;
    if (!winAmount || winAmount <= 0) {
        const bidDoc = queryOne(db,
            'SELECT bid_price FROM bid_documents WHERE announcement_id = ? AND supplier_id = ? AND is_valid = 1',
            [announcementId, winner.supplier_id]
        );
        winAmount = (bidDoc && bidDoc.bid_price > 0) ? bidDoc.bid_price : announcement.budget;
    }

    const isFallback = winner.ranking > 1;
    const beforeStatus = announcement.status;

    const existingResult = queryOne(db,
        'SELECT * FROM winning_results WHERE announcement_id = ?',
        [announcementId]
    );

    let resultId;
    if (existingResult) {
        resultId = existingResult.id;
        queryRun(db,
            `UPDATE winning_results SET supplier_id = ?, supplier_name = ?, total_score = ?, win_amount = ?, status = 'approved', approved_by = ?, approved_at = datetime('now','localtime') WHERE id = ?`,
            [winner.supplier_id, supplier ? supplier.name : '', winner.total_score, winAmount, approvedBy, resultId]
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

    const resultAnnouncementContent = generateResultAnnouncement(announcement, winner, supplier, winAmount, isFallback, failedEvaluations);
    const resultAnnId = generateId('RAN');
    queryRun(db, 'UPDATE winning_results SET result_announcement_id = ? WHERE id = ?', [resultAnnId, resultId]);

    const existingContract = queryOne(db,
        'SELECT * FROM contracts WHERE announcement_id = ?',
        [announcementId]
    );
    let contractId;
    if (existingContract) {
        contractId = existingContract.id;
        queryRun(db,
            `UPDATE contracts SET supplier_id = ?, supplier_name = ?, amount = ?, status = 'draft', updated_at = datetime('now','localtime') WHERE id = ?`,
            [winner.supplier_id, supplier ? supplier.name : '', winAmount, contractId]
        );
    } else {
        contractId = generateId('CON');
        const contractDraft = generateContractDraft(announcement, winner, supplier, resultId, winAmount);
        queryRun(db,
            `INSERT INTO contracts
             (id, winning_result_id, announcement_id, purchaser_id, purchaser_name, supplier_id, supplier_name,
              title, amount, delivery_date, status, breach_clause, penalty_rate)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
            [contractId, resultId, announcementId, announcement.purchaser_id,
             announcement.purchaser_id, winner.supplier_id,
             supplier ? supplier.name : '',
             announcement.title + '采购合同', winAmount,
             announcement.bid_opening_date,
             contractDraft.breach_clause, contractDraft.penalty_rate]
        );
    }

    queryRun(db, 'UPDATE winning_results SET contract_id = ? WHERE id = ?', [contractId, resultId]);

    queryRun(db,
        `UPDATE bidding_announcements SET status = 'awarded', updated_at = datetime('now','localtime') WHERE id = ?`,
        [announcementId]
    );

    addAuditLog(db, {
        announcementId, actionType: 'winning_approval',
        operatorId: approvedBy, operatorName: approvedBy,
        beforeStatus: beforeStatus, afterStatus: 'awarded',
        detail: `中标审批完成，中标供应商：${supplier ? supplier.name : ''}，中标金额：￥${winAmount.toFixed(2)}${isFallback ? '（顺延）' : ''}`,
        supplierId: winner.supplier_id, supplierName: supplier ? supplier.name : ''
    });

    notifySupplier(db, winner.supplier_id, '中标通知',
        `恭喜您中标项目"${announcement.title}"，中标金额：￥${winAmount.toFixed(2)}，请及时确认合同`,
        'success', announcementId, 'winning_result');
    notifyPurchaser(db, announcement.request_id, '中标结果审批完成',
        `项目"${announcement.title}"中标结果已审批，中标供应商：${supplier ? supplier.name : ''}，中标金额：￥${winAmount.toFixed(2)}，合同草稿已生成`,
        'success');
    notifySupervisor(db, '中标公告已发布',
        `项目"${announcement.title}"中标结果已审批并发布公告，中标金额：￥${winAmount.toFixed(2)}${isFallback ? `（原第1名复核不通过，顺延至第${winner.ranking}名）` : ''}`,
        'info', resultAnnId, 'result_announcement');

    const otherCandidates = evaluations.filter(e => e.supplier_id !== winner.supplier_id);
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
                ranking: winner.ranking,
                qualification_review_status: winner.qualification_review_status
            },
            is_fallback: isFallback,
            fallback_reason: isFallback ? `原第1名候选人资格复核未通过，顺延至第${winner.ranking}名` : null,
            failed_candidates: failedEvaluations.map(e => ({
                supplier_name: e.supplier_name,
                ranking: e.ranking,
                review_status: 'failed'
            })),
            result_announcement: resultAnnouncementContent,
            contract_id: contractId,
            contract_draft: generateContractDraft(announcement, winner, supplier, resultId, winAmount)
        }
    };
}

function generateResultAnnouncement(announcement, winner, supplier, winAmount, isFallback, failedEvaluations) {
    return {
        title: `中标结果公告 - ${announcement.title}`,
        announcement_no: announcement.announcement_no,
        project_name: announcement.title,
        procurement_method: announcement.procurement_method,
        winner_name: supplier ? supplier.name : '',
        winner_score: winner.total_score,
        win_amount: winAmount,
        is_fallback: isFallback || false,
        fallback_reason: isFallback ? `原第1名候选人资格复核未通过，顺延至第${winner.ranking}名` : null,
        failed_candidates: (failedEvaluations || []).map(e => ({
            supplier_name: e.supplier_name,
            ranking: e.ranking,
            reason: '资格复核未通过'
        })),
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
