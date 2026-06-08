const { queryAll, queryOne, queryRun, generateId } = require('../database/helpers');
const { notifySupplier, notifySupervisor, notifyPurchaser } = require('./notificationService');

const REQUIRED_BID_FILES = ['投标函', '技术方案', '报价单', '资格证明文件'];
const CRITICAL_BID_FILES = ['投标函', '报价单'];

function checkBidIntegrity(submittedFiles) {
    const existingFiles = Array.isArray(submittedFiles) ? submittedFiles : [];
    const missing = REQUIRED_BID_FILES.filter(rf =>
        !existingFiles.some(f => f && f.includes(rf))
    );
    const missingCritical = CRITICAL_BID_FILES.filter(rf =>
        !existingFiles.some(f => f && f.includes(rf))
    );

    if (missingCritical.length > 0) {
        return {
            isComplete: false,
            isValid: false,
            missingFiles: missing,
            invalidReason: `缺少关键文件：${missing.join('、')}`
        };
    }

    return {
        isComplete: missing.length === 0,
        isValid: true,
        missingFiles: missing,
        invalidReason: missing.length > 0 ? `缺少非关键文件：${missing.join('、')}` : ''
    };
}

function openBids(db, announcementId) {
    const announcement = queryOne(db, 'SELECT * FROM bidding_announcements WHERE id = ?', [announcementId]);
    if (!announcement) {
        return { success: false, message: '招标公告不存在' };
    }

    const existingOpening = queryOne(db, 'SELECT * FROM bid_openings WHERE announcement_id = ?', [announcementId]);
    if (existingOpening && existingOpening.status === 'completed') {
        return { success: false, message: '该项目已完成开标' };
    }

    const registrations = queryAll(db,
        "SELECT * FROM supplier_registrations WHERE announcement_id = ? AND check_result = 'passed' AND deposit_status = 'paid'",
        [announcementId]
    );

    if (registrations.length === 0) {
        return { success: false, message: '没有符合条件的投标供应商' };
    }

    const openingId = generateId('BOP');
    queryRun(db,
        `INSERT INTO bid_openings (id, announcement_id, status, opened_at, total_bids) VALUES (?, ?, 'in_progress', datetime('now','localtime'), ?)`,
        [openingId, announcementId, registrations.length]
    );

    let validCount = 0;
    let invalidCount = 0;
    const results = [];

    registrations.forEach(reg => {
        const bidDocs = queryAll(db,
            'SELECT * FROM bid_documents WHERE registration_id = ? AND announcement_id = ?',
            [reg.id, announcementId]
        );

        if (bidDocs.length === 0) {
            const allMissing = [...REQUIRED_BID_FILES];
            const docId = generateId('BID');
            queryRun(db,
                `INSERT INTO bid_documents
                 (id, registration_id, supplier_id, announcement_id, file_name, file_hash,
                  is_decrypted, integrity_check, missing_files, is_valid, invalid_reason)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [docId, reg.id, reg.supplier_id, announcementId,
                 '', '',
                 0, 'failed',
                 allMissing.join(','),
                 0, `缺少关键文件：${allMissing.join('、')}`]
            );

            invalidCount++;
            results.push({
                supplier_id: reg.supplier_id,
                supplier_name: reg.supplier_name,
                is_valid: false,
                missing_files: allMissing,
                invalid_reason: `缺少关键文件：${allMissing.join('、')}`
            });
        } else {
            bidDocs.forEach(doc => {
                queryRun(db,
                    'UPDATE bid_documents SET is_decrypted = 1 WHERE id = ?',
                    [doc.id]
                );

                const submittedFiles = doc.file_name ? doc.file_name.split(',').map(f => f.trim()).filter(f => f) : [];
                const integrity = checkBidIntegrity(submittedFiles);

                queryRun(db,
                    `UPDATE bid_documents SET integrity_check = ?, missing_files = ?, is_valid = ?, invalid_reason = ? WHERE id = ?`,
                    [integrity.isComplete ? 'passed' : 'failed',
                     integrity.missingFiles.join(','),
                     integrity.isValid ? 1 : 0,
                     integrity.invalidReason,
                     doc.id]
                );

                if (integrity.isValid) {
                    validCount++;
                } else {
                    invalidCount++;
                }

                results.push({
                    supplier_id: doc.supplier_id,
                    is_valid: integrity.isValid,
                    missing_files: integrity.missingFiles,
                    invalid_reason: integrity.invalidReason
                });
            });
        }
    });

    queryRun(db,
        `UPDATE bid_openings SET status = 'completed', valid_bids = ?, invalid_bids = ? WHERE id = ?`,
        [validCount, invalidCount, openingId]
    );

    queryRun(db,
        `UPDATE bidding_announcements SET status = 'bid_opened', updated_at = datetime('now','localtime') WHERE id = ?`,
        [announcementId]
    );

    results.forEach(r => {
        if (r.is_valid) {
            notifySupplier(db, r.supplier_id, '开标完成-投标有效',
                `项目"${announcement.title}"开标完成，您的投标文件通过完整性检查`,
                'success', announcementId, 'bid_opening');
        } else {
            notifySupplier(db, r.supplier_id, '开标完成-投标无效',
                `项目"${announcement.title}"开标完成，您的投标被标记无效，原因：${r.invalid_reason}`,
                'warning', announcementId, 'bid_opening');
        }
    });

    notifyPurchaser(db, announcement.request_id, '开标完成',
        `项目"${announcement.title}"开标完成，有效投标${validCount}个，无效投标${invalidCount}个`,
        'info');
    notifySupervisor(db, '开标完成',
        `项目"${announcement.title}"开标完成，有效投标${validCount}个，无效投标${invalidCount}个`,
        'info', openingId, 'bid_opening');

    return {
        success: true,
        data: {
            opening_id: openingId,
            total_bids: registrations.length,
            valid_bids: validCount,
            invalid_bids: invalidCount,
            results
        }
    };
}

function submitBidDocument(db, data) {
    const reg = queryOne(db,
        'SELECT * FROM supplier_registrations WHERE announcement_id = ? AND supplier_id = ? AND check_result = ? AND deposit_status = ?',
        [data.announcement_id, data.supplier_id, 'passed', 'paid']
    );
    if (!reg) {
        return { success: false, message: '未找到有效的报名记录或保证金未缴纳' };
    }

    const existing = queryOne(db,
        'SELECT * FROM bid_documents WHERE registration_id = ? AND announcement_id = ?',
        [reg.id, data.announcement_id]
    );
    if (existing) {
        return { success: false, message: '该供应商已提交投标文件' };
    }

    const id = generateId('BID');
    const fileNames = data.file_name || '';
    const bidPrice = data.bid_price || 0;
    const technicalScore = data.technical_score || 0;
    const businessScore = data.business_score || 0;

    queryRun(db,
        `INSERT INTO bid_documents
         (id, registration_id, supplier_id, announcement_id, file_name, file_hash)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, reg.id, data.supplier_id, data.announcement_id, fileNames, generateId('HASH')]
    );

    if (bidPrice > 0) {
        queryRun(db, 'UPDATE bid_documents SET bid_price = ? WHERE id = ?', [bidPrice, id]);
    }
    if (technicalScore > 0) {
        queryRun(db, 'UPDATE bid_documents SET technical_score = ? WHERE id = ?', [technicalScore, id]);
    }
    if (businessScore > 0) {
        queryRun(db, 'UPDATE bid_documents SET business_score = ? WHERE id = ?', [businessScore, id]);
    }

    return {
        success: true,
        data: {
            id,
            registration_id: reg.id,
            file_name: fileNames,
            bid_price: bidPrice,
            technical_score: technicalScore,
            business_score: businessScore
        }
    };
}

function getBidOpeningResult(db, announcementId) {
    return queryOne(db, 'SELECT * FROM bid_openings WHERE announcement_id = ?', [announcementId]);
}

module.exports = { openBids, submitBidDocument, getBidOpeningResult, checkBidIntegrity };
