// Copyright 2026 Ty Anderson
// SPDX-License-Identifier: Apache-2.0

const fs = require("fs");
const path = require("path");

const CACHE_VERSION = 8;

class CacheStore {
    constructor(filePath) {
        this.filePath = filePath;
        this.data = { version: CACHE_VERSION, courses: {} };
        fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
        if (process.platform !== "win32") {
            try { fs.chmodSync(path.dirname(filePath), 0o700); } catch {}
        }
        this.load();
    }

    load() {
        try {
            if (!fs.existsSync(this.filePath)) return;
            const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
            if (parsed && typeof parsed === "object") {
                // V3.0 cache schema 8 adds progressive timetable loading: a fast provisional
                // schedule can be used immediately while a full semester verification pass replaces it
                // in the background. Older captures do not carry the scan-completion guarantees.
                if (Number(parsed.version) !== CACHE_VERSION) {
                    console.log(`[cache] Ignoring cache schema ${parsed.version ?? "unknown"}; V${CACHE_VERSION} will rebuild exact course data.`);
                    this.data = { version: CACHE_VERSION, courses: {} };
                    return;
                }
                this.data = {
                    version: CACHE_VERSION,
                    courses: parsed.courses && typeof parsed.courses === "object" ? parsed.courses : {}
                };
            }
        } catch (error) {
            console.warn(`[cache] Ignoring unreadable cache: ${error.message}`);
        }
    }

    key(term, courseCode) {
        return `${String(term || "").trim()}::${String(courseCode || "").trim().toUpperCase()}`;
    }

    get(term, courseCode) {
        return this.data.courses[this.key(term, courseCode)] || null;
    }

    set(term, courseCode, value) {
        const key = this.key(term, courseCode);
        this.data.courses[key] = {
            ...value,
            term,
            courseCode: String(courseCode || "").trim().toUpperCase(),
            cachedAt: new Date().toISOString()
        };
        this.save();
        return this.data.courses[key];
    }

    save() {
        const temp = `${this.filePath}.tmp`;
        fs.writeFileSync(temp, JSON.stringify(this.data, null, 2), { encoding: "utf8", mode: 0o600 });
        if (process.platform !== "win32") {
            try { fs.chmodSync(temp, 0o600); } catch {}
        }
        fs.renameSync(temp, this.filePath);
    }
}

module.exports = { CacheStore };
