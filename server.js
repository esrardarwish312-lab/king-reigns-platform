require("dotenv").config();

const express = require("express");
const path = require("path");
const session = require("express-session");
const FileSessionStore = require("./file-session-store");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { rateLimit } = require("express-rate-limit");

const { initDatabase, saveDatabase, getDatabase } = require("./database");

const {
    createPairing,
    getSessions,
    startSavedSessions
} = require("./pairing");

if (!process.env.SESSION_SECRET) {
    throw new Error("SESSION_SECRET is missing from .env");
}

const app = express();

app.use(express.json({ limit: "10kb" }));

app.use(session({
    store: new FileSessionStore(),
    name: "king_reigns_session",
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: "strict",
        secure: false,
        maxAge: 7 * 24 * 60 * 60 * 1000
    }
}));

app.use(express.static(path.join(__dirname, "public")));

const authLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: "draft-8",
    legacyHeaders: false
});

const pairingLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 3,
    standardHeaders: "draft-8",
    legacyHeaders: false
});

const guestLimit = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 30,
    standardHeaders: "draft-8",
    legacyHeaders: false
});

function ensureGuestSession(req, res, next) {
    if (req.session.userId) {
        return next();
    }

    try {
        const db = getDatabase();
        const token = crypto.randomBytes(12).toString("hex");
        const username = "guest_" + token;
        const passwordHash = bcrypt.hashSync(
            crypto.randomBytes(32).toString("hex"),
            12
        );

        db.run(
            "INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'guest')",
            [username, passwordHash]
        );
        saveDatabase();

        const result = db.exec("SELECT last_insert_rowid()");
        const userId = Number(result[0].values[0][0]);

        req.session.userId = userId;
        req.session.username = username;
        req.session.save((error) => {
            if (error) return next(error);
            next();
        });
    } catch (error) {
        next(error);
    }
}

function requireLogin(req, res, next) {
    if (!req.session.userId) {
        return res.status(401).json({
            success: false,
            message: "Please login first."
        });
    }
    next();
}

// REGISTER
app.post("/api/auth/register", authLimit, async (req, res) => {
    try {
        const { username, password } = req.body || {};

        if (
            typeof username !== "string" ||
            !/^[a-zA-Z0-9_]{3,24}$/.test(username)
        ) {
            return res.status(400).json({
                success: false,
                message: "Username must be 3-24 characters (letters, numbers, underscore)."
            });
        }

        if (
            typeof password !== "string" ||
            password.length < 10 ||
            Buffer.byteLength(password, "utf8") > 72
        ) {
            return res.status(400).json({
                success: false,
                message: "Password must be at least 10 characters and no more than 72 bytes."
            });
        }

        const db = getDatabase();
        const normalizedUsername = username.toLowerCase();

        const existing = db.exec(
            "SELECT id FROM users WHERE username = ?",
            [normalizedUsername]
        );

        if (existing.length) {
            return res.status(409).json({
                success: false,
                message: "Username is already taken."
            });
        }

        const passwordHash = await bcrypt.hash(password, 12);

        db.run(
            "INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'user')",
            [normalizedUsername, passwordHash]
        );

        saveDatabase();

        const result = db.exec("SELECT last_insert_rowid()");
        const userId = result[0].values[0][0];

        req.session.regenerate((error) => {
            if (error) {
                return res.status(500).json({
                    success: false,
                    message: "Account created, but login failed. Please login."
                });
            }

            req.session.userId = userId;
            req.session.username = normalizedUsername;

            req.session.save((saveError) => {
                if (saveError) {
                    return res.status(500).json({
                        success: false,
                        message: "Account created, but session could not be saved."
                    });
                }

                res.status(201).json({
                    success: true,
                    message: "Account created successfully.",
                    user: {
                        id: userId,
                        username: normalizedUsername
                    }
                });
            });
        });

    } catch (error) {
        console.error("Register error:", error.message);
        res.status(500).json({
            success: false,
            message: "Registration failed."
        });
    }
});

