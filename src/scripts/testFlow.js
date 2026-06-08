const http = require('http');

function post(path, data) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(data);
        const req = http.request({
            hostname: 'localhost',
            port: 3800,
            path,
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) }
        }, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => resolve(JSON.parse(d)));
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

function put(path, data) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(data);
        const req = http.request({
            hostname: 'localhost',
            port: 3800,
            path,
            method: 'PUT',
            headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) }
        }, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => resolve(JSON.parse(d)));
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

function get(path) {
    return new Promise((resolve, reject) => {
        http.get('http://localhost:3800' + path, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => resolve(JSON.parse(d)));
        }).on('error', reject);
    });
}

async function test() {
    console.log('=== 1. 提交采购需求（货物类）===');
    const req1 = await post('/api/procurement/requests', {
        title: '办公电脑采购项目', category: '货物类', budget: 500000, quantity: 100,
        description: '采购办公电脑及外设设备', specs: 'CPU i7/16G/512G SSD',
        delivery_date: '2026-09-01', delivery_address: 'XX市政府采购中心',
        purchaser_id: 'P001', purchaser_name: 'XX市财政局', dept_name: '政府采购处'
    });
    console.log('推荐采购方式:', req1.data.recommended_method, '完整度:', req1.data.completeness_score);
    const reqId = req1.data.id;

    console.log('\n=== 2. 审核通过 ===');
    await put('/api/procurement/requests/' + reqId + '/review', { action: 'approve' });

    console.log('\n=== 3. 发布招标公告 ===');
    const ann = await post('/api/announcement/announcements', { request_id: reqId });
    const annId = ann.data.id;
    console.log('公告编号:', ann.data.announcement_no);

    const suppliers = (await get('/api/supplier')).data;
    const zhongjian = suppliers.find(s => s.name.includes('中建'));
    const huaxin = suppliers.find(s => s.name.includes('华信'));
    const chengxin = suppliers.find(s => s.name.includes('诚信'));

    console.log('\n=== 4. 中建工程（无货物类资质）报名 - 应被拒绝 ===');
    const reg1 = await post('/api/registration/registrations', {
        announcement_id: annId, supplier_id: zhongjian.id
    });
    console.log('结果:', reg1.success ? '通过(BUG!)' : '拒绝', reg1.reason || '');

    console.log('\n=== 5. 华信科技（有生产许可证+经营许可证）报名 - 应通过 ===');
    const reg2 = await post('/api/registration/registrations', {
        announcement_id: annId, supplier_id: huaxin.id
    });
    console.log('结果:', reg2.success ? '通过' : '拒绝', reg2.reason || '');

    if (reg2.success) {
        console.log('\n=== 6. 确认保证金 ===');
        await put('/api/registration/registrations/' + reg2.data.registration_id + '/deposit', {});

        console.log('\n=== 7. 提交投标文件（带真实报价和评分）===');
        const bid = await post('/api/bid-opening/bid-documents', {
            announcement_id: annId, supplier_id: huaxin.id,
            file_name: '投标函,技术方案,报价单,资格证明文件',
            bid_price: 435000, technical_score: 85, business_score: 78
        });
        console.log('投标文件提交:', bid.success);

        console.log('\n=== 8. 开标 ===');
        const opening = await post('/api/bid-opening/bid-openings', { announcement_id: annId });
        console.log('有效投标:', opening.data.valid_bids, '无效投标:', opening.data.invalid_bids);
        if (opening.data.results) {
            opening.data.results.forEach(r => {
                console.log('  供应商:', r.supplier_id, '有效:', r.is_valid, '缺失:', r.missing_files);
            });
        }

        console.log('\n=== 9. 评标 ===');
        const eval1 = await post('/api/evaluation/evaluations', { announcement_id: annId });
        if (eval1.success) {
            console.log('评标规则:', eval1.data.evaluation_rule);
            eval1.data.candidates.forEach(c => {
                console.log('  排名:', c.ranking, '供应商:', c.supplier_name,
                    '技术:', c.technical_score, '商务:', c.business_score,
                    '价格:', c.price_score, '总分:', c.total_score);
            });
        }

        console.log('\n=== 10. 再次评标验证稳定性 ===');
        const eval2 = await post('/api/evaluation/evaluations', { announcement_id: annId });
        if (eval2.success && eval1.success) {
            const stable = eval1.data.candidates[0].total_score === eval2.data.candidates[0].total_score;
            console.log('两次评标结果一致:', stable, '分数:', eval1.data.candidates[0].total_score, 'vs', eval2.data.candidates[0].total_score);
        }

        console.log('\n=== 11. 中标审批 ===');
        const win = await post('/api/winning/approve', { announcement_id: annId, approved_by: 'admin001' });
        if (win.success) {
            const winAmount = win.data.win_amount;
            const contractAmount = win.data.contract_draft.amount;
            const announcementAmount = win.data.result_announcement.win_amount;
            console.log('中标金额:', winAmount);
            console.log('合同金额:', contractAmount);
            console.log('公告金额:', announcementAmount);
            console.log('金额一致:', winAmount === contractAmount && winAmount === announcementAmount);

            console.log('\n=== 12. 合同确认（检查监管通知）===');
            await put('/api/contract/contracts/' + win.data.contract_id + '/confirm', {});

            console.log('\n=== 13. 验收不合格（检查违约金）===');
            const fail = await post('/api/contract/contracts/' + win.data.contract_id + '/fail-acceptance', {
                reason: '设备性能不达标'
            });
            console.log('违约金:', fail.data.penalty_amount, '计算:', fail.data.calculation_detail);

            console.log('\n=== 14. 检查监管部门通知 ===');
            const notifs = await get('/api/notification?recipient_type=supervisor');
            console.log('监管通知数量:', notifs.data.length);
            notifs.data.slice(-5).forEach(n => {
                console.log('  ', n.title, '-', n.content.substring(0, 60));
            });

            console.log('\n=== 15. 生成日报 ===');
            const report = await post('/api/report/reports/generate', { report_date: '2026-06-08' });
            console.log('总招标项目:', report.data.total_bid_count, '流标数:', report.data.failed_bid_count, '流标率:', report.data.failed_bid_rate + '%');
        }
    }
}

test().catch(e => console.error('Error:', e.message));
