const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', '..', 'data', 'procurement.db');

let db = null;

async function initDatabase() {
    const SQL = await initSqlJs();
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    if (fs.existsSync(DB_PATH)) {
        const buffer = fs.readFileSync(DB_PATH);
        db = new SQL.Database(buffer);
    } else {
        db = new SQL.Database();
    }
    createTables();
    return db;
}

function createTables() {
    db.run(`
        CREATE TABLE IF NOT EXISTS procurement_requests (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            category TEXT NOT NULL,
            budget DECIMAL(15,2) NOT NULL,
            quantity INTEGER,
            description TEXT,
            specs TEXT,
            delivery_date TEXT,
            delivery_address TEXT,
            purchaser_id TEXT NOT NULL,
            purchaser_name TEXT,
            dept_name TEXT,
            status TEXT DEFAULT 'draft',
            recommended_method TEXT,
            method_reason TEXT,
            reject_reason TEXT,
            completeness_score INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now','localtime')),
            updated_at TEXT DEFAULT (datetime('now','localtime'))
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS bidding_announcements (
            id TEXT PRIMARY KEY,
            request_id TEXT NOT NULL,
            announcement_no TEXT UNIQUE,
            title TEXT NOT NULL,
            procurement_method TEXT NOT NULL,
            category TEXT,
            budget DECIMAL(15,2),
            deadline TEXT,
            bid_opening_date TEXT,
            content TEXT,
            status TEXT DEFAULT 'draft',
            purchaser_id TEXT,
            created_at TEXT DEFAULT (datetime('now','localtime')),
            updated_at TEXT DEFAULT (datetime('now','localtime')),
            FOREIGN KEY (request_id) REFERENCES procurement_requests(id)
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS suppliers (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            unified_code TEXT UNIQUE,
            category TEXT,
            qualification_level TEXT,
            credit_score INTEGER DEFAULT 100,
            contact_person TEXT,
            contact_phone TEXT,
            email TEXT,
            address TEXT,
            status TEXT DEFAULT 'active',
            registered_at TEXT DEFAULT (datetime('now','localtime'))
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS supplier_registrations (
            id TEXT PRIMARY KEY,
            announcement_id TEXT NOT NULL,
            supplier_id TEXT NOT NULL,
            supplier_name TEXT,
            qualification_status TEXT DEFAULT 'pending',
            credit_status TEXT DEFAULT 'pending',
            check_result TEXT DEFAULT 'pending',
            reject_reason TEXT,
            deposit_notice_id TEXT,
            deposit_amount DECIMAL(15,2),
            deposit_status TEXT DEFAULT 'unpaid',
            registered_at TEXT DEFAULT (datetime('now','localtime')),
            FOREIGN KEY (announcement_id) REFERENCES bidding_announcements(id),
            FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS bid_documents (
            id TEXT PRIMARY KEY,
            registration_id TEXT NOT NULL,
            supplier_id TEXT NOT NULL,
            announcement_id TEXT NOT NULL,
            file_name TEXT,
            file_hash TEXT,
            encrypted BLOB,
            decrypted BLOB,
            is_decrypted INTEGER DEFAULT 0,
            integrity_check TEXT DEFAULT 'pending',
            missing_files TEXT,
            is_valid INTEGER DEFAULT 1,
            invalid_reason TEXT,
            submitted_at TEXT DEFAULT (datetime('now','localtime')),
            FOREIGN KEY (registration_id) REFERENCES supplier_registrations(id),
            FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
            FOREIGN KEY (announcement_id) REFERENCES bidding_announcements(id)
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS evaluations (
            id TEXT PRIMARY KEY,
            announcement_id TEXT NOT NULL,
            supplier_id TEXT NOT NULL,
            supplier_name TEXT,
            technical_score DECIMAL(5,2) DEFAULT 0,
            business_score DECIMAL(5,2) DEFAULT 0,
            price_score DECIMAL(5,2) DEFAULT 0,
            total_score DECIMAL(5,2) DEFAULT 0,
            ranking INTEGER,
            is_candidate INTEGER DEFAULT 0,
            qualification_review_status TEXT,
            qualification_review_id TEXT,
            evaluated_at TEXT DEFAULT (datetime('now','localtime')),
            FOREIGN KEY (announcement_id) REFERENCES bidding_announcements(id),
            FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS winning_results (
            id TEXT PRIMARY KEY,
            announcement_id TEXT NOT NULL,
            supplier_id TEXT NOT NULL,
            supplier_name TEXT,
            total_score DECIMAL(5,2),
            win_amount DECIMAL(15,2),
            status TEXT DEFAULT 'pending_approval',
            approved_by TEXT,
            approved_at TEXT,
            result_announcement_id TEXT,
            contract_id TEXT,
            created_at TEXT DEFAULT (datetime('now','localtime')),
            FOREIGN KEY (announcement_id) REFERENCES bidding_announcements(id),
            FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS contracts (
            id TEXT PRIMARY KEY,
            winning_result_id TEXT NOT NULL,
            announcement_id TEXT NOT NULL,
            purchaser_id TEXT NOT NULL,
            purchaser_name TEXT,
            supplier_id TEXT NOT NULL,
            supplier_name TEXT,
            title TEXT,
            amount DECIMAL(15,2),
            signing_date TEXT,
            delivery_date TEXT,
            acceptance_date TEXT,
            status TEXT DEFAULT 'draft',
            breach_clause TEXT,
            penalty_rate DECIMAL(5,4) DEFAULT 0.0005,
            created_at TEXT DEFAULT (datetime('now','localtime')),
            updated_at TEXT DEFAULT (datetime('now','localtime')),
            FOREIGN KEY (winning_result_id) REFERENCES winning_results(id),
            FOREIGN KEY (announcement_id) REFERENCES bidding_announcements(id)
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS breach_orders (
            id TEXT PRIMARY KEY,
            contract_id TEXT NOT NULL,
            supplier_id TEXT NOT NULL,
            supplier_name TEXT,
            breach_type TEXT NOT NULL,
            breach_description TEXT,
            penalty_amount DECIMAL(15,2),
            calculation_detail TEXT,
            status TEXT DEFAULT 'pending',
            resolved_at TEXT,
            created_at TEXT DEFAULT (datetime('now','localtime')),
            FOREIGN KEY (contract_id) REFERENCES contracts(id),
            FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS notifications (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            title TEXT NOT NULL,
            content TEXT,
            recipient_type TEXT NOT NULL,
            recipient_id TEXT NOT NULL,
            related_id TEXT,
            related_type TEXT,
            is_read INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now','localtime'))
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS daily_reports (
            id TEXT PRIMARY KEY,
            report_date TEXT NOT NULL,
            total_projects INTEGER DEFAULT 0,
            total_amount DECIMAL(15,2) DEFAULT 0,
            budget_amount DECIMAL(15,2) DEFAULT 0,
            saving_rate DECIMAL(5,2) DEFAULT 0,
            failed_bid_count INTEGER DEFAULT 0,
            total_bid_count INTEGER DEFAULT 0,
            failed_bid_rate DECIMAL(5,2) DEFAULT 0,
            completed_count INTEGER DEFAULT 0,
            breach_count INTEGER DEFAULT 0,
            details TEXT,
            created_at TEXT DEFAULT (datetime('now','localtime'))
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS evaluation_rules (
            id TEXT PRIMARY KEY,
            category TEXT NOT NULL,
            procurement_method TEXT NOT NULL,
            technical_weight DECIMAL(5,2) DEFAULT 60,
            business_weight DECIMAL(5,2) DEFAULT 20,
            price_weight DECIMAL(5,2) DEFAULT 20,
            pass_score DECIMAL(5,2) DEFAULT 60,
            is_active INTEGER DEFAULT 1,
            created_at TEXT DEFAULT (datetime('now','localtime'))
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS recommended_suppliers (
            id TEXT PRIMARY KEY,
            announcement_id TEXT NOT NULL,
            supplier_id TEXT NOT NULL,
            match_score INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now','localtime')),
            FOREIGN KEY (announcement_id) REFERENCES bidding_announcements(id),
            FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS bid_openings (
            id TEXT PRIMARY KEY,
            announcement_id TEXT NOT NULL,
            status TEXT DEFAULT 'pending',
            opened_at TEXT,
            total_bids INTEGER DEFAULT 0,
            valid_bids INTEGER DEFAULT 0,
            invalid_bids INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now','localtime')),
            FOREIGN KEY (announcement_id) REFERENCES bidding_announcements(id)
        )
    `);

    saveDatabase();
}

function saveDatabase() {
    if (!db) return;
    const data = db.export();
    const buffer = Buffer.from(data);
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(DB_PATH, buffer);
}

function getDb() {
    return db;
}

module.exports = { initDatabase, getDb, saveDatabase };