// LOGIN
app.post("/api/auth/login", authLimit, async (req, res) => {
    try {
        const { username, password } = req.body || {};

        if (
            typeof username !== "string" ||
            typeof password !== "string" ||
            username.length > 24 ||
            Buffer.byteLength(password, "utf8") > 72
        ) {
            return res.status(400).json({
                success: false,
                message: "Invalid username or password."
            });
        }

        const db = getDatabase();

        const result = db.exec(
            "SELECT id, username, password_hash FROM users WHERE username = ?",
            [username.toLowerCase()]
        );

        if (!result.length) {
            return res.status(401).json({
                success: false,
                message: "Invalid username or password."
            });
        }

        const [userId, savedUsername, passwordHash] =
            result[0].values[0];

        const valid = await bcrypt.compare(password, passwordHash);

        if (!valid) {
            return res.status(401).json({
                success: false,
                message: "Invalid username or password."
            });
        }

        req.session.regenerate((error) => {
            if (error) {
                return res.status(500).json({
                    success: false,
                    message: "Login session could not be created."
                });
            }

            req.session.userId = userId;
            req.session.username = savedUsername;

            req.session.save((saveError) => {
                if (saveError) {
                    return res.status(500).json({
                        success: false,
                        message: "Login session could not be saved."
                    });
                }

                res.json({
                    success: true,
                    message: "Login successful.",
                    user: {
                        id: userId,
                        username: savedUsername
                    }
                });
            });
        });

    } catch (error) {
        console.error("Login error:", error.message);
        res.status(500).json({
            success: false,
            message: "Login failed."
        });
    }
});

// CURRENT USER'S PRIVATE WHATSAPP SESSION
app.get("/api/my-session", guestLimit, ensureGuestSession, (req, res) => {
    try {
        const { getAccountWhatsAppSession } = require("./user-store");
        const session = getAccountWhatsAppSession(Number(req.session.userId));

        if (!session) {
            return res.json({
                success: true,
                hasSession: false
            });
        }

        const phone = String(session.whatsappId);
        res.json({
            success: true,
            hasSession: true,
            session: {
                phone: "••••" + phone.slice(-4),
                status: session.status
            }
        });
    } catch (error) {
        console.error("My session lookup failed:", error.message);
        res.status(500).json({
            success: false,
            message: "Could not load your session."
        });
    }
});

// CURRENT ACCOUNT
app.get("/api/auth/me", (req, res) => {
    if (!req.session.userId) {
        return res.json({
            success: true,
            loggedIn: false
        });
    }

    res.json({
        success: true,
        loggedIn: true,
        user: {
            id: req.session.userId,
            username: req.session.username
        }
    });
});

// LOGOUT FROM WEBSITE
app.post("/api/auth/logout", requireLogin, (req, res) => {
    req.session.destroy((error) => {
        if (error) {
            return res.status(500).json({
                success: false,
                message: "Logout failed."
            });
        }

        res.clearCookie("king_reigns_session", {
            httpOnly: true,
            sameSite: "strict",
            secure: false
        });

        res.json({
            success: true,
            message: "Website logout successful."
        });
    });
});

// SERVER STATUS
app.get("/api/status", (req, res) => {
    const userLimit = 30;
    const sessions = getSessions();

    const connectedUsers = sessions.filter(
        item => item.session === "CONNECTED"
    ).length;

    const reservedUsers = sessions.filter(
        item => ["CONNECTED", "WAITING"].includes(item.session)
    ).length;

    res.json({
        success: true,
        name: "KING REIGNS BOT",
        status: "Backend Online",
        connectedUsers,
        userLimit,
        pendingUsers: Math.max(0, reservedUsers - connectedUsers),
        availableSlots: Math.max(0, userLimit - reservedUsers)
    });
});

// EXISTING PAIRING ROUTE - AUTH PROTECTION WILL BE ADDED
// AFTER SESSION OWNERSHIP IS CONNECTED.
app.post("/api/pair", guestLimit, pairingLimit, ensureGuestSession, async (req, res) => {
    try {
        const { phone, consent } = req.body || {};

        if (consent !== true) {
            return res.status(400).json({
                success: false,
                message: "Please confirm account ownership."
            });
        }

        if (typeof phone !== "string") {
            return res.status(400).json({
                success: false,
                message: "Invalid phone number."
            });
        }

        const userLimit = 30;
        const reservedUsers = getSessions().filter(
            item => ["CONNECTED", "WAITING"].includes(item.session)
        ).length;

        if (reservedUsers >= userLimit) {
            return res.status(503).json({
                success: false,
                message: "Server is full. Please try again later."
            });
        }

        const code = await createPairing(phone, Number(req.session.userId));

        res.json({
            success: true,
            code
        });

    } catch (error) {
        console.error("Pairing error:", error.message);

        res.status(400).json({
            success: false,
            message: "Pairing request failed."
        });
    }
});

// START SERVER ONLY AFTER DATABASE IS READY
async function startServer() {
    await initDatabase();
    await startSavedSessions();

    const PORT = process.env.PORT || 3000;

    app.listen(PORT, "127.0.0.1", () => {
        console.log("👑 KING REIGNS SERVER IS RUNNING");
        console.log("http://localhost:" + PORT);
    });
}

startServer().catch(error => {
    console.error("Server startup failed:", error.message);
    process.exit(1);
});
