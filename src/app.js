const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { initDatabase, saveDatabase } = require('./database/db');
const cron = require('node-cron');

const procurementRoutes = require('./routes/procurement');
const announcementRoutes = require('./routes/announcement');
const registrationRoutes = require('./routes/registration');
const bidOpeningRoutes = require('./routes/bidOpening');
const evaluationRoutes = require('./routes/evaluation');
const winningRoutes = require('./routes/winning');
const contractRoutes = require('./routes/contract');
const reportRoutes = require('./routes/report');
const notificationRoutes = require('./routes/notification');
const supplierRoutes = require('./routes/supplier');
const objectionRoutes = require('./routes/objection');

const { generateDailyReport } = require('./services/reportService');
const { checkContractDelays } = require('./services/contractService');

const app = express();
const PORT = process.env.PORT || 3800;

app.use(helmet());
app.use(cors());
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use('/api/procurement', procurementRoutes);
app.use('/api/announcement', announcementRoutes);
app.use('/api/registration', registrationRoutes);
app.use('/api/bid-opening', bidOpeningRoutes);
app.use('/api/evaluation', evaluationRoutes);
app.use('/api/winning', winningRoutes);
app.use('/api/contract', contractRoutes);
app.use('/api/report', reportRoutes);
app.use('/api/notification', notificationRoutes);
app.use('/api/supplier', supplierRoutes);
app.use('/api/objection', objectionRoutes);

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', service: '智慧政府采购与招投标管理系统', version: '1.0.0' });
});

app.use((req, res) => {
    res.status(404).json({ success: false, message: '接口不存在' });
});

app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ success: false, message: '服务器内部错误' });
});

let dbSaveInterval = null;

async function startServer() {
    await initDatabase();

    cron.schedule('0 1 * * *', () => {
        console.log('[定时任务] 生成每日采购运行报告...');
        generateDailyReport(require('./database/db').getDb());
        saveDatabase();
    });

    cron.schedule('0 9 * * *', () => {
        console.log('[定时任务] 检查合同履约延迟...');
        checkContractDelays(require('./database/db').getDb());
        saveDatabase();
    });

    dbSaveInterval = setInterval(() => {
        saveDatabase();
    }, 30000);

    app.listen(PORT, () => {
        console.log(`智慧政府采购与招投标管理系统API已启动`);
        console.log(`服务地址: http://localhost:${PORT}`);
        console.log(`健康检查: http://localhost:${PORT}/api/health`);
    });
}

process.on('SIGINT', () => {
    console.log('\n正在关闭服务...');
    saveDatabase();
    if (dbSaveInterval) clearInterval(dbSaveInterval);
    process.exit(0);
});

process.on('SIGTERM', () => {
    saveDatabase();
    if (dbSaveInterval) clearInterval(dbSaveInterval);
    process.exit(0);
});

startServer().catch(err => {
    console.error('启动失败:', err);
    process.exit(1);
});

module.exports = app;
