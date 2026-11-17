const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");

const pino = require("pino");
const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");
const workerLog = require("./worker-log");
const { isOwner } = require("./owner");
const {
    registerConnectedUser,
    setUserStatus,
    createPairingRequest,
    cancelPairingRequest,
    confirmPendingWhatsAppSession,
    getWhatsAppSessionOwner
} = require("./user-store");

const sessions = new Map();

let waVersionPromise = null;

async function getWAVersion() {
    if (!waVersionPromise) {
        waVersionPromise = fetchLatestBaileysVersion()
            .then(({ version }) => {
                console.log("WhatsApp Web version loaded:", version);
                return version;
            })
            .catch(error => {
                waVersionPromise = null;
                throw error;
            });
    }
    return waVersionPromise;
}
const statuses = new Map();
const activeNumbers = new Set();

const SESSIONS_DIR = path.join(
    __dirname,
    "private",
    "sessions"
);

// SAFE RECOVERY: backup and quarantine only unassigned customer sessions.
function quarantineUnassignedSession(number, sessionDir) {
    if (!/^[0-9]{8,15}$/.test(number)) {
        throw new Error("Invalid recovery number");
    }

    if (isOwner(number)) {
        throw new Error("Owner session is protected");
    }

    if (getWhatsAppSessionOwner(number) !== null) {
        throw new Error("Session belongs to an account");
    }

    if (sessions.has(number) || activeNumbers.has(number) || reconnecting.has(number)) {
        throw new Error("Active session cannot be quarantined");
    }

    if (!fs.existsSync(sessionDir)) return;

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDir = path.join(__dirname, "data", "backup", "recovery-sessions");
    const quarantineDir = path.join(__dirname, "private", "session-quarantine");
    const archive = path.join(backupDir, `${number}-${stamp}.tar.gz`);
    const destination = path.join(quarantineDir, `${number}-${stamp}`);

    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(quarantineDir, { recursive: true, mode: 0o700 });

    // Create and verify backup before moving the original folder.
    execFileSync("tar", ["-czf", archive, "-C", SESSIONS_DIR, number], {
        stdio: "pipe"
    });

    if (!fs.existsSync(archive) || fs.statSync(archive).size === 0) {
        throw new Error("Recovery backup verification failed");
    }

    const listing = execFileSync("tar", ["-tzf", archive], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
    });

    if (!listing.split("\\n").some(entry => entry.startsWith(number + "/"))) {
        throw new Error("Recovery archive contents could not be verified");
    }

    if (fs.existsSync(destination)) {
        throw new Error("Recovery destination already exists");
    }

    fs.renameSync(sessionDir, destination);

    workerLog("UNASSIGNED_SESSION_QUARANTINED", number, {
        status: "BACKUP_VERIFIED"
    });

    console.log("✅ Unassigned session safely quarantined:", number.slice(-3));
}



const reconnectTimers = new Map();
const reconnecting = new Set();
const reconnectAttempts = new Map();


function scheduleReconnect(number) {
    if (reconnectTimers.has(number) || reconnecting.has(number)) return;

    const attempt = (reconnectAttempts.get(number) || 0) + 1;
    reconnectAttempts.set(number, attempt);

    const delay = Math.min(3000 * (2 ** (attempt - 1)), 60000);

    if (!isOwner(number)) workerLog("RECONNECT_SCHEDULED", number, {attempt, delayMs: delay});

    const timer = setTimeout(async () => {
        reconnectTimers.delete(number);

        if (sessions.has(number)) return;

        reconnecting.add(number);

        try {
            const sessionDir = path.join(SESSIONS_DIR, number);
            const { state, saveCreds } =
                await useMultiFileAuthState(sessionDir);

            if (!state.creds.registered) {
                statuses.set(number, "LOGGED_OUT");
                reconnectAttempts.delete(number);
                return;
            }

            await createSocket(number, state, saveCreds);
            if (!isOwner(number)) workerLog("RECONNECT_STARTED", number);

        } catch (error) {
            if (!isOwner(number)) workerLog("RECONNECT_FAILED", number, {status: "DISCONNECTED"});
            console.error("Reconnect failed:", error.message);
            statuses.set(number, "DISCONNECTED");

        } finally {
            reconnecting.delete(number);

            if (
                !sessions.has(number) &&
                statuses.get(number) === "DISCONNECTED"
            ) {
                scheduleReconnect(number);
            }
        }
    }, delay);

    reconnectTimers.set(number, timer);
}

