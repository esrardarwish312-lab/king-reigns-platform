const {
    getDatabase,
    saveDatabase
} = require("./database");

function registerConnectedUser(whatsappId) {
    const db = getDatabase();
    if (!db) throw new Error("Database not initialized");

    if (typeof whatsappId !== "string" || !whatsappId.trim()) {
        throw new Error("Invalid WhatsApp ID");
    }

    const existing = db.exec(
        "SELECT id FROM whatsapp_sessions WHERE whatsapp_id = ?",
        [whatsappId]
    );

    if (existing.length) {
        const id = existing[0].values[0][0];
        db.run(
            "UPDATE whatsapp_sessions SET status = 'CONNECTED' WHERE id = ?",
            [id]
        );
        saveDatabase();
        return id;
    }

    db.run(
        "INSERT INTO whatsapp_sessions (whatsapp_id, status) VALUES (?, 'CONNECTED')",
        [whatsappId]
    );

    saveDatabase();
    const result = db.exec("SELECT last_insert_rowid()");
    return result[0].values[0][0];
}

function setUserStatus(whatsappId, status) {
    const db = getDatabase();
    if (!db) return;

    db.run(
        "UPDATE whatsapp_sessions SET status = ? WHERE whatsapp_id = ?",
        [status, whatsappId]
    );

    saveDatabase();
}

function linkWhatsAppSession(userId, whatsappId) {
    const db = getDatabase();
    if (!db) throw new Error("Database not initialized");

    db.run(
        `INSERT INTO account_whatsapp_sessions (user_id, whatsapp_id)
         VALUES (?, ?)`,
        [userId, whatsappId]
    );

    saveDatabase();
}

function getAccountWhatsAppSession(userId) {
    const db = getDatabase();
    if (!db) throw new Error("Database not initialized");

    const result = db.exec(
        `SELECT whatsapp_sessions.whatsapp_id,
                whatsapp_sessions.status
         FROM account_whatsapp_sessions
         JOIN whatsapp_sessions
           ON whatsapp_sessions.whatsapp_id =
              account_whatsapp_sessions.whatsapp_id
         WHERE account_whatsapp_sessions.user_id = ?`,
        [userId]
    );

    if (!result.length) return null;

    const [whatsappId, status] = result[0].values[0];
    return { whatsappId, status };
}


function getWhatsAppSessionOwner(whatsappId) {
    const db = getDatabase();
    if (!db) throw new Error("Database not initialized");

    const result = db.exec(
        "SELECT user_id FROM account_whatsapp_sessions WHERE whatsapp_id = ?",
        [whatsappId]
    );

    return result.length ? Number(result[0].values[0][0]) : null;
}

function reserveWhatsAppSession(userId, whatsappId) {
    const db = getDatabase();
    if (!db) throw new Error("Database not initialized");

    if (!Number.isSafeInteger(Number(userId)) || Number(userId) < 1) {
        throw new Error("Invalid account");
    }

    const id = Number(userId);

    const account = db.exec(
        "SELECT whatsapp_id FROM account_whatsapp_sessions WHERE user_id = ?",
        [id]
    );

    if (account.length) {
        if (account[0].values[0][0] !== whatsappId) {
            throw new Error("Your account already has a WhatsApp session");
        }
        return;
    }

    const owner = getWhatsAppSessionOwner(whatsappId);
    if (owner !== null && owner !== id) {
        throw new Error("This WhatsApp number is already linked to another account");
    }

    const existingSession = db.exec(
        "SELECT id FROM whatsapp_sessions WHERE whatsapp_id = ?",
        [whatsappId]
    );

    if (existingSession.length && owner === null) {
        throw new Error("This WhatsApp number has an existing unassigned session");
    }

    db.run("BEGIN TRANSACTION");
    try {
        db.run(
            "INSERT OR IGNORE INTO whatsapp_sessions (whatsapp_id, status) VALUES (?, 'PENDING')",
            [whatsappId]
        );

        db.run(
            "INSERT INTO account_whatsapp_sessions (user_id, whatsapp_id) VALUES (?, ?)",
            [id, whatsappId]
        );

        db.run("COMMIT");
        saveDatabase();
    } catch (error) {
        try { db.run("ROLLBACK"); } catch {}
        throw error;
    }
}


