const { queryAll, queryOne, queryRun, generateId } = require('../database/helpers');
const { notifySupplier, notifySupervisor, notifyPurchaser } = require('./notificationService');

function getEvaluationRule(db, category, method) {
    let rule = queryOne(db,
        'SELECT * FROM evaluation_rules WHERE category = ? AND procurement_method = ? AND is_active = 1',
        [category, method]
    );
    if (!rule) {
        rule = queryOne(db,
            "SELECT * FROM evaluation_rules WHERE category = 'default' AND procurement_method = ? AND is_active = 1",
            [method]
        );
    }
    if (!rule) {
        rule = queryOne(db,
            "SELECT * FROM evaluation_rules WHERE category = 'default' AND is_active = 1"
        );
    }
    if (!rule) {
        rule = {
            technical_weight: 60,
            business_weight: 20,
            price_weight: 20,
            pass_score: 60
        };
    }
    return rule;
}

function calculatePriceScore(allPrices, supplierPrice, method) {
    const validPrices = allPrices.filter(p => p > 0);
    if (validPrices.length === 0 || supplierPrice <= 0) return 0;

    let benchmarkPrice;
    if (method === '公开招标') {
        const sorted = [...validPrices].sort((a, b) => a - b);
        if (sorted.length >= 5) {
            const trimmed = sorted.slice(1, -1);
            benchmarkPrice = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
        } else {
            benchmarkPrice = sorted.reduce((a, b) => a + b, 0) / sorted.length;
        }
    } else {
        benchmarkPrice = Math.min(...validPrices);
    }

    if (supplierPrice <= benchmarkPrice) {
        return 100;
    }
    const deviation = (supplierPrice - benchmarkPrice) / benchmarkPrice;
    return Math.max(0, Math.round((100 - deviation * 100) * 100) / 100);
}

function checkPriceAlert(bidPrice, allPrices, budget) {
    const alerts = [];
    const validPrices = allPrices.filter(p => p > 0);
    if (validPrices.length <= 1 || bidPrice <= 0) return alerts;

    if (budget && bidPrice > budget) {
        alerts.push({ type: 'over_budget', message: `报价￥${bidPrice}超过项目预算￥${budget}`, severity: 'high' });
    }

    const avgPrice = validPrices.reduce((a, b) => a + b, 0) / validPrices.length;
    const minPrice = Math.min(...validPrices.filter(p => p !== bidPrice));
    if (bidPrice < minPrice * 0.6) {
        alerts.push({ type: 'abnormally_low', message: `报价￥${bidPrice}明显低于其他有效报价均价￥${avgPrice.toFixed(2)}，可能存在低价倾销风险`, severity: 'medium' });
    }

    return alerts;
}