async function createSocket(number, state, saveCreds) {
    const version = await getWAVersion();
    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: "debug" }),
        printQRInTerminal: false,
        browser: ["Ubuntu", "Chrome", "22.04.4"]
    });

    sessions.set(number, sock);

    sock.ev.on("creds.update", saveCreds);


    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify" || !Array.isArray(messages)) return;

        for (const msg of messages) {
            try {
                if (!msg?.message || msg.key?.fromMe) continue;

                const jid = msg.key?.remoteJid;
                if (!jid || jid === "status@broadcast" || jid.endsWith("@g.us")) continue;

                let content = msg.message;
                while (
                    content?.ephemeralMessage?.message ||
                    content?.viewOnceMessage?.message ||
                    content?.viewOnceMessageV2?.message
                ) {
                    content =
                        content.ephemeralMessage?.message ||
                        content.viewOnceMessage?.message ||
                        content.viewOnceMessageV2?.message;
                }

                const text = (
                    content?.conversation ||
                    content?.extendedTextMessage?.text ||
                    content?.imageMessage?.caption ||
                    content?.videoMessage?.caption ||
                    ""
                ).trim();

                const command = text
                    .toLowerCase()
                    .replace(/^[!.\\/]/, "");

                // 👤 Get the real sender number.
                // Baileys may use LID, while the Alt/PN fields contain
                // the actual WhatsApp phone-number identity.
                const senderCandidates = [
                    msg.key?.participantPn,
                    msg.key?.senderPn,
                    msg.key?.remoteJidAlt,
                    msg.key?.participantAlt,
                    msg.key?.participant,
                    msg.key?.remoteJid
                ].filter(Boolean);

                const senderNumber = senderCandidates
                    .map(value => String(value).split("@")[0].split(":")[0])
                    .find(value => /^\d{8,15}$/.test(value)) || "";

                const senderIsOwner = senderCandidates.some(value =>
                    isOwner(String(value).split("@")[0].split(":")[0])
                );

                if (senderIsOwner) {
                    console.log("👑 OWNER MESSAGE DETECTED:", senderNumber || "[number unavailable]");
                }

                const menuText =
                    "👑 KING REIGNS BOT\n\n" +
                    "📌 AVAILABLE COMMANDS\n\n" +
                    "▪ menu - د Bot عکس او مینیو\n" +
                    "▪ help - د لارښوونو لېست\n" +
                    "▪ ping - د Bot ازموینه\n" +
                    "▪ time - اوسنی وخت\n" +
                    "▪ date - نننۍ نېټه\n\n" +
                    "👑 POWERED BY KING REIGNS";

                if (command === "ping") {
                    await sock.sendMessage(jid, {
                        text: "🏓 pong"
                    });

                } else if (command === "time") {
                    const value = new Intl.DateTimeFormat("en-GB", {
                        timeZone: "Asia/Kabul",
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit"
                    }).format(new Date());

                    await sock.sendMessage(jid, {
                        text: "🕒 د افغانستان وخت: " + value
                    });

                } else if (command === "date") {
                    const value = new Intl.DateTimeFormat("en-GB", {
                        timeZone: "Asia/Kabul",
                        year: "numeric",
                        month: "long",
                        day: "numeric"
                    }).format(new Date());

                    await sock.sendMessage(jid, {
                        text: "📅 نېټه: " + value
                    });

                } else if (command === "help" || command === "menu") {
                    const photoPath = path.join(__dirname, "king-photo.png");

                    if (fs.existsSync(photoPath)) {
                        await sock.sendMessage(jid, {
                            image: { url: photoPath },
                            caption: menuText
                        });
                    } else {
                        console.error("❌ Menu image not found:", photoPath);
                        await sock.sendMessage(jid, {
                            text: menuText
                        });
                    }
                }

            } catch (error) {
                console.error("Message handler error:", error.message);
            }
        }
    });

    sock.ev.on("connection.update", (update) => {
        if (sessions.get(number) !== sock) return;

        if (update.connection === "open") {
            if (!isOwner(number)) {
                try {
                    const confirmed = confirmPendingWhatsAppSession(number);

                    if (!confirmed) {
                        if (getWhatsAppSessionOwner(number) === null) {
                            statuses.set(number, "UNASSIGNED");
                            console.error("Blocked WhatsApp connection without confirmed ownership.");

                            sessions.delete(number);
                            Promise.resolve(sock.end()).catch(() => {});
                            return;
                        }

                        registerConnectedUser(number);
                    }
                } catch (error) {
                    statuses.set(number, "OWNERSHIP_ERROR");
                    console.error("WhatsApp ownership confirmation failed:", error.message);

                    sessions.delete(number);
                    Promise.resolve(sock.end()).catch(() => {});
                    return;
                }
            }

            statuses.set(number, "CONNECTED");
            if (!isOwner(number)) workerLog("CONNECTED", number, {status: "CONNECTED"});
            reconnectAttempts.delete(number);
            return;
        }

        if (update.connection === "connecting") {
            statuses.set(number, "WAITING");
            if (!isOwner(number)) workerLog("CONNECTING", number, {status: "WAITING"});
            return;
        }

        if (update.connection === "close") {
            const code =
                update.lastDisconnect?.error?.output?.statusCode;

            if (!isOwner(number)) workerLog("CONNECTION_CLOSED", number, {code: code ?? null, status: "DISCONNECTED"});
            sessions.delete(number);

            if (code === DisconnectReason.loggedOut) {
                statuses.set(number, "LOGGED_OUT");
                setUserStatus(number, "LOGGED_OUT");
                reconnectAttempts.delete(number);
                return;
            }

            if (code === DisconnectReason.connectionReplaced) {
                statuses.set(number, "CONNECTION_REPLACED");
                setUserStatus(number, "CONNECTION_REPLACED");
                reconnectAttempts.delete(number);
                return;
            }

            if (code === DisconnectReason.badSession) {
                statuses.set(number, "BAD_SESSION");
                setUserStatus(number, "BAD_SESSION");
                reconnectAttempts.delete(number);
                return;
            }

            if (
                code === DisconnectReason.forbidden ||
                code === DisconnectReason.multideviceMismatch
            ) {
                statuses.set(number, "DISCONNECTED");
                setUserStatus(number, "DISCONNECTED");
                reconnectAttempts.delete(number);
                return;
            }

            statuses.set(number, "DISCONNECTED");
            setUserStatus(number, "DISCONNECTED");

            if (
                [
                    DisconnectReason.connectionLost,
                    DisconnectReason.connectionClosed,
                    DisconnectReason.unavailableService,
                    DisconnectReason.restartRequired
                ].includes(code)
            ) {
                scheduleReconnect(number);
            }
        }
    });

    return sock;
}