function createPairingRequest(userId, whatsappId, ttlMs = 10 * 60 * 1000) {
    const db = getDatabase();
    if (!db) throw new Error("Database not initialized");

    const id = Number(userId);
    if (!Number.isSafeInteger(id) || id < 1) {
        throw new Error("Invalid account");
    }

    const account = db.exec(
        "SELECT whatsapp_id FROM account_whatsapp_sessions WHERE user_id = ?",
        [id]
    );
    if (account.length) {
        throw new Error("Your account already has a WhatsApp session");
    }

    const owner = getWhatsAppSessionOwner(whatsappId);
    if (owner !== null) {
        throw new Error("This WhatsApp number is already linked");
    }

    const existing = db.exec(
        "SELECT user_id FROM pairing_requests WHERE whatsapp_id = ? AND expires_at > ?",
        [whatsappId, Date.now()]
    );

    if (existing.length && Number(existing[0].values[0][0]) !== id) {
        throw new Error("This number already has a pending pairing request");
    }

    db.run("BEGIN TRANSACTION");
    try {
        db.run("DELETE FROM pairing_requests WHERE expires_at <= ?", [Date.now()]);

        const userPending = db.exec(
            "SELECT whatsapp_id FROM pairing_requests WHERE user_id = ?",
            [id]
        );

        if (userPending.length) {
            throw new Error("Your account already has a pending pairing request");
        }

        db.run(
            `INSERT INTO pairing_requests (whatsapp_id, user_id, expires_at)
             VALUES (?, ?, ?)
             ON CONFLICT(whatsapp_id) DO UPDATE SET
                user_id = excluded.user_id,
                expires_at = excluded.expires_at`,
            [whatsappId, id, Date.now() + ttlMs]
        );
        db.run("COMMIT");
        saveDatabase();
    } catch (error) {
        try { db.run("ROLLBACK"); } catch {}
        throw error;
    }
}

function cancelPairingRequest(whatsappId, userId) {
    const db = getDatabase();
    if (!db) throw new Error("Database not initialized");

    db.run(
        "DELETE FROM pairing_requests WHERE whatsapp_id = ? AND user_id = ?",
        [whatsappId, Number(userId)]
    );
    saveDatabase();
}

function confirmPendingWhatsAppSession(whatsappId) {
    const db = getDatabase();
    if (!db) throw new Error("Database not initialized");

    db.run("BEGIN TRANSACTION");
    try {
        const pending = db.exec(
            "SELECT user_id, expires_at FROM pairing_requests WHERE whatsapp_id = ?",
            [whatsappId]
        );

        if (!pending.length) {
            db.run("ROLLBACK");
            return false;
        }

        const [userId, expiresAt] = pending[0].values[0];

        if (Number(expiresAt) <= Date.now()) {
            db.run("DELETE FROM pairing_requests WHERE whatsapp_id = ?", [whatsappId]);
            db.run("COMMIT");
            saveDatabase();
            return false;
        }

        const account = db.exec(
            "SELECT whatsapp_id FROM account_whatsapp_sessions WHERE user_id = ?",
            [userId]
        );
        if (account.length && account[0].values[0][0] !== whatsappId) {
            throw new Error("Account already owns another WhatsApp session");
        }

        const owner = db.exec(
            "SELECT user_id FROM account_whatsapp_sessions WHERE whatsapp_id = ?",
            [whatsappId]
        );
        if (owner.length && Number(owner[0].values[0][0]) !== Number(userId)) {
            throw new Error("WhatsApp number already belongs to another account");
        }

        db.run(
            `INSERT INTO whatsapp_sessions (whatsapp_id, status)
             VALUES (?, 'CONNECTED')
             ON CONFLICT(whatsapp_id) DO UPDATE SET status = 'CONNECTED'`,
            [whatsappId]
        );

        if (!account.length && !owner.length) {
            db.run(
                "INSERT INTO account_whatsapp_sessions (user_id, whatsapp_id) VALUES (?, ?)",
                [userId, whatsappId]
            );
        }

        db.run("DELETE FROM pairing_requests WHERE whatsapp_id = ?", [whatsappId]);
        db.run("COMMIT");
        saveDatabase();
        return true;
    } catch (error) {
        try { db.run("ROLLBACK"); } catch {}
        throw error;
    }
}

function saveUserSetting(userId, feature, value) {
    const db = getDatabase();
    if (!db) throw new Error("Database not initialized");

    db.run(`
        INSERT INTO user_settings (user_id, feature, setting_value)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id, feature)
        DO UPDATE SET setting_value = excluded.setting_value
    `, [userId, feature, JSON.stringify(value)]);

    saveDatabase();
}

function getUserSettings(userId) {
    const db = getDatabase();
    if (!db) throw new Error("Database not initialized");

    const result = db.exec(
        "SELECT feature, setting_value FROM user_settings WHERE user_id = ?",
        [userId]
    );

    if (!result.length) return {};
    return Object.fromEntries(result[0].values);
}

module.exports = {
    registerConnectedUser,
    setUserStatus,
    linkWhatsAppSession,
    getAccountWhatsAppSession,
    getWhatsAppSessionOwner,
    reserveWhatsAppSession,
    createPairingRequest,
    cancelPairingRequest,
    confirmPendingWhatsAppSession,
    saveUserSetting,
    getUserSettings
};
