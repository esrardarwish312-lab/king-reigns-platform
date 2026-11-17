const session = require("express-session");
const fs = require("fs");
const path = require("path");

class FileSessionStore extends session.Store {
    constructor() {
        super();
        this.file = path.join(__dirname, "data", "sessions.json");
        fs.mkdirSync(path.dirname(this.file), { recursive: true });

        if (!fs.existsSync(this.file)) {
            fs.writeFileSync(this.file, "{}", { mode: 0o600 });
        }

        try {
            fs.chmodSync(this.file, 0o600);
        } catch (_) {}
    }

    read() {
        try {
            return JSON.parse(fs.readFileSync(this.file, "utf8"));
        } catch (_) {
            return {};
        }
    }

    write(data) {
        const temp = this.file + ".tmp";
        fs.writeFileSync(temp, JSON.stringify(data), { mode: 0o600 });
        fs.renameSync(temp, this.file);
        try {
            fs.chmodSync(this.file, 0o600);
        } catch (_) {}
    }

    get(sid, callback) {
        try {
            const data = this.read();
            const item = data[sid];

            if (!item) return callback(null, null);

            const expires = item.cookie && item.cookie.expires
                ? new Date(item.cookie.expires).getTime()
                : 0;

            if (expires && expires <= Date.now()) {
                delete data[sid];
                this.write(data);
                return callback(null, null);
            }

            callback(null, item);
        } catch (error) {
            callback(error);
        }
    }

    set(sid, sessionData, callback = () => {}) {
        try {
            const data = this.read();
            data[sid] = sessionData;
            this.write(data);
            callback(null);
        } catch (error) {
            callback(error);
        }
    }

    destroy(sid, callback = () => {}) {
        try {
            const data = this.read();
            delete data[sid];
            this.write(data);
            callback(null);
        } catch (error) {
            callback(error);
        }
    }

    touch(sid, sessionData, callback = () => {}) {
        try {
            const data = this.read();
            if (data[sid]) {
                data[sid].cookie = sessionData.cookie;
                this.write(data);
            }
            callback(null);
        } catch (error) {
            callback(error);
        }
    }
}

module.exports = FileSessionStore;