async function createPairing(phone, userId) {
    const number = String(phone).replace(/\D/g, "");

    if (!/^[0-9]{8,15}$/.test(number)) {
        throw new Error("Invalid phone number");
    }

    if (!Number.isSafeInteger(Number(userId)) || Number(userId) < 1) {
        throw new Error("Login required");
    }

    if (isOwner(number)) {
        throw new Error("Owner number cannot be used as a customer session");
    }

    if (sessions.has(number)) {
        throw new Error("A session already exists for this number");
    }

    if (activeNumbers.has(number) || reconnecting.has(number)) {
        throw new Error("A connection request already exists");
    }

    const sessionDir = path.join(SESSIONS_DIR, number);
    const existingOwner = getWhatsAppSessionOwner(number);

    if (fs.existsSync(sessionDir) && existingOwner === null) {
        const existingFiles = fs.readdirSync(sessionDir);

        if (existingFiles.length === 0) {
            fs.rmdirSync(sessionDir);
            console.log("Empty unassigned session directory safely cleared:", number.slice(-3));
        } else {
            workerLog("PAIRING_BLOCKED", number, {status: "UNASSIGNED_SESSION"});
            throw new Error("This number has an existing unassigned session. Owner recovery approval required.");
        }
    }

    createPairingRequest(Number(userId), number);
    workerLog("PAIRING_REQUESTED", number, {status: "WAITING"});
    activeNumbers.add(number);

    let sock = null;

    try {
        fs.mkdirSync(sessionDir, { recursive: true });

        const { state, saveCreds } =
            await useMultiFileAuthState(sessionDir);

        sock = await createSocket(number, state, saveCreds);

        if (!state.creds.registered) {
            statuses.set(number, "WAITING");
            const handshakeReady = sock.waitForConnectionUpdate(
                update => update.handshakeReady === true,
                20000
            );
            await sock.waitForSocketOpen();
            await handshakeReady;
            const code = await sock.requestPairingCode(number);
            workerLog("PAIRING_CODE_CREATED", number, {status: "WAITING"});
            return code;
        }

        statuses.set(number, "WAITING");
        return "ALREADY_CONNECTED";

    } catch (error) {
        try {
            cancelPairingRequest(number, Number(userId));
        } catch (cleanupError) {
            console.error("Pending pairing cleanup failed:", cleanupError.message);
        }

        if (sock && sessions.get(number) === sock) {
            sessions.delete(number);

            try {
                await sock.end(error);
            } catch (closeError) {
                console.error("Pairing socket cleanup failed:", closeError.message);
            }
        }

        // Remove only an empty directory left by a failed pairing attempt.
        try {
            if (
                fs.existsSync(sessionDir) &&
                fs.statSync(sessionDir).isDirectory() &&
                fs.readdirSync(sessionDir).length === 0
            ) {
                fs.rmdirSync(sessionDir);
                console.log("✅ Empty failed-pairing directory cleaned:", number.slice(-3));
            }
        } catch (cleanupError) {
            console.error("Empty session cleanup failed:", cleanupError.message);
        }

        statuses.set(number, "PAIRING_FAILED");
        if (!isOwner(number)) workerLog("PAIRING_FAILED", number, {status: "PAIRING_FAILED"});

        try {
            setUserStatus(number, "PAIRING_FAILED");
        } catch (statusError) {
            console.error("Could not save pairing failure status:", statusError.message);
        }

        throw error;

    } finally {
        activeNumbers.delete(number);
    }
}
async function startSavedSessions() {
    if (!fs.existsSync(SESSIONS_DIR)) return;

    const folders = fs.readdirSync(SESSIONS_DIR, {
        withFileTypes: true
    });

    for (const folder of folders) {
        if (!folder.isDirectory()) continue;

        const number = folder.name;

        if (isOwner(number)) {
            statuses.set(number, "OWNER");
            continue;
        }

        if (!/^[0-9]{8,15}$/.test(number)) continue;

        if (getWhatsAppSessionOwner(number) === null) {
            workerLog("UNASSIGNED_SESSION_SKIPPED", number, {status: "UNASSIGNED"});
            continue;
        }

        if (sessions.has(number)) continue;

        try {
            const sessionDir = path.join(SESSIONS_DIR, number);

            const { state, saveCreds } =
                await useMultiFileAuthState(sessionDir);

            if (!state.creds.registered) {
                statuses.set(number, "WAITING");
                continue;
            }

            statuses.set(number, "WAITING");
            await createSocket(number, state, saveCreds);

        } catch (error) {
            statuses.set(number, "DISCONNECTED");
            console.error("Session restore failed:", error.message);
        }
    }
}

function getSessions() {
    if (!fs.existsSync(SESSIONS_DIR)) return [];

    return fs.readdirSync(SESSIONS_DIR, {
        withFileTypes: true
    })
    .filter(item =>
        item.isDirectory() &&
        !isOwner(item.name) &&
        getWhatsAppSessionOwner(item.name) !== null
    )
    .map(item => ({
        phone: item.name,
        session: statuses.get(item.name) || "DISCONNECTED"
    }));
}

module.exports = {
    createPairing,
    getSessions,
    startSavedSessions
};
