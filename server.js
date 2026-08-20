const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { TTUGradeScraper } = require("./scraper");

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 3847);
const ROOT = __dirname;
const INDEX_FILE = path.join(ROOT, "index.html");
const OUTPUT_DIR = path.join(ROOT, "output");
const PID_FILE = path.join(ROOT, ".server.pid");
const INSTANCE_ID = `${Date.now()}-${process.pid}`;

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

let state = {
    phase: "starting",
    message: "Starting local server...",
    connected: false,
    loginRequired: false,
    busy: false,
    current: 0,
    total: 0,
    errors: 0,
    term: "",
    subject: "",
    course: "",
    latestResult: null,
    lastError: null,
    updatedAt: new Date().toISOString(),
    sessionId: INSTANCE_ID
};

function patchState(patch) {
    state = { ...state, ...patch, updatedAt: new Date().toISOString() };
}

const scraper = new TTUGradeScraper({
    outputDir: OUTPUT_DIR,
    onStatus(update) {
        patchState(update);
        if (update.message) console.log(`[scraper] ${update.message}`);
    }
});

function json(res, statusCode, data) {
    const body = JSON.stringify(data);
    res.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
    });
    res.end(body);
}

function text(res, statusCode, body, contentType = "text/plain; charset=utf-8") {
    res.writeHead(statusCode, {
        "Content-Type": contentType,
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
    });
    res.end(body);
}

async function readJSON(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) throw new Error("Request body is too large.");
        chunks.push(chunk);
    }
    if (!chunks.length) return {};
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function openDefaultBrowser(url) {
    try {
        let child;
        if (process.platform === "win32") {
            child = spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" });
        } else if (process.platform === "darwin") {
            child = spawn("open", [url], { detached: true, stdio: "ignore" });
        } else {
            child = spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
        }
        child.unref();
    } catch {
        console.log(`Open http://${HOST}:${PORT} manually.`);
    }
}

function normalizeSelectionArray(value, name) {
    if (!Array.isArray(value) || !value.length) throw new Error(`Select at least one ${name}.`);
    return value;
}

function authResponse(res, error) {
    if (error && error.code === "LOGIN_REQUIRED") {
        patchState({
            connected: false,
            loginRequired: true,
            phase: "login-required",
            message: "Texas Tech sign-in required."
        });
        json(res, 401, { error: error.message, loginRequired: true });
        return true;
    }
    return false;
}

