const fs = require("fs");
const path = require("path");

const LOG_DIR = path.join(__dirname, "data");
const LOG_FILE = path.join(LOG_DIR, "worker-events.log");

function maskNumber(value) {
    const number = String(value || "").replace(/\D/g, "");
    return number.length > 3
        ? "*******" + number.slice(-3)
        : "HIDDEN";
}

function workerLog(event, number, details = {}) {
    try {
        fs.mkdirSync(LOG_DIR, { recursive: true });

        const safeDetails = {};
        for (const key of ["status", "code", "attempt", "delayMs"]) {
            if (details[key] !== undefined) {
                safeDetails[key] = details[key];
            }
        }

        const entry = {
            time: new Date().toISOString(),
            event: String(event),
            number: maskNumber(number),
            ...safeDetails
        };

        fs.appendFileSync(
            LOG_FILE,
            JSON.stringify(entry) + "\n",
            { mode: 0o600 }
        );

        try {
            fs.chmodSync(LOG_FILE, 0o600);
        } catch {}
    } catch (error) {
        console.error("Worker logger failed:", error.message);
    }
}

module.exports = workerLog;
