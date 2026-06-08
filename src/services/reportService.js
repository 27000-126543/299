const { queryAll, queryOne, queryRun, generateId } = require('../database/helpers');
const dayjs = require('dayjs');

function generateDailyReport(db, reportDate) {
    const date = reportDate || dayjs().format('YYYY-MM-DD');

    const totalProjects = queryOne(db,
        `SELECT COUNT(*) as count FROM procurement_requests WHERE date(created_at) = ?`,
        [date]
    );

    const amountResult = queryOne(db,
        `SELECT COALESCE(SUM(budget), 0) as total_budget FROM procurement_requests WHERE date(created_at) = ?`,
        [date]
    );

    const contractAmountResult = queryOne(db,
        `SELECT COALESCE(SUM(c.amount), 0) as total_amount FROM contracts c WHERE date(c.signing_date) = ?`,
        [date]
    );

    const budgetAmount = amountResult ? amountResult.total_budget : 0;
    const contractAmount = contractAmountResult ? contractAmountResult.total_amount : 0;
    const savingRate = budgetAmount > 0
        ? Math.round((1 - contractAmount / budgetAmount) * 10000) / 100
        : 0;

    const totalBidResult = queryOne(db,
        `SELECT COUNT(*) as count FROM bidding_announcements WHERE date(updated_at) = ? AND status IN ('evaluated','awarded','failed_bid')`,
        [date]
    );
    const failedBidResult = queryOne(db,
        `SELECT COUNT(*) as count FROM bidding_announcements WHERE date(updated_at) = ? AND status = 'failed_bid'`,
        [date]
    );

    const totalBidCount = totalBidResult ? totalBidResult.count : 0;
    const failedBidCount = failedBidResult ? failedBidResult.count : 0;
    const failedBidRate = totalBidCount > 0
        ? Math.round(failedBidCount / totalBidCount * 10000) / 100
        : 0;

    const completedCount = queryOne(db,
        `SELECT COUNT(*) as count FROM contracts WHERE date(acceptance_date) = ?`,
        [date]
    );
    const breachCount = queryOne(db,
        `SELECT COUNT(*) as count FROM breach_orders WHERE date(created_at) = ?`,
        [date]
    );

    const byCategory = queryAll(db,
        `SELECT category, COUNT(*) as count, COALESCE(SUM(budget), 0) as total_budget
         FROM procurement_requests WHERE date(created_at) = ? GROUP BY category`,
        [date]
    );

    const byMethod = queryAll(db,
        `SELECT procurement_method as method, COUNT(*) as count, COALESCE(SUM(budget), 0) as total_budget
         FROM bidding_announcements WHERE date(created_at) = ? GROUP BY procurement_method`,
        [date]
    );

    const reportId = generateId('RPT');
    const details = JSON.stringify({ byCategory, byMethod });

    const existing = queryOne(db, 'SELECT * FROM daily_reports WHERE report_date = ?', [date]);
    if (existing) {
        queryRun(db,
            `UPDATE daily_reports SET total_projects = ?, total_amount = ?, budget_amount = ?, saving_rate = ?,
             failed_bid_count = ?, total_bid_count = ?, failed_bid_rate = ?, completed_count = ?,
             breach_count = ?, details = ? WHERE report_date = ?`,
            [totalProjects ? totalProjects.count : 0, contractAmount, budgetAmount, savingRate,
             failedBidCount, totalBidCount, failedBidRate,
             completedCount ? completedCount.count : 0,
             breachCount ? breachCount.count : 0,
             details, date]
        );
        return {
            id: existing.id,
            report_date: date,
            total_projects: totalProjects ? totalProjects.count : 0,
            total_amount: contractAmount,
            budget_amount: budgetAmount,
            saving_rate: savingRate,
            failed_bid_count: failedBidCount,
            total_bid_count: totalBidCount,
            failed_bid_rate: failedBidRate,
            completed_count: completedCount ? completedCount.count : 0,
            breach_count: breachCount ? breachCount.count : 0,
            by_category: byCategory,
            by_method: byMethod
        };
    }

    queryRun(db,
        `INSERT INTO daily_reports
         (id, report_date, total_projects, total_amount, budget_amount, saving_rate,
          failed_bid_count, total_bid_count, failed_bid_rate, completed_count, breach_count, details)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [reportId, date,
         totalProjects ? totalProjects.count : 0, contractAmount, budgetAmount, savingRate,
         failedBidCount, totalBidCount, failedBidRate,
         completedCount ? completedCount.count : 0,
         breachCount ? breachCount.count : 0,
         details]
    );

    return {
        id: reportId,
        report_date: date,
        total_projects: totalProjects ? totalProjects.count : 0,
        total_amount: contractAmount,
        budget_amount: budgetAmount,
        saving_rate: savingRate,
        failed_bid_count: failedBidCount,
        total_bid_count: totalBidCount,
        failed_bid_rate: failedBidRate,
        completed_count: completedCount ? completedCount.count : 0,
        breach_count: breachCount ? breachCount.count : 0,
        by_category: byCategory,
        by_method: byMethod
    };
}

function getReport(db, reportDate) {
    const report = queryOne(db, 'SELECT * FROM daily_reports WHERE report_date = ?', [reportDate]);
    if (report && report.details) {
        try {
            const details = JSON.parse(report.details);
            report.by_category = details.byCategory || [];
            report.by_method = details.byMethod || [];
        } catch (e) { /* ignore */ }
    }
    return report;
}

function listReports(db, filters = {}) {
    let sql = 'SELECT * FROM daily_reports WHERE 1=1';
    const params = [];
    if (filters.start_date) {
        sql += ' AND report_date >= ?';
        params.push(filters.start_date);
    }
    if (filters.end_date) {
        sql += ' AND report_date <= ?';
        params.push(filters.end_date);
    }
    sql += ' ORDER BY report_date DESC';
    return queryAll(db, sql, params);
}

async function exportReportToExcel(db, filters = {}) {
    const ExcelJS = require('exceljs');
    const reports = listReports(db, filters);

    const workbook = new ExcelJS.Workbook();
    const summarySheet = workbook.addWorksheet('采购运行报告');

    summarySheet.columns = [
        { header: '报告日期', key: 'report_date', width: 14 },
        { header: '采购项目数', key: 'total_projects', width: 12 },
        { header: '预算金额(元)', key: 'budget_amount', width: 16 },
        { header: '合同金额(元)', key: 'total_amount', width: 16 },
        { header: '节约率(%)', key: 'saving_rate', width: 12 },
        { header: '流标项目数', key: 'failed_bid_count', width: 12 },
        { header: '总招标项目数', key: 'total_bid_count', width: 14 },
        { header: '流标率(%)', key: 'failed_bid_rate', width: 12 },
        { header: '完成验收数', key: 'completed_count', width: 12 },
        { header: '违约数', key: 'breach_count', width: 10 }
    ];

    summarySheet.getRow(1).font = { bold: true };
    reports.forEach(r => {
        summarySheet.addRow({
            report_date: r.report_date,
            total_projects: r.total_projects,
            budget_amount: r.budget_amount,
            total_amount: r.total_amount,
            saving_rate: r.saving_rate,
            failed_bid_count: r.failed_bid_count,
            total_bid_count: r.total_bid_count,
            failed_bid_rate: r.failed_bid_rate,
            completed_count: r.completed_count,
            breach_count: r.breach_count
        });
    });

    const categorySheet = workbook.addWorksheet('按品目分类');
    categorySheet.columns = [
        { header: '报告日期', key: 'report_date', width: 14 },
        { header: '品目', key: 'category', width: 16 },
        { header: '项目数', key: 'count', width: 10 },
        { header: '预算金额(元)', key: 'total_budget', width: 16 }
    ];
    categorySheet.getRow(1).font = { bold: true };
    reports.forEach(r => {
        if (r.details) {
            try {
                const details = JSON.parse(r.details);
                (details.byCategory || []).forEach(c => {
                    categorySheet.addRow({
                        report_date: r.report_date,
                        category: c.category,
                        count: c.count,
                        total_budget: c.total_budget
                    });
                });
            } catch (e) { /* ignore */ }
        }
    });

    const buffer = await workbook.xlsx.writeBuffer();
    return buffer;
}

module.exports = { generateDailyReport, getReport, listReports, exportReportToExcel };
