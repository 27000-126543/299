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
    console.log('  端到端验证：异议处理+审计留痕+顺延');
    console.log('========================================\n');

    console.log('=== 1. 提交采购需求 + 审核通过 + 发布公告 ===');
    const req1 = await post('/api/procurement/requests', {
        title: '办公设备采购项目', category: '货物类', budget: 800000, quantity: 200,
        description: '采购办公电脑及打印设备', specs: 'CPU i7/16G/512G SSD',
        delivery_date: '2026-10-01', delivery_address: 'XX市政府采购中心',
        purchaser_id: 'P001', purchaser_name: 'XX市财政局', dept_name: '政府采购处'
    });
    const reqId = req1.data.id;
    await put('/api/procurement/requests/' + reqId + '/review', { action: 'approve' });
    const ann = await post('/api/announcement/announcements', { request_id: reqId });
    const annId = ann.data.id;

    const suppliers = (await get('/api/supplier')).data;
    const huaxin = suppliers.find(s => s.name.includes('华信'));
    const hengtong = suppliers.find(s => s.name.includes('恒通'));

    console.log('\n=== 2. 两家供应商报名+缴保证金+提交投标 ===');
    const reg1 = await post('/api/registration/registrations', { announcement_id: annId, supplier_id: huaxin.id });
    await put('/api/registration/registrations/' + reg1.data.registration_id + '/deposit', {});
    const reg2 = await post('/api/registration/registrations', { announcement_id: annId, supplier_id: hengtong.id });
    await put('/api/registration/registrations/' + reg2.data.registration_id + '/deposit', {});

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

    console.log('\n=== 3. 开标 + 评标 ===');
    await post('/api/bid-opening/bid-openings', { announcement_id: annId });
    const eval1 = await post('/api/evaluation/evaluations', { announcement_id: annId });
    assert(eval1.success, '首次评标成功');

    const huaxinCandidate = eval1.data.candidates.find(c => c.supplier_name.includes('华信'));
    const hengtongCandidate = eval1.data.candidates.find(c => c.supplier_name.includes('恒通'));
    const huaxinReviewId = huaxinCandidate.qualification_review_id;
    const hengtongReviewId = hengtongCandidate.qualification_review_id;

    console.log(`  华信: 排名${huaxinCandidate.ranking} 总分${huaxinCandidate.total_score} 复核ID=${huaxinReviewId}`);
    console.log(`  恒通: 排名${hengtongCandidate.ranking} 总分${hengtongCandidate.total_score} 复核ID=${hengtongReviewId}`);

    console.log('\n=== 4. 重复评标验证复核工单不丢不重 ===');
    const eval2 = await post('/api/evaluation/evaluations', { announcement_id: annId });
    assert(eval2.success, '重复评标成功');
    const huaxinReviewId2 = eval2.data.candidates.find(c => c.supplier_name.includes('华信')).qualification_review_id;
    const hengtongReviewId2 = eval2.data.candidates.find(c => c.supplier_name.includes('恒通')).qualification_review_id;
    assert(huaxinReviewId === huaxinReviewId2, '华信复核ID不变');
    assert(hengtongReviewId === hengtongReviewId2, '恒通复核ID不变');

    const notifsAfterReEval = await get('/api/notification?recipient_type=supervisor');
    const qualNotifs = notifsAfterReEval.data.filter(n => n.title === '资格复核工单');
    assert(qualNotifs.length === 2, `复核工单通知2条(不丢不重), 实际=${qualNotifs.length}`);

    console.log('\n=== 5. 华信复核不通过 ===');
    const reviewFail = await put('/api/evaluation/qualification-review/' + huaxinReviewId, {
        status: 'failed', reviewed_by: 'supervisor01'
    });
    assert(reviewFail.success, '华信复核不通过');
    assert(reviewFail.data.review_status === 'failed', '状态=failed');

    console.log('\n=== 6. 华信提交异议（对复核结论不满）===');
    const objection = await post('/api/objection', {
        announcement_id: annId,
        supplier_id: huaxin.id,
        objection_type: 'qualification_review',
        objection_content: '我方认为资格复核结论有误，我司资质完全符合项目要求'
    });
    assert(objection.success, '异议提交成功');
    const objectionId = objection.data.objection_id;

    console.log('\n=== 7. 异议未处理时审批中标 → 应被拦截 ===');
    const winBlocked = await post('/api/winning/approve', { announcement_id: annId, approved_by: 'admin001' });
    assert(!winBlocked.success, '中标审批被拦截');
    assert(winBlocked.message.includes('异议'), '拦截原因是异议');
    console.log(`  拦截信息: ${winBlocked.message}`);

    console.log('\n=== 8. 处理异议：维持不通过 ===');
    const handleObj = await put('/api/objection/' + objectionId + '/handle', {
        handler_id: 'purchaser01',
        handler_name: '采购人代表',
        handling_opinion: '经复核，供应商资质确不符合项目要求，维持原结论',
        conclusion: 'overruled'
    });
    assert(handleObj.success, '异议处理成功');
    assert(handleObj.data.status === 'overruled', '结论=异议不成立');

    console.log('\n=== 9. 恒通复核通过 ===');
    const reviewPass = await put('/api/evaluation/qualification-review/' + hengtongReviewId, {
        status: 'passed', reviewed_by: 'supervisor01'
    });
    assert(reviewPass.success, '恒通复核通过');

    console.log('\n=== 10. 再次审批中标 → 应成功，顺延到恒通 ===');
    const win = await post('/api/winning/approve', { announcement_id: annId, approved_by: 'admin001' });
    assert(win.success, '中标审批成功');
    assert(win.data.is_fallback === true, '标记为顺延');
    assert(win.data.winner.supplier_name.includes('恒通'), '中标供应商=恒通');
    assert(win.data.win_amount === 468000, '中标金额=468000');
    assert(win.data.win_amount === win.data.contract_draft.amount, '合同金额=中标金额');
    assert(win.data.win_amount === win.data.result_announcement.win_amount, '公告金额=中标金额');

    console.log('\n=== 11. 再次重复评标验证failed不回退pending ===');
    const eval3 = await post('/api/evaluation/evaluations', { announcement_id: annId });
    assert(eval3.success, '第三次评标成功(已中标状态下)');
    const huaxinAfter = eval3.data.candidates.find(c => c.supplier_name.includes('华信'));
    assert(huaxinAfter.qualification_review_status === 'failed', `华信复核状态仍为failed(不回退), 实际=${huaxinAfter.qualification_review_status}`);
    const hengtongAfter = eval3.data.candidates.find(c => c.supplier_name.includes('恒通'));
    assert(hengtongAfter.qualification_review_status === 'passed', `恒通复核状态仍为passed, 实际=${hengtongAfter.qualification_review_status}`);

    console.log('\n=== 12. 查询中标结果和合同列表 ===');
    const winResults = await get('/api/winning');
    const thisResult = winResults.data.find(r => r.announcement_id === annId);
    assert(thisResult && thisResult.supplier_name.includes('恒通'), '中标结果: 供应商=恒通');
    assert(thisResult && thisResult.win_amount === 468000, '中标结果: 金额=468000');

    const contracts = await get('/api/contract/contracts');
    const thisContract = contracts.data.find(c => c.announcement_id === annId);
    assert(thisContract && thisContract.supplier_name.includes('恒通'), '合同: 供应商=恒通');
    assert(thisContract && thisContract.amount === 468000, '合同: 金额=468000');

    console.log('\n=== 13. 查询异议列表 ===');
    const objections = await get('/api/objection?announcement_id=' + annId);
    assert(objections.data.length === 1, '异议1条');
    assert(objections.data[0].status === 'overruled', '异议状态=overruled');
    assert(objections.data[0].conclusion === 'overruled', '结论=异议不成立');

    console.log('\n=== 14. 查询审计时间线 ===');
    const timeline = await get('/api/objection/audit/' + annId);
    console.log(`  审计记录数: ${timeline.data.length}`);
    timeline.data.forEach(t => {
        console.log(`  [${t.action_type}] ${t.detail} (${t.created_at})`);
    });

    const actionTypes = timeline.data.map(t => t.action_type);
    assert(actionTypes.includes('evaluation'), '审计包含evaluation(评标)');
    assert(actionTypes.includes('re_evaluation'), '审计包含re_evaluation(重评)');
    assert(actionTypes.includes('qualification_review'), '审计包含qualification_review(资格复核)');
    assert(actionTypes.includes('objection_submit'), '审计包含objection_submit(异议提交)');
    assert(actionTypes.includes('winning_approval_blocked'), '审计包含winning_approval_blocked(审批拦截)');
    assert(actionTypes.includes('objection_handle'), '审计包含objection_handle(异议处理)');
    assert(actionTypes.includes('winning_approval'), '审计包含winning_approval(中标审批)');

    const blockedLog = timeline.data.find(t => t.action_type === 'winning_approval_blocked');
    assert(blockedLog && blockedLog.detail.includes('异议'), '审批拦截日志包含异议信息');

    const approvalLog = timeline.data.find(t => t.action_type === 'winning_approval');
    assert(approvalLog && approvalLog.detail.includes('恒通'), '中标审批日志包含恒通');
    assert(approvalLog && approvalLog.after_status === 'awarded', '审批后状态=awarded');

    console.log('\n========================================');
    if (errors === 0) {
        console.log('  ✅ 全部测试通过！');
    } else {
        console.log(`  ❌ ${errors} 项测试失败`);
    }
    console.log('========================================');
}

test().catch(e => console.error('Error:', e.message));
