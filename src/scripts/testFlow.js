const http = require('http');

function request(method, path, data) {
    return new Promise((resolve, reject) => {
        const body = data ? JSON.stringify(data) : '';
        const req = http.request({
            hostname: 'localhost', port: 3800, path, method,
            headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) }
        }, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(d); } });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

const post = (p, d) => request('POST', p, d);
const put = (p, d) => request('PUT', p, d);
const get = (p) => request('GET', p);

let errors = 0;
function assert(condition, msg) {
    if (!condition) { console.error('  ❌ FAIL:', msg); errors++; }
    else { console.log('  ✅ PASS:', msg); }
}

async function test() {
    console.log('========================================');
    console.log('  端到端验证：复核工单+顺延+报价风险');
    console.log('========================================\n');

    console.log('=== 1. 提交采购需求（货物类，预算80万）===');
    const req1 = await post('/api/procurement/requests', {
        title: '办公设备采购项目', category: '货物类', budget: 800000, quantity: 200,
        description: '采购办公电脑及打印设备', specs: 'CPU i7/16G/512G SSD+激光打印机',
        delivery_date: '2026-10-01', delivery_address: 'XX市政府采购中心',
        purchaser_id: 'P001', purchaser_name: 'XX市财政局', dept_name: '政府采购处'
    });
    const reqId = req1.data.id;

    console.log('\n=== 2. 审核通过 + 发布公告 ===');
    await put('/api/procurement/requests/' + reqId + '/review', { action: 'approve' });
    const ann = await post('/api/announcement/announcements', { request_id: reqId });
    const annId = ann.data.id;
    console.log('公告ID:', annId);

    const suppliers = (await get('/api/supplier')).data;
    const huaxin = suppliers.find(s => s.name.includes('华信'));
    const hengtong = suppliers.find(s => s.name.includes('恒通'));

    console.log('\n=== 3. 两个供应商报名 + 缴保证金 ===');
    const reg1 = await post('/api/registration/registrations', { announcement_id: annId, supplier_id: huaxin.id });
    assert(reg1.success, '华信报名通过');
    await put('/api/registration/registrations/' + reg1.data.registration_id + '/deposit', {});

    const reg2 = await post('/api/registration/registrations', { announcement_id: annId, supplier_id: hengtong.id });
    assert(reg2.success, '恒通报名通过');
    await put('/api/registration/registrations/' + reg2.data.registration_id + '/deposit', {});

    console.log('\n=== 4. 两个供应商提交完整投标文件（华信报435000，恒通报468000）===');
    await post('/api/bid-opening/bid-documents', {
        announcement_id: annId, supplier_id: huaxin.id,
        file_name: '投标函,技术方案,报价单,资格证明文件',
        bid_price: 435000, technical_score: 85, business_score: 78
    });
    await post('/api/bid-opening/bid-documents', {
        announcement_id: annId, supplier_id: hengtong.id,
        file_name: '投标函,技术方案,报价单,资格证明文件',
        bid_price: 468000, technical_score: 72, business_score: 82
    });

    console.log('\n=== 5. 开标 ===');
    const opening = await post('/api/bid-opening/bid-openings', { announcement_id: annId });
    assert(opening.data.valid_bids === 2, '两家有效投标');

    console.log('\n=== 6. 第一次评标 ===');
    const eval1 = await post('/api/evaluation/evaluations', { announcement_id: annId });
    assert(eval1.success, '第一次评标成功');
    assert(eval1.data.is_re_evaluation === false, '标记为首次评标');
    assert(eval1.data.round === 1, '轮次=1');

    console.log('\n评分明细:');
    eval1.data.candidates.forEach(c => {
        console.log(`  排名${c.ranking}: ${c.supplier_name} 报价=${c.bid_price} ` +
            `技术=${c.technical_score}×${c.score_breakdown.technical.weight}%=${c.score_breakdown.technical.weighted} ` +
            `商务=${c.business_score}×${c.score_breakdown.business.weight}%=${c.score_breakdown.business.weighted} ` +
            `价格=${c.price_score}×${c.score_breakdown.price.weight}%=${c.score_breakdown.price.weighted} ` +
            `总分=${c.total_score} 复核ID=${c.qualification_review_id} 复核状态=${c.qualification_review_status}`);
    });

    assert(eval1.data.candidates[0].score_breakdown, '返回了评分明细(score_breakdown)');
    assert(eval1.data.score_detail.formula, '返回了计算公式');

    const huaxinReviewId = eval1.data.candidates.find(c => c.supplier_name.includes('华信')).qualification_review_id;
    const hengtongReviewId = eval1.data.candidates.find(c => c.supplier_name.includes('恒通')).qualification_review_id;
    console.log(`  华信复核ID: ${huaxinReviewId}`);
    console.log(`  恒通复核ID: ${hengtongReviewId}`);

    console.log('\n=== 7. 检查首次评标后的监管通知 ===');
    let notifs1 = await get('/api/notification?recipient_type=supervisor');
    const qualReviewNotifs1 = notifs1.data.filter(n => n.title === '资格复核工单');
    console.log(`  资格复核通知数: ${qualReviewNotifs1.length}`);
    assert(qualReviewNotifs1.length === 2, '首次评标生成2条资格复核通知');

    console.log('\n=== 8. 第二次评标（验证复核工单不丢不重）===');
    const eval2 = await post('/api/evaluation/evaluations', { announcement_id: annId });
    assert(eval2.success, '第二次评标成功');
    assert(eval2.data.is_re_evaluation === true, '标记为重复评标');
    assert(eval2.data.round === 2, '轮次=2');

    const huaxinReviewId2 = eval2.data.candidates.find(c => c.supplier_name.includes('华信')).qualification_review_id;
    const hengtongReviewId2 = eval2.data.candidates.find(c => c.supplier_name.includes('恒通')).qualification_review_id;
    console.log(`  华信复核ID(第二次): ${huaxinReviewId2}`);
    console.log(`  恒通复核ID(第二次): ${hengtongReviewId2}`);

    assert(huaxinReviewId === huaxinReviewId2, '华信复核ID保持不变');
    assert(hengtongReviewId === hengtongReviewId2, '恒通复核ID保持不变');

    notifs1 = await get('/api/notification?recipient_type=supervisor');
    const qualReviewNotifs2 = notifs1.data.filter(n => n.title === '资格复核工单');
    console.log(`  资格复核通知数(二次评标后): ${qualReviewNotifs2.length}`);
    assert(qualReviewNotifs2.length === 2, '复核通知仍然是2条（不增不减）');

    console.log('\n=== 9. 查询评标历史 ===');
    const history = await get('/api/evaluation/history/' + annId);
    assert(history.data.length === 2, '评标历史2条记录');
    assert(history.data[0].round === 1, '第1轮');
    assert(history.data[1].round === 2, '第2轮');
    assert(history.data[1].is_re_evaluation === 1, '第2轮标记为重评');

    console.log('\n=== 10. 监管端复核：华信不通过，恒通通过 ===');
    const reviewFail = await put('/api/evaluation/qualification-review/' + huaxinReviewId, {
        status: 'failed', reviewed_by: 'supervisor01'
    });
    assert(reviewFail.success, '华信复核不通过');
    assert(reviewFail.data.review_status === 'failed', '状态=failed');

    const reviewPass = await put('/api/evaluation/qualification-review/' + hengtongReviewId, {
        status: 'passed', reviewed_by: 'supervisor01'
    });
    assert(reviewPass.success, '恒通复核通过');
    assert(reviewPass.data.review_status === 'passed', '状态=passed');

    console.log('\n=== 11. 中标审批（应顺延到恒通）===');
    const win = await post('/api/winning/approve', { announcement_id: annId, approved_by: 'admin001' });
    assert(win.success, '中标审批成功');

    console.log(`  中标供应商: ${win.data.winner.supplier_name}`);
    console.log(`  中标金额: ${win.data.win_amount}`);
    console.log(`  是否顺延: ${win.data.is_fallback}`);
    console.log(`  顺延原因: ${win.data.fallback_reason}`);

    assert(win.data.is_fallback === true, '中标为顺延');
    assert(win.data.winner.supplier_name.includes('恒通'), '中标供应商是恒通（顺延）');
    assert(win.data.win_amount === 468000, '中标金额=恒通报价468000');
    assert(win.data.fallback_reason !== null, '有顺延原因');

    console.log('\n=== 12. 验证中标结果一致性 ===');
    const winAmount = win.data.win_amount;
    const contractAmount = win.data.contract_draft.amount;
    const announcementAmount = win.data.result_announcement.win_amount;

    assert(winAmount === contractAmount, `合同金额一致: ${winAmount}=${contractAmount}`);
    assert(winAmount === announcementAmount, `公告金额一致: ${winAmount}=${announcementAmount}`);
    assert(win.data.result_announcement.is_fallback === true, '公告标记为顺延');
    assert(win.data.result_announcement.failed_candidates.length > 0, '公告包含未通过候选人');

    console.log('\n=== 13. 查询中标结果列表 ===');
    const winResults = await get('/api/winning');
    const thisResult = winResults.data.find(r => r.announcement_id === annId);
    assert(thisResult && thisResult.supplier_name.includes('恒通'), '中标结果列表: 供应商=恒通');
    assert(thisResult && thisResult.win_amount === 468000, '中标结果列表: 金额=468000');

    console.log('\n=== 14. 查询合同列表 ===');
    const contracts = await get('/api/contract/contracts');
    const thisContract = contracts.data.find(c => c.announcement_id === annId);
    assert(thisContract && thisContract.supplier_name.includes('恒通'), '合同: 供应商=恒通');
    assert(thisContract && thisContract.amount === 468000, '合同: 金额=468000');

    console.log('\n=== 15. 检查监管通知完整性 ===');
    const notifs = await get('/api/notification?recipient_type=supervisor');
    const allNotifs = notifs.data;

    const qualReviewNotifs = allNotifs.filter(n => n.title === '资格复核工单');
    console.log(`  资格复核通知: ${qualReviewNotifs.length}条`);
    assert(qualReviewNotifs.length === 2, '复核工单通知2条（不丢不重）');

    const reviewResultNotifs = allNotifs.filter(n => n.title === '资格复核结果');
    console.log(`  复核结果通知: ${reviewResultNotifs.length}条`);
    assert(reviewResultNotifs.length >= 2, '复核结果通知≥2条');

    const winningNotif = allNotifs.find(n => n.title === '中标公告已发布');
    assert(winningNotif, '有中标公告通知');
    assert(winningNotif.content.includes('顺延'), '中标通知包含顺延信息');

    const contractConfirmNotif = allNotifs.filter(n => n.content.includes('恒通') && n.content.includes('468000'));
    console.log(`  包含恒通+468000的通知: ${contractConfirmNotif.length}条`);

    console.log('\n========================================');
    if (errors === 0) {
        console.log('  ✅ 全部测试通过！');
    } else {
        console.log(`  ❌ ${errors} 项测试失败`);
    }
    console.log('========================================');
}

test().catch(e => console.error('Error:', e.message));
