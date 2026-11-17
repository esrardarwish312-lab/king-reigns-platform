const fs = require("fs");
const path = require("path");

const SESSIONS_DIR = path.join(
    __dirname,
    "private",
    "sessions"
);

function getSessions() {
    if (!fs.existsSync(SESSIONS_DIR)) {
        return [];
    }

    return fs.readdirSync(SESSIONS_DIR, {
        withFileTypes: true
    })
    .filter(item => item.isDirectory())
    .map(item => ({
        phone: item.name,
        session: "Saved",
        folder: item.name
    }));
}

module.exports = { getSessions };