async function handleAPI(req, res, url) {
    try {
        if (req.method === "GET" && url.pathname === "/api/status") {
            return json(res, 200, state);
        }

        if (req.method === "GET" && url.pathname === "/api/terms") {
            try {
                const terms = await scraper.getTerms();
                patchState({ connected: true, loginRequired: false, phase: state.busy ? state.phase : "ready" });
                return json(res, 200, { terms });
            } catch (error) {
                if (authResponse(res, error)) return;
                throw error;
            }
        }

        if (req.method === "POST" && url.pathname === "/api/login") {
            if (state.busy && !["login-required", "mfa", "signing-in"].includes(state.phase)) {
                return json(res, 409, { error: "The scraper is already busy." });
            }

            const body = await readJSON(req);
            const username = String(body.username || "");
            const password = String(body.password || "");

            patchState({
                busy: true,
                connected: false,
                loginRequired: false,
                phase: "signing-in",
                message: "Signing in to Texas Tech...",
                lastError: null
            });

            try {
                const terms = await scraper.login(username, password);
                patchState({
                    busy: false,
                    connected: true,
                    loginRequired: false,
                    phase: "ready",
                    message: `Connected to Cognos. Found ${terms.length} terms.`
                });
                return json(res, 200, { ok: true, terms });
            } catch (error) {
                patchState({
                    busy: false,
                    connected: false,
                    loginRequired: true,
                    phase: "login-required",
                    lastError: error.message,
                    message: error.message
                });
                return json(res, 401, { error: error.message, loginRequired: true });
            }
        }

        if (req.method === "POST" && url.pathname === "/api/subjects") {
            if (state.busy) return json(res, 409, { error: "The scraper is already busy." });
            const body = await readJSON(req);
            const terms = normalizeSelectionArray(body.terms, "term");
            patchState({ busy: true, lastError: null });
            try {
                const result = await scraper.getSubjectsForTerms(terms);
                patchState({ busy: false, phase: "ready", connected: true, loginRequired: false });
                return json(res, 200, result);
            } catch (error) {
                if (authResponse(res, error)) { patchState({ busy: false }); return; }
                patchState({ busy: false, phase: "error", lastError: error.message, message: error.message });
                return json(res, 500, { error: error.message });
            }
        }

        if (req.method === "POST" && url.pathname === "/api/courses") {
            if (state.busy) return json(res, 409, { error: "The scraper is already busy." });
            const body = await readJSON(req);
            const terms = normalizeSelectionArray(body.terms, "term");
            const subjects = normalizeSelectionArray(body.subjects, "subject");
            patchState({ busy: true, lastError: null });
            try {
                const groups = await scraper.getCoursesForSelection(terms, subjects);
                patchState({ busy: false, phase: "ready", connected: true, loginRequired: false });
                return json(res, 200, { groups });
            } catch (error) {
                if (authResponse(res, error)) { patchState({ busy: false }); return; }
                patchState({ busy: false, phase: "error", lastError: error.message, message: error.message });
                return json(res, 500, { error: error.message });
            }
        }

        if (req.method === "POST" && url.pathname === "/api/scrape") {
            if (state.busy) return json(res, 409, { error: "The scraper is already busy." });
            const body = await readJSON(req);
            const groups = normalizeSelectionArray(body.groups, "course");
            const selectedCount = groups.reduce((sum, group) => sum + (Array.isArray(group.courses) ? group.courses.length : 0), 0);
            if (!selectedCount) return json(res, 400, { error: "Select at least one course." });

            patchState({
                busy: true,
                connected: true,
                loginRequired: false,
                phase: "scraping",
                current: 0,
                total: selectedCount,
                errors: 0,
                latestResult: null,
                lastError: null,
                message: `Starting ${selectedCount} course scrape...`
            });

            scraper.scrapeGroups(groups)
                .then(result => {
                    const fileName = path.basename(result.outputPath);
                    patchState({
                        busy: false,
                        phase: "complete",
                        latestResult: `/output/${encodeURIComponent(fileName)}`,
                        result,
                        message: `Complete. ${result.jobs} courses processed.`
                    });
                })
                .catch(error => {
                    console.error(error);
                    patchState({
                        busy: false,
                        phase: error.code === "LOGIN_REQUIRED" ? "login-required" : "error",
                        loginRequired: error.code === "LOGIN_REQUIRED",
                        connected: error.code !== "LOGIN_REQUIRED" && state.connected,
                        lastError: error.message,
                        message: error.message
                    });
                });

            return json(res, 202, { ok: true, total: selectedCount });
        }

        if (req.method === "POST" && url.pathname === "/api/reconnect") {
            if (state.busy) return json(res, 409, { error: "The scraper is already busy." });
            patchState({ busy: true, connected: false, loginRequired: false, phase: "connecting", message: "Reconnecting to Cognos...", lastError: null });
            try {
                await scraper.close();
                const terms = await scraper.connect();
                if (!terms.length && scraper.loginRequired) {
                    patchState({ busy: false, connected: false, loginRequired: true, phase: "login-required", message: "Texas Tech sign-in required." });
                    return json(res, 200, { terms: [], loginRequired: true });
                }
                patchState({ busy: false, connected: true, loginRequired: false, phase: "ready" });
                return json(res, 200, { terms });
            } catch (error) {
                patchState({ busy: false, phase: "error", lastError: error.message, message: error.message });
                return json(res, 500, { error: error.message });
            }
        }

        if (req.method === "POST" && url.pathname === "/api/shutdown") {
            json(res, 200, { ok: true });
            setTimeout(shutdown, 150).unref();
            return;
        }

        return json(res, 404, { error: "API route not found." });
    } catch (error) {
        patchState({ lastError: error.message });
        return json(res, 400, { error: error.message });
    }
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);

    if (url.pathname.startsWith("/api/")) return await handleAPI(req, res, url);

    if (url.pathname === "/" || url.pathname === "/index.html") {
        try {
            return text(res, 200, fs.readFileSync(INDEX_FILE, "utf8"), "text/html; charset=utf-8");
        } catch (error) {
            return text(res, 500, `Could not load index.html: ${error.message}`);
        }
    }

    if (url.pathname.startsWith("/output/")) {
        const fileName = path.basename(decodeURIComponent(url.pathname.slice("/output/".length)));
        const filePath = path.join(OUTPUT_DIR, fileName);
        if (!fileName || !fs.existsSync(filePath)) return text(res, 404, "Result file not found.");
        const body = fs.readFileSync(filePath);
        res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Length": body.length,
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff"
        });
        res.end(body);
        return;
    }

    return text(res, 404, "Not found.");
});

server.on("error", error => {
    if (error && error.code === "EADDRINUSE") {
        console.error(`Port ${PORT} is still in use. Run start.bat again to restart the previous scraper session.`);
        process.exit(1);
    }
    throw error;
});

server.listen(PORT, HOST, () => {
    const url = `http://${HOST}:${PORT}`;
    try { fs.writeFileSync(PID_FILE, String(process.pid)); } catch {}
    console.log("======================================");
    console.log(" TTU GRADE SCRAPER V2.6");
    console.log("======================================");
    console.log(`GUI: ${url}`);
    console.log("Playwright runs headless unless a future fallback is needed.\n");

    patchState({ phase: "connecting", message: "GUI ready. Connecting to Texas Tech in the background..." });
    openDefaultBrowser(url);

    scraper.connect()
        .then(terms => {
            if (!terms.length && scraper.loginRequired) {
                patchState({
                    connected: false,
                    loginRequired: true,
                    busy: false,
                    phase: "login-required",
                    message: "Texas Tech sign-in required."
                });
                return;
            }
            patchState({
                connected: true,
                loginRequired: false,
                busy: false,
                phase: "ready",
                message: `Connected to Cognos. Found ${terms.length} terms.`
            });
        })
        .catch(error => {
            console.error(error);
            patchState({
                connected: false,
                busy: false,
                phase: "error",
                lastError: error.message,
                message: error.message
            });
        });
});

let shuttingDown = false;
async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("Closing scraper...");
    await scraper.close();
    try { fs.rmSync(PID_FILE, { force: true }); } catch {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

process.on("exit", () => {
    try {
        if (fs.existsSync(PID_FILE) && fs.readFileSync(PID_FILE, "utf8").trim() === String(process.pid)) {
            fs.rmSync(PID_FILE, { force: true });
        }
    } catch {}
});
