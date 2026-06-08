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
    console.log('  端到端验证：评标重评+报价一致性');
    console.log('========================================\n');

    console.log('=== 1. 提交采购需求（货物类）===');
    const req1 = await post('/api/procurement/requests', {
        title: '办公设备采购项目', category: '货物类', budget: 800000, quantity: 200,
        description: '采购办公电脑及打印设备', specs: 'CPU i7/16G/512G SSD+激光打印机',
        delivery_date: '2026-10-01', delivery_address: 'XX市政府采购中心',
        purchaser_id: 'P001', purchaser_name: 'XX市财政局', dept_name: '政府采购处'
    });
    const reqId = req1.data.id;
    console.log('需求ID:', reqId, '推荐方式:', req1.data.recommended_method);

    console.log('\n=== 2. 审核通过 + 发布公告 ===');
    await put('/api/procurement/requests/' + reqId + '/review', { action: 'approve' });
    const ann = await post('/api/announcement/announcements', { request_id: reqId });
    const annId = ann.data.id;
    console.log('公告ID:', annId, '预算:', ann.data.budget);

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

    console.log('\n=== 4. 两个供应商提交完整投标文件（不同报价和评分）===');
    const HUAXIN_PRICE = 435000, HUAXIN_TECH = 85, HUAXIN_BIZ = 78;
    const HENGTONG_PRICE = 468000, HENGTONG_TECH = 72, HENGTONG_BIZ = 82;

    const bid1 = await post('/api/bid-opening/bid-documents', {
        announcement_id: annId, supplier_id: huaxin.id,
        file_name: '投标函,技术方案,报价单,资格证明文件',
        bid_price: HUAXIN_PRICE, technical_score: HUAXIN_TECH, business_score: HUAXIN_BIZ
    });
    assert(bid1.success, '华信投标文件提交成功');

    const bid2 = await post('/api/bid-opening/bid-documents', {
        announcement_id: annId, supplier_id: hengtong.id,
        file_name: '投标函,技术方案,报价单,资格证明文件',
        bid_price: HENGTONG_PRICE, technical_score: HENGTONG_TECH, business_score: HENGTONG_BIZ
    });
    assert(bid2.success, '恒通投标文件提交成功');

    console.log('\n=== 5. 开标 ===');
    const opening = await post('/api/bid-opening/bid-openings', { announcement_id: annId });
    console.log('有效投标:', opening.data.valid_bids, '无效投标:', opening.data.invalid_bids);
    assert(opening.data.valid_bids === 2, '两家有效投标');
    assert(opening.data.invalid_bids === 0, '无无效投标');

    console.log('\n=== 6. 第一次评标 ===');
    const eval1 = await post('/api/evaluation/evaluations', { announcement_id: annId });
    assert(eval1.success, '第一次评标成功');
    assert(eval1.data.is_re_evaluation === false, '标记为首次评标');
    console.log('第一次评标结果:');
    const firstScores = {};
    eval1.data.candidates.forEach(c => {
        firstScores[c.supplier_name] = c.total_score;
        console.log(`  排名${c.ranking}: ${c.supplier_name} 技术=${c.technical_score} 商务=${c.business_score} 价格=${c.price_score} 报价=${c.bid_price} 总分=${c.total_score}`);
    });

    console.log('\n=== 7. 第二次评标（重复调用）===');
    const eval2 = await post('/api/evaluation/evaluations', { announcement_id: annId });
    assert(eval2.success, '第二次评标成功（不拦截）');
    assert(eval2.data.is_re_evaluation === true, '标记为重复评标');
    console.log('第二次评标结果:');
    const secondScores = {};
    eval2.data.candidates.forEach(c => {
        secondScores[c.supplier_name] = c.total_score;
        console.log(`  排名${c.ranking}: ${c.supplier_name} 技术=${c.technical_score} 商务=${c.business_score} 价格=${c.price_score} 报价=${c.bid_price} 总分=${c.total_score}`);
    });

    assert(firstScores['华信科技集团有限公司'] === secondScores['华信科技集团有限公司'],
        `华信两次评分一致: ${firstScores['华信科技集团有限公司']} vs ${secondScores['华信科技集团有限公司']}`);
    assert(firstScores['恒通设备制造有限公司'] === secondScores['恒通设备制造有限公司'],
        `恒通两次评分一致: ${firstScores['恒通设备制造有限公司']} vs ${secondScores['恒通设备制造有限公司']}`);

    const firstRanking = eval1.data.candidates.map(c => c.supplier_name).join(',');
    const secondRanking = eval2.data.candidates.map(c => c.supplier_name).join(',');
    assert(firstRanking === secondRanking, `排名顺序一致: ${firstRanking}`);

    console.log('\n=== 8. 第三次评标（再验证一次）===');
    const eval3 = await post('/api/evaluation/evaluations', { announcement_id: annId });
    assert(eval3.success, '第三次评标成功');
    assert(eval3.data.is_re_evaluation === true, '标记为重复评标');
    const thirdScores = {};
    eval3.data.candidates.forEach(c => { thirdScores[c.supplier_name] = c.total_score; });
    assert(firstScores['华信科技集团有限公司'] === thirdScores['华信科技集团有限公司'],
        '华信三次评分一致');
    assert(firstScores['恒通设备制造有限公司'] === thirdScores['恒通设备制造有限公司'],
        '恒通三次评分一致');

    console.log('\n=== 9. 中标审批 ===');
    const win = await post('/api/winning/approve', { announcement_id: annId, approved_by: 'admin001' });
    assert(win.success, '中标审批成功');

    const winnerName = win.data.winner.supplier_name;
    const winAmount = win.data.win_amount;
    const contractAmount = win.data.contract_draft.amount;
    const announcementAmount = win.data.result_announcement.win_amount;
    const expectedWinAmount = firstRanking.split(',')[0] === '华信科技集团有限公司' ? HUAXIN_PRICE : HENGTONG_PRICE;

    console.log(`  中标供应商: ${winnerName}`);
    console.log(`  中标金额: ${winAmount}`);
    console.log(`  合同金额: ${contractAmount}`);
    console.log(`  公告金额: ${announcementAmount}`);
    console.log(`  期望金额(供应商报价): ${expectedWinAmount}`);

    assert(winAmount === expectedWinAmount, `中标金额=供应商报价(${expectedWinAmount})`);
    assert(winAmount === contractAmount, '中标金额=合同金额');
    assert(winAmount === announcementAmount, '中标金额=公告金额');
    assert(winAmount !== 800000, '中标金额不是项目预算800000');

    console.log('\n=== 10. 查询中标结果列表 ===');
    const winResults = await get('/api/winning');
    const thisResult = winResults.data.find(r => r.announcement_id === annId);
    assert(thisResult && thisResult.win_amount === winAmount, '中标结果列表金额一致');

    console.log('\n=== 11. 查询合同列表 ===');
    const contracts = await get('/api/contract/contracts');
    const thisContract = contracts.data.find(c => c.announcement_id === annId);
    assert(thisContract && thisContract.amount === winAmount, '合同列表金额一致');

    console.log('\n=== 12. 检查监管通知（不重复）===');
    const notifs = await get('/api/notification?recipient_type=supervisor');
    const supervisorNotifs = notifs.data;

    const qualReviewNotifs = supervisorNotifs.filter(n => n.title === '资格复核工单');
    console.log(`  资格复核通知数: ${qualReviewNotifs.length}`);
    assert(qualReviewNotifs.length <= 2, '资格复核通知不超过2条（不因重复评标累积）');

    const evalCompleteNotifs = supervisorNotifs.filter(n => n.title === '评标完成');
    console.log(`  评标完成通知数: ${evalCompleteNotifs.length}`);
    assert(evalCompleteNotifs.length === 1, '评标完成通知只有1条（重复评标不重复通知）');

    const winningNotifs = supervisorNotifs.filter(n => n.title === '中标公告已发布');
    console.log(`  中标公告通知数: ${winningNotifs.length}`);

    console.log('\n=== 13. 合同确认生效 → 检查监管通知 ===');
    await put('/api/contract/contracts/' + win.data.contract_id + '/confirm', {});
    const notifs2 = await get('/api/notification?recipient_type=supervisor');
    const contractNotif = notifs2.data.find(n => n.title === '合同已生效' && n.content.includes(winAmount.toFixed(2)));
    assert(contractNotif, `合同生效通知包含正确金额￥${winAmount.toFixed(2)}`);

    console.log('\n========================================');
    if (errors === 0) {
        console.log('  ✅ 全部测试通过！');
    } else {
        console.log(`  ❌ ${errors} 项测试失败`);
    }
    console.log('========================================');
}

test().catch(e => console.error('Error:', e.message));
