const initSqlJs = require("sql.js");
const path = require("path");
const fs = require("fs");

const dataDir = path.join(__dirname, "data");
const dbPath = path.join(dataDir, "king-reigns.db");

fs.mkdirSync(dataDir, { recursive: true });

let db;

async function initDatabase() {
    const SQL = await initSqlJs();

    if (fs.existsSync(dbPath)) {
        const file = fs.readFileSync(dbPath);
        db = new SQL.Database(file);
    } else {
        db = new SQL.Database();
    }

    db.run("PRAGMA foreign_keys = ON");

    db.run(`
        CREATE TABLE IF NOT EXISTS whatsapp_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            whatsapp_id TEXT NOT NULL UNIQUE,
            status TEXT NOT NULL DEFAULT 'PENDING',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);


    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'user',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS account_whatsapp_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL UNIQUE,
            whatsapp_id TEXT NOT NULL UNIQUE,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY(whatsapp_id) REFERENCES whatsapp_sessions(whatsapp_id) ON DELETE CASCADE
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS user_settings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            feature TEXT NOT NULL,
            setting_value TEXT NOT NULL,
            UNIQUE(user_id, feature),
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS group_settings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            group_id TEXT NOT NULL,
            feature TEXT NOT NULL,
            setting_value TEXT NOT NULL,
            UNIQUE(user_id, group_id, feature),
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `);


    // TEMPORARY WHATSAPP PAIRING OWNERSHIP
    db.run(`
        CREATE TABLE IF NOT EXISTS pairing_requests (
            whatsapp_id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `);

    db.run(`
        CREATE INDEX IF NOT EXISTS idx_pairing_requests_expiry
        ON pairing_requests(expires_at)
    `);

    saveDatabase();

    console.log("👑 KING REIGNS DATABASE READY");
    return db;
}

function saveDatabase() {
    if (!db) throw new Error("Database is not initialized");

    const data = Buffer.from(db.export());
    const tempPath = dbPath + ".tmp-" + process.pid;
    let fd;

    try {
        fd = fs.openSync(tempPath, "w", 0o600);
        fs.writeFileSync(fd, data);
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = null;
        fs.renameSync(tempPath, dbPath);
        fs.chmodSync(dbPath, 0o600);
    } catch (error) {
        if (fd !== undefined && fd !== null) {
            try { fs.closeSync(fd); } catch {}
        }
        try { fs.unlinkSync(tempPath); } catch {}
        throw error;
    }
}

module.exports = {
    initDatabase,
    saveDatabase,
    getDatabase: () => db
};
