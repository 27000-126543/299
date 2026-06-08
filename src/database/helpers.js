const { v4: uuidv4 } = require('uuid');
const dayjs = require('dayjs');

function queryAll(db, sql, params = []) {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const results = [];
    while (stmt.step()) {
        results.push(stmt.getAsObject());
    }
    stmt.free();
    return results;
}

function queryOne(db, sql, params = []) {
    const results = queryAll(db, sql, params);
    return results.length > 0 ? results[0] : null;
}

function queryRun(db, sql, params = []) {
    db.run(sql, params);
    return db.getRowsModified();
}

function generateId(prefix = '') {
    return prefix + uuidv4().replace(/-/g, '').substring(0, 16);
}

function generateAnnouncementNo() {
    const now = dayjs();
    return `ZB${now.format('YYYYMMDD')}${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;
}

module.exports = { queryAll, queryOne, queryRun, generateId, generateAnnouncementNo };
