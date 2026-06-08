const { initDatabase, saveDatabase } = require('../database/db');
const { queryRun } = require('../database/helpers');
const { generateId } = require('../database/helpers');

async function initSampleData() {
    const db = await initDatabase();

    const suppliers = [
        { id: generateId('SUP'), name: '华信科技集团有限公司', unified_code: '91110000MA01XXXX', category: '货物类,服务类', qualification_level: '甲级', credit_score: 95, contact_person: '张明', contact_phone: '13800001111', email: 'huaxin@example.com', address: '北京市海淀区XX路1号' },
        { id: generateId('SUP'), name: '中建工程股份有限公司', unified_code: '91110000MA02XXXX', category: '工程类', qualification_level: '特级', credit_score: 92, contact_person: '李强', contact_phone: '13800002222', email: 'zhongjian@example.com', address: '北京市朝阳区XX路2号' },
        { id: generateId('SUP'), name: '远东软件有限公司', unified_code: '91310000MA03XXXX', category: '服务类,货物类', qualification_level: '甲级', credit_score: 88, contact_person: '王芳', contact_phone: '13800003333', email: 'yuandong@example.com', address: '上海市浦东新区XX路3号' },
        { id: generateId('SUP'), name: '恒通设备制造有限公司', unified_code: '91440000MA04XXXX', category: '货物类', qualification_level: '一级', credit_score: 85, contact_person: '陈伟', contact_phone: '13800004444', email: 'hengtong@example.com', address: '广州市天河区XX路4号' },
        { id: generateId('SUP'), name: '诚信物业管理有限公司', unified_code: '91500000MA05XXXX', category: '服务类', qualification_level: '乙级', credit_score: 55, contact_person: '赵六', contact_phone: '13800005555', email: 'chengxin@example.com', address: '重庆市渝中区XX路5号' },
        { id: generateId('SUP'), name: '绿洲环保科技有限公司', unified_code: '91330000MA06XXXX', category: '货物类,服务类', qualification_level: '一级', credit_score: 78, contact_person: '周丽', contact_phone: '13800006666', email: 'lvzhou@example.com', address: '杭州市西湖区XX路6号' }
    ];

    suppliers.forEach(s => {
        try {
            queryRun(db,
                `INSERT INTO suppliers (id, name, unified_code, category, qualification_level, credit_score, contact_person, contact_phone, email, address)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [s.id, s.name, s.unified_code, s.category, s.qualification_level, s.credit_score, s.contact_person, s.contact_phone, s.email, s.address]
            );
        } catch (e) { /* skip duplicates */ }
    });

    const rules = [
        { id: generateId('ERL'), category: 'default', procurement_method: '公开招标', technical_weight: 60, business_weight: 20, price_weight: 20, pass_score: 60 },
        { id: generateId('ERL'), category: '工程类', procurement_method: '公开招标', technical_weight: 70, business_weight: 10, price_weight: 20, pass_score: 70 },
        { id: generateId('ERL'), category: '货物类', procurement_method: '公开招标', technical_weight: 50, business_weight: 20, price_weight: 30, pass_score: 60 },
        { id: generateId('ERL'), category: '服务类', procurement_method: '竞争性磋商', technical_weight: 60, business_weight: 25, price_weight: 15, pass_score: 65 },
        { id: generateId('ERL'), category: 'default', procurement_method: '竞争性谈判', technical_weight: 50, business_weight: 20, price_weight: 30, pass_score: 55 },
        { id: generateId('ERL'), category: 'default', procurement_method: '询价采购', technical_weight: 30, business_weight: 20, price_weight: 50, pass_score: 50 }
    ];

    rules.forEach(r => {
        try {
            queryRun(db,
                `INSERT INTO evaluation_rules (id, category, procurement_method, technical_weight, business_weight, price_weight, pass_score)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [r.id, r.category, r.procurement_method, r.technical_weight, r.business_weight, r.price_weight, r.pass_score]
            );
        } catch (e) { /* skip */ }
    });

    saveDatabase();
    console.log('示例数据初始化完成');
    console.log(`- 供应商：${suppliers.length}条`);
    console.log(`- 评标规则：${rules.length}条`);
}

initSampleData().catch(err => {
    console.error('初始化失败:', err);
    process.exit(1);
});