function evaluateBids(db, announcementId) {
    const announcement = queryOne(db, 'SELECT * FROM bidding_announcements WHERE id = ?', [announcementId]);
    if (!announcement) {
        return { success: false, message: '招标公告不存在' };
    }

    const validStatuses = ['bid_opened', 'evaluated', 'awarded'];
    if (!validStatuses.includes(announcement.status)) {
        return { success: false, message: '项目尚未完成开标' };
    }

    const validBids = queryAll(db,
        'SELECT * FROM bid_documents WHERE announcement_id = ? AND is_valid = 1',
        [announcementId]
    );

    if (validBids.length === 0) {
        if (announcement.status !== 'failed_bid') {
            queryRun(db,
                `UPDATE bidding_announcements SET status = 'failed_bid', updated_at = datetime('now','localtime') WHERE id = ?`,
                [announcementId]
            );
            notifyPurchaser(db, announcement.request_id, '流标通知',
                `项目"${announcement.title}"无有效投标，流标处理`,
                'warning');
            notifySupervisor(db, '项目流标',
                `项目"${announcement.title}"无有效投标，流标处理`,
                'warning', announcementId, 'bidding_announcement');
        }
        return { success: false, message: '无有效投标，流标处理' };
    }

    const rule = getEvaluationRule(db, announcement.category, announcement.procurement_method);
    const budget = announcement.budget || 0;

    const isReEvaluation = queryOne(db,
        'SELECT COUNT(*) as cnt FROM evaluations WHERE announcement_id = ?',
        [announcementId]
    ).cnt > 0;

    const existingEvals = isReEvaluation ? queryAll(db,
        'SELECT supplier_id, ranking, total_score, qualification_review_id, qualification_review_status FROM evaluations WHERE announcement_id = ?',
        [announcementId]
    ) : [];
    const prevRankingMap = {};
    const prevScoreMap = {};
    const existingReviewMap = {};
    existingEvals.forEach(e => {
        prevRankingMap[e.supplier_id] = e.ranking;
        prevScoreMap[e.supplier_id] = e.total_score;
        if (e.qualification_review_id) {
            existingReviewMap[e.supplier_id] = {
                review_id: e.qualification_review_id,
                status: e.qualification_review_status
            };
        }
    });

    const allPrices = validBids.map(bd => bd.bid_price || 0);

    if (existingEvals.length > 0) {
        queryRun(db, 'DELETE FROM evaluations WHERE announcement_id = ?', [announcementId]);
    }

    const evaluationResults = [];
    const overBudgetSuppliers = new Set();

    validBids.forEach(bid => {
        const supplier = queryOne(db, 'SELECT * FROM suppliers WHERE id = ?', [bid.supplier_id]);

        const technicalScore = bid.technical_score || 0;
        const businessScore = bid.business_score || 0;
        const bidPrice = bid.bid_price || 0;

        const priceScore = calculatePriceScore(allPrices, bidPrice, announcement.procurement_method);

        const totalScore = Math.round(
            (technicalScore * rule.technical_weight +
             businessScore * rule.business_weight +
             priceScore * rule.price_weight) / 100 * 100
        ) / 100;

        const priceAlerts = checkPriceAlert(bidPrice, allPrices, budget);
        const isOverBudget = budget > 0 && bidPrice > budget;
        if (isOverBudget) {
            overBudgetSuppliers.add(bid.supplier_id);
        }

        const evalId = generateId('EVAL');
        queryRun(db,
            `INSERT INTO evaluations
             (id, announcement_id, supplier_id, supplier_name, technical_score, business_score, price_score, total_score, bid_price, price_alert)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [evalId, announcementId, bid.supplier_id,
             supplier ? supplier.name : '', technicalScore, businessScore, priceScore, totalScore, bidPrice,
             priceAlerts.length > 0 ? JSON.stringify(priceAlerts) : null]
        );

        evaluationResults.push({
            eval_id: evalId,
            supplier_id: bid.supplier_id,
            supplier_name: supplier ? supplier.name : '',
            technical_score: technicalScore,
            business_score: businessScore,
            price_score: priceScore,
            bid_price: bidPrice,
            total_score: totalScore,
            price_alerts: priceAlerts,
            is_over_budget: isOverBudget
        });
    });

    evaluationResults.sort((a, b) => b.total_score - a.total_score);

    evaluationResults.forEach((result, index) => {
        const ranking = index + 1;
        const isCandidate = ranking <= 3 && !overBudgetSuppliers.has(result.supplier_id);
        queryRun(db,
            'UPDATE evaluations SET ranking = ?, is_candidate = ? WHERE id = ?',
            [ranking, isCandidate ? 1 : 0, result.eval_id]
        );
        result.ranking = ranking;
        result.is_candidate = isCandidate;

        const prevRanking = prevRankingMap[result.supplier_id];
        const prevScore = prevScoreMap[result.supplier_id];
        result.ranking_change = (prevRanking && prevRanking !== ranking) ? `${prevRanking}→${ranking}` : null;
        result.score_change = (prevScore !== undefined && prevScore !== result.total_score) ? `${prevScore}→${result.total_score}` : null;
    });

    const topCandidates = evaluationResults.filter(r => r.is_candidate).slice(0, 2);
    topCandidates.forEach(candidate => {
        const existingReview = existingReviewMap[candidate.supplier_id];
        let reviewId, reviewStatus;

        if (existingReview) {
            reviewId = existingReview.review_id;
            reviewStatus = existingReview.status === 'passed' ? 'passed' : 'pending';
        } else {
            reviewId = generateId('QRV');
            reviewStatus = 'pending';
        }

        queryRun(db,
            'UPDATE evaluations SET qualification_review_status = ?, qualification_review_id = ? WHERE id = ?',
            [reviewStatus, reviewId, candidate.eval_id]
        );
        candidate.qualification_review_status = reviewStatus;
        candidate.qualification_review_id = reviewId;

        if (!isReEvaluation && !existingReview) {
            notifySupervisor(db, '资格复核工单',
                `项目"${announcement.title}"第${candidate.ranking}名候选人"${candidate.supplier_name}"需进行资格复核`,
                'warning', reviewId, 'qualification_review');
        } else if (isReEvaluation && existingReview) {
            const oldNotifs = queryAll(db,
                "SELECT id FROM notifications WHERE related_id = ? AND related_type = 'qualification_review'",
                [reviewId]
            );
            if (oldNotifs.length === 0) {
                notifySupervisor(db, '资格复核工单',
                    `项目"${announcement.title}"第${candidate.ranking}名候选人"${candidate.supplier_name}"需进行资格复核`,
                    'warning', reviewId, 'qualification_review');
            } else {
                queryRun(db,
                    "UPDATE notifications SET content = ?, title = ? WHERE related_id = ? AND related_type = 'qualification_review'",
                    [`项目"${announcement.title}"第${candidate.ranking}名候选人"${candidate.supplier_name}"需进行资格复核`, '资格复核工单', reviewId]
                );
            }
        }
    });

    const round = isReEvaluation ? (queryOne(db,
        'SELECT MAX(round) as max_round FROM evaluation_history WHERE announcement_id = ?',
        [announcementId]
    ).max_round || 0) + 1 : 1;

    const rankingChanges = evaluationResults
        .filter(r => r.ranking_change || r.score_change)
        .map(r => ({
            supplier_name: r.supplier_name,
            ranking_change: r.ranking_change,
            score_change: r.score_change
        }));

    const historyId = generateId('EVH');
    queryRun(db,
        `INSERT INTO evaluation_history (id, announcement_id, round, is_re_evaluation, score_detail, ranking_change)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [historyId, announcementId, round, isReEvaluation ? 1 : 0,
         JSON.stringify(evaluationResults.map(r => ({
             supplier_name: r.supplier_name,
             supplier_id: r.supplier_id,
             technical_score: r.technical_score,
             business_score: r.business_score,
             price_score: r.price_score,
             bid_price: r.bid_price,
             total_score: r.total_score,
             ranking: r.ranking,
             is_candidate: r.is_candidate,
             is_over_budget: r.is_over_budget,
             price_alerts: r.price_alerts
         }))),
         rankingChanges.length > 0 ? JSON.stringify(rankingChanges) : null]
    );

    if (announcement.status !== 'awarded') {
        queryRun(db,
            `UPDATE bidding_announcements SET status = 'evaluated', updated_at = datetime('now','localtime') WHERE id = ?`,
            [announcementId]
        );
    }

    if (!isReEvaluation) {
        evaluationResults.forEach(result => {
            notifySupplier(db, result.supplier_id, '评标结果通知',
                `项目"${announcement.title}"评标完成，您的综合得分：${result.total_score}分，排名：第${result.ranking}名`,
                result.is_candidate ? 'success' : 'info',
                announcementId, 'evaluation');
        });

        notifyPurchaser(db, announcement.request_id, '评标完成',
            `项目"${announcement.title}"评标完成，共${evaluationResults.length}家有效投标，已生成中标候选人排序`,
            'info');
        notifySupervisor(db, '评标完成',
            `项目"${announcement.title}"评标完成，前2名已触发资格复核`,
            'info', announcementId, 'evaluation');
    } else {
        if (rankingChanges.length > 0) {
            notifyPurchaser(db, announcement.request_id, '评标结果更新',
                `项目"${announcement.title}"重新评标完成，排名或分数有变化`,
                'info');
            notifySupervisor(db, '评标结果更新',
                `项目"${announcement.title}"重新评标完成，排名或分数有变化：${rankingChanges.map(c => `${c.supplier_name}(${[c.ranking_change, c.score_change].filter(Boolean).join(',')})`).join('; ')}`,
                'info', announcementId, 'evaluation');
        }
    }

    const overBudgetAlerts = evaluationResults.filter(r => r.is_over_budget);
    if (overBudgetAlerts.length > 0) {
        notifyPurchaser(db, announcement.request_id, '超预算报价提醒',
            `项目"${announcement.title}"有${overBudgetAlerts.length}家供应商报价超过预算，已排除中标候选`,
            'warning');
        notifySupervisor(db, '超预算报价提醒',
            `项目"${announcement.title}"供应商${overBudgetAlerts.map(r => r.supplier_name).join('、')}报价超过预算￥${budget}`,
            'warning', announcementId, 'evaluation');
    }

    const lowPriceAlerts = evaluationResults.filter(r => r.price_alerts.some(a => a.type === 'abnormally_low'));
    if (lowPriceAlerts.length > 0) {
        notifyPurchaser(db, announcement.request_id, '低价报价风险提示',
            `项目"${announcement.title}"供应商${lowPriceAlerts.map(r => r.supplier_name).join('、')}报价明显偏低`,
            'warning');
    }

    return {
        success: true,
        data: {
            announcement_id: announcementId,
            evaluation_rule: rule,
            score_detail: {
                technical_weight: rule.technical_weight,
                business_weight: rule.business_weight,
                price_weight: rule.price_weight,
                formula: `总分 = 技术分×${rule.technical_weight}% + 商务分×${rule.business_weight}% + 价格分×${rule.price_weight}%`
            },
            candidates: evaluationResults.map(c => ({
                ...c,
                score_breakdown: {
                    technical: { score: c.technical_score, weight: rule.technical_weight, weighted: Math.round(c.technical_score * rule.technical_weight / 100 * 100) / 100 },
                    business: { score: c.business_score, weight: rule.business_weight, weighted: Math.round(c.business_score * rule.business_weight / 100 * 100) / 100 },
                    price: { score: c.price_score, weight: rule.price_weight, weighted: Math.round(c.price_score * rule.price_weight / 100 * 100) / 100 }
                }
            })),
            is_re_evaluation: isReEvaluation,
            round: round,
            ranking_changes: rankingChanges,
            evaluated_at: new Date().toISOString()
        }
    };
}

function getEvaluationResults(db, announcementId) {
    return queryAll(db,
        'SELECT * FROM evaluations WHERE announcement_id = ? ORDER BY ranking',
        [announcementId]
    );
}

function getEvaluationHistory(db, announcementId) {
    return queryAll(db,
        'SELECT * FROM evaluation_history WHERE announcement_id = ? ORDER BY round',
        [announcementId]
    );
}

function reviewQualification(db, reviewId, status, reviewedBy) {
    const evalRecord = queryOne(db,
        'SELECT * FROM evaluations WHERE qualification_review_id = ?',
        [reviewId]
    );
    if (!evalRecord) {
        return { success: false, message: '资格复核记录不存在' };
    }
    if (!['passed', 'failed'].includes(status)) {
        return { success: false, message: '复核状态只能是passed或failed' };
    }

    queryRun(db,
        'UPDATE evaluations SET qualification_review_status = ? WHERE qualification_review_id = ?',
        [status, reviewId]
    );

    const announcement = queryOne(db, 'SELECT * FROM bidding_announcements WHERE id = ?', [evalRecord.announcement_id]);

    if (status === 'passed') {
        notifySupplier(db, evalRecord.supplier_id, '资格复核通过',
            `项目"${announcement ? announcement.title : ''}"资格复核已通过`,
            'success', reviewId, 'qualification_review');
        notifySupervisor(db, '资格复核结果',
            `项目"${announcement ? announcement.title : ''}"候选人"${evalRecord.supplier_name}"资格复核通过，审核人：${reviewedBy}`,
            'info', reviewId, 'qualification_review');
    } else {
        notifySupplier(db, evalRecord.supplier_id, '资格复核未通过',
            `项目"${announcement ? announcement.title : ''}"资格复核未通过`,
            'warning', reviewId, 'qualification_review');
        notifySupervisor(db, '资格复核结果',
            `项目"${announcement ? announcement.title : ''}"候选人"${evalRecord.supplier_name}"资格复核未通过，审核人：${reviewedBy}`,
            'warning', reviewId, 'qualification_review');
    }

    return {
        success: true,
        data: {
            review_id: reviewId,
            supplier_id: evalRecord.supplier_id,
            supplier_name: evalRecord.supplier_name,
            review_status: status,
            reviewed_by: reviewedBy
        }
    };
}

module.exports = { evaluateBids, getEvaluationResults, getEvaluationRule, getEvaluationHistory, reviewQualification };
