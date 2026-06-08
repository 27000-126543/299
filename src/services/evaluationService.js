const { queryAll, queryOne, queryRun, generateId } = require('../database/helpers');
const { notifySupplier, notifySupervisor, notifyPurchaser } = require('./notificationService');

function getEvaluationRule(db, category, method) {
    let rule = queryOne(db,
        'SELECT * FROM evaluation_rules WHERE category = ? AND procurement_method = ? AND is_active = 1',
        [category, method]
    );
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

function calculatePriceScore(prices, supplierPrice, method) {
    if (prices.length === 0) return 0;

    let benchmarkPrice;
    if (method === '公开招标') {
        prices.sort((a, b) => a - b);
        if (prices.length >= 5) {
            const trimmed = prices.slice(1, -1);
            benchmarkPrice = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
        } else {
            benchmarkPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
        }
    } else {
        benchmarkPrice = Math.min(...prices);
    }

    if (supplierPrice <= benchmarkPrice) {
        return 100;
    }
    const deviation = (supplierPrice - benchmarkPrice) / benchmarkPrice;
    return Math.max(0, Math.round((100 - deviation * 100) * 100) / 100);
}

function evaluateBids(db, announcementId) {
    const announcement = queryOne(db, 'SELECT * FROM bidding_announcements WHERE id = ?', [announcementId]);
    if (!announcement) {
        return { success: false, message: '招标公告不存在' };
    }

    if (announcement.status !== 'bid_opened') {
        return { success: false, message: '项目尚未完成开标' };
    }

    const validBids = queryAll(db,
        'SELECT * FROM bid_documents WHERE announcement_id = ? AND is_valid = 1',
        [announcementId]
    );

    if (validBids.length === 0) {
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
        return { success: false, message: '无有效投标，流标处理' };
    }

    const rule = getEvaluationRule(db, announcement.category, announcement.procurement_method);

    const existingEvals = queryAll(db,
        'SELECT * FROM evaluations WHERE announcement_id = ?',
        [announcementId]
    );
    if (existingEvals.length > 0) {
        queryRun(db, 'DELETE FROM evaluations WHERE announcement_id = ?', [announcementId]);
    }

    const bidPrices = validBids.map(bd => {
        const reg = queryOne(db, 'SELECT * FROM supplier_registrations WHERE id = ?', [bd.registration_id]);
        return reg ? (reg.deposit_amount || 0) : 0;
    });

    const evaluationResults = [];

    validBids.forEach(bid => {
        const supplier = queryOne(db, 'SELECT * FROM suppliers WHERE id = ?', [bid.supplier_id]);
        const reg = queryOne(db, 'SELECT * FROM supplier_registrations WHERE id = ?', [bid.registration_id]);

        const technicalScore = Math.round((60 + Math.random() * 35) * 100) / 100;
        const businessScore = Math.round((60 + Math.random() * 35) * 100) / 100;
        const bidPrice = reg ? (announcement.budget * (0.7 + Math.random() * 0.25)) : 0;
        const priceScore = calculatePriceScore(
            validBids.map(() => announcement.budget * (0.7 + Math.random() * 0.25)),
            bidPrice,
            announcement.procurement_method
        );

        const totalScore = Math.round(
            (technicalScore * rule.technical_weight +
             businessScore * rule.business_weight +
             priceScore * rule.price_weight) / 100 * 100
        ) / 100;

        const evalId = generateId('EVAL');
        queryRun(db,
            `INSERT INTO evaluations
             (id, announcement_id, supplier_id, supplier_name, technical_score, business_score, price_score, total_score)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [evalId, announcementId, bid.supplier_id,
             supplier ? supplier.name : '', technicalScore, businessScore, priceScore, totalScore]
        );

        evaluationResults.push({
            eval_id: evalId,
            supplier_id: bid.supplier_id,
            supplier_name: supplier ? supplier.name : '',
            technical_score: technicalScore,
            business_score: businessScore,
            price_score: priceScore,
            total_score: totalScore
        });
    });

    evaluationResults.sort((a, b) => b.total_score - a.total_score);

    evaluationResults.forEach((result, index) => {
        const ranking = index + 1;
        const isCandidate = ranking <= 3;
        queryRun(db,
            'UPDATE evaluations SET ranking = ?, is_candidate = ? WHERE id = ?',
            [ranking, isCandidate ? 1 : 0, result.eval_id]
        );
        result.ranking = ranking;
        result.is_candidate = isCandidate;
    });

    const topCandidates = evaluationResults.slice(0, 2);
    topCandidates.forEach(candidate => {
        const reviewId = generateId('QRV');
        queryRun(db,
            'UPDATE evaluations SET qualification_review_status = ?, qualification_review_id = ? WHERE id = ?',
            ['pending', reviewId, candidate.eval_id]
        );
        candidate.qualification_review_status = 'pending';
        candidate.qualification_review_id = reviewId;

        notifySupervisor(db, '资格复核工单',
            `项目"${announcement.title}"第${candidate.ranking}名候选人"${candidate.supplier_name}"需进行资格复核`,
            'warning', reviewId, 'qualification_review');
    });

    queryRun(db,
        `UPDATE bidding_announcements SET status = 'evaluated', updated_at = datetime('now','localtime') WHERE id = ?`,
        [announcementId]
    );

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

    return {
        success: true,
        data: {
            announcement_id: announcementId,
            evaluation_rule: rule,
            candidates: evaluationResults
        }
    };
}

function getEvaluationResults(db, announcementId) {
    return queryAll(db,
        'SELECT * FROM evaluations WHERE announcement_id = ? ORDER BY ranking',
        [announcementId]
    );
}

module.exports = { evaluateBids, getEvaluationResults, getEvaluationRule };
