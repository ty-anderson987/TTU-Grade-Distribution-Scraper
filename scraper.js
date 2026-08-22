// Copyright 2026 Ty Anderson
// SPDX-License-Identifier: Apache-2.0

const { chromium } = require("playwright");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { termValue } = require("./schedule-engine");

const COGNOS_URL =
    "https://cognos.texastech.edu/ibmcognos/bi/?perspective=classicviewer&id=iC0E72F9A3AB64E9A9D5E54C2DB5D4643&objRef=iC0E72F9A3AB64E9A9D5E54C2DB5D4643&action=run&format=HTML&prompt=false";

const SELECT_CONTROL_CSS = "select.clsSelectControl";
const TERM_INDEX = 0;
const SUBJECT_INDEX = 1;
const COURSE_INDEX = 2;
const POLL_MS = 50;
const HISTORY_CONCURRENCY = 2;
const HISTORY_MAX_ATTEMPTS = 2;

function normalizeText(text) {
    return String(text || "")
        .replace(/\u00a0/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function escapeHTML(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function safeName(value) {
    return normalizeText(value)
        .replace(/[^a-zA-Z0-9._-]+/g, "_")
        .replace(/^_+|_+$/g, "");
}

function pollDelay() {
    return new Promise(resolve => setTimeout(resolve, POLL_MS));
}

class TTUGradeScraper {
    constructor(options = {}) {
        this.onStatus = options.onStatus || (() => {});
        this.outputDir = options.outputDir || path.join(__dirname, "output");
        this.profileDir = options.profileDir || path.join(
            os.homedir(),
            ".ttu-grade-scraper",
            "browser-profile"
        );

        this.context = null;
        this.page = null;
        this.connectPromise = null;
        this.loginRequired = false;
        this.authStep = "none";
        this.authPhone = "";
        this.headless = true;
        this.terms = [];
        this.subjectsByTerm = new Map();
        this.coursesByGroup = new Map();
        this.lastActivityAt = 0;

        fs.mkdirSync(this.outputDir, { recursive: true });
        fs.mkdirSync(this.profileDir, { recursive: true, mode: 0o700 });
        // Persistent Playwright profiles contain authenticated session cookies. Keep
        // them private to the current user on POSIX systems; Windows applies its own
        // ACLs and ignores this mode in normal use.
        if (process.platform !== "win32") {
            try { fs.chmodSync(this.profileDir, 0o700); } catch {}
        }
    }

    status(message, extra = {}) {
        this.onStatus({ message, ...extra });
    }

    touch() {
        this.lastActivityAt = Date.now();
    }

    async connect() {
        if (this.terms.length && this.context && this.page) {
            return this.terms;
        }

        // A headless browser may already be sitting on the TTU sign-in page.
        // Do not launch a second persistent context against the same profile.
        if (this.context && this.page && (this.loginRequired || this.authStep !== "none")) {
            return [];
        }

        if (this.connectPromise) {
            return await this.connectPromise;
        }

        this.connectPromise = this._connectInternal();

        try {
            return await this.connectPromise;
        } finally {
            this.connectPromise = null;
        }
    }

    async launchContext(headless = true) {
        this.headless = headless;

        this.context = await chromium.launchPersistentContext(
            this.profileDir,
            {
                headless,
                viewport: { width: 1400, height: 1000 }
            }
        );

        await this.context.route("**/*", async route => {
            const request = route.request();
            const type = request.resourceType();
            const url = request.url();

            // Keep Cognos light, but allow authentication images so a local
            // preview can still show QR codes or other verification content.
            if (type === "media" || type === "font" ||
                (type === "image" && url.includes("cognos.texastech.edu"))) {
                await route.abort();
                return;
            }

            await route.continue();
        });

        const pages = this.context.pages();
        this.page = pages.length ? pages[0] : await this.context.newPage();
    }

    async _connectInternal() {
        this.status("Connecting to Texas Tech in the background...", {
            phase: "connecting",
            connected: false,
            loginRequired: false
        });

        await this.launchContext(true);

        await this.page.goto(COGNOS_URL, {
            waitUntil: "domcontentloaded",
            timeout: 120000
        });
        this.touch();

        const auth = await this.waitForAuthState(this.page, 120000);

        if (auth.type === "login") {
            this.loginRequired = true;
            this.setAuthStep("login-required", "Texas Tech sign-in required.");
            return [];
        }

        if (auth.type === "mfa-method") {
            this.loginRequired = false;
            this.setAuthStep(
                "mfa-method",
                "Texas Tech requires identity verification. Choose how to receive the code.",
                { authPhone: auth.phone }
            );
            return [];
        }

        if (auth.type === "mfa-code") {
            this.loginRequired = false;
            this.setAuthStep("mfa-code", "Enter the Texas Tech verification code to continue.");
            return [];
        }

        return await this.finishConnection(auth.frame);
    }

    async finishConnection(frame) {
        this.terms = await this.getRealOptions(
            frame.locator(SELECT_CONTROL_CSS).nth(TERM_INDEX),
            "term"
        );

        if (!this.terms.length) {
            throw new Error("Cognos loaded, but no terms were found.");
        }

        this.loginRequired = false;
        this.authStep = "none";
        this.authPhone = "";

        this.status(`Connected. Found ${this.terms.length} terms.`, {
            phase: "ready",
            connected: true,
            loginRequired: false
        });

        return this.terms;
    }

    async detectAuthState() {
        if (!this.context) return { type: "unknown" };

        for (const currentPage of this.context.pages()) {
            for (const frame of currentPage.frames()) {
                try {
                    const selectCount = await frame.locator(SELECT_CONTROL_CSS).count();
                    if (selectCount >= 3) {
                        return { type: "ready", frame };
                    }

                    if (
                        await frame.locator("#userNameInput").count() &&
                        await frame.locator("#passwordInput").count()
                    ) {
                        const error = normalizeText(
                            await frame.locator("#errorText").textContent().catch(() => "")
                        );
                        return { type: "login", frame, error };
                    }

                    if (
                        await frame.locator("#MainContent_selectcontactmethod_rblContactMethod_1").count() &&
                        await frame.locator("#MainContent_selectcontactmethod_btnSendCode").count()
                    ) {
                        const phone = normalizeText(
                            await frame.locator("#MainContent_selectcontactmethod_lblPhone")
                                .textContent().catch(() => "")
                        );
                        const error = normalizeText(
                            await frame.locator("#MainContent_selectcontactmethod_lblErrorMessage")
                                .textContent().catch(() => "")
                        );
                        return { type: "mfa-method", frame, phone, error };
                    }

                    if (
                        await frame.locator("#MainContent_verifycode_txtToken").count() &&
                        await frame.locator("#MainContent_verifycode_btnVerifyToken").count()
                    ) {
                        const error = normalizeText(
                            await frame.locator("#MainContent_verifycode_lblErrorMessage")
                                .textContent().catch(() => "")
                        );
                        return { type: "mfa-code", frame, error };
                    }
                } catch {
                    // Authentication redirects frequently detach/rebuild frames.
                }
            }
        }

        return { type: "unknown" };
    }

    async waitForAuthState(page, timeoutMs = 120000, accepted = null) {
        const deadline = Date.now() + timeoutMs;
        const allowed = accepted ? new Set(accepted) : null;

        while (Date.now() < deadline) {
            const state = await this.detectAuthState();
            if (state.type !== "unknown" && (!allowed || allowed.has(state.type))) {
                return state;
            }
            await pollDelay();
        }

        throw new Error("Timed out waiting for Texas Tech authentication or the Cognos prompt.");
    }

    async findLoginFrame(timeoutMs = 15000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const state = await this.detectAuthState();
            if (state.type === "login") return state.frame;
            await pollDelay();
        }
        return null;
    }

    setAuthStep(step, message, extra = {}) {
        this.authStep = step;
        if (extra.authPhone !== undefined) this.authPhone = extra.authPhone || "";
        this.status(message, {
            phase: step,
            connected: false,
            loginRequired: step === "login-required",
            authStep: step,
            authPhone: this.authPhone,
            ...extra
        });
    }

    async login(username, password) {
        username = normalizeText(username);
        password = String(password || "");

        if (!username || (!username.includes("@") && !username.includes("\\"))) {
            throw new Error("Use your @ttu.edu email or a ttu\\username style account name.");
        }
        if (!password) throw new Error("Enter your Texas Tech password.");

        await this.connect();
        if (!this.loginRequired && this.terms.length) return this.terms;

        const frame = await this.findLoginFrame(15000);
        if (!frame) throw new Error("Texas Tech login form was not found. Try reconnecting.");

        this.setAuthStep("signing-in", "Signing in to Texas Tech...");
        await frame.locator("#userNameInput").fill(username);
        await frame.locator("#passwordInput").fill(password);

        // Credentials are only used for this submission and are not retained.
        username = "";
        password = "";

        const submit = frame.locator("#submitButton");
        if (!await submit.count()) throw new Error("Texas Tech Sign in button was not found.");
        await submit.click();

        this.setAuthStep("auth-check", "Credentials submitted. Checking Texas Tech authentication...");

        let auth = null;
        const authDeadline = Date.now() + 60000;
        while (Date.now() < authDeadline) {
            const candidate = await this.detectAuthState();
            if (["ready", "mfa-method", "mfa-code"].includes(candidate.type)) {
                auth = candidate;
                break;
            }
            // The original login form can remain visible while the request is
            // still in flight. Only treat it as a failure when TTU gives us
            // an actual error message.
            if (candidate.type === "login" && candidate.error) {
                auth = candidate;
                break;
            }
            await pollDelay();
        }
        if (!auth) {
            this.setAuthStep(
                "mfa-preview",
                "Texas Tech is still waiting on authentication. Use the preview if a verification page is open."
            );
            return [];
        }

        if (auth.type === "ready") {
            this.authStep = "none";
            this.authPhone = "";
            return await this.finishConnection(auth.frame);
        }

        if (auth.type === "login") {
            const message = auth.error || "Texas Tech returned to the sign-in page. Check your username and password.";
            this.loginRequired = true;
            this.setAuthStep("login-required", message);
            throw new Error(message);
        }

        if (auth.type === "mfa-method") {
            this.loginRequired = false;
            this.setAuthStep(
                "mfa-method",
                "Texas Tech requires identity verification. Choose how to receive the code.",
                { authPhone: auth.phone }
            );
            return [];
        }

        this.loginRequired = false;
        this.setAuthStep("mfa-code", "Verification code requested. Enter the code below.");
        return [];
    }

    async sendMfa(method = "sms") {
        const auth = await this.detectAuthState();
        if (auth.type === "ready") return await this.finishConnection(auth.frame);
        if (auth.type === "mfa-code") {
            this.setAuthStep("mfa-code", "Verification code requested. Enter the code below.");
            return [];
        }
        if (auth.type !== "mfa-method") {
            throw new Error("The Texas Tech verification-method page is not currently available.");
        }

        const radioSelector = method === "voice"
            ? "#MainContent_selectcontactmethod_rblContactMethod_0"
            : "#MainContent_selectcontactmethod_rblContactMethod_1";

        await auth.frame.locator(radioSelector).check();
        this.setAuthStep(
            "mfa-sending",
            method === "voice" ? "Requesting a verification call..." : "Requesting a verification text message...",
            { authPhone: auth.phone }
        );
        await auth.frame.locator("#MainContent_selectcontactmethod_btnSendCode").click();

        const deadline = Date.now() + 60000;
        while (Date.now() < deadline) {
            const next = await this.detectAuthState();
            if (next.type === "ready") return await this.finishConnection(next.frame);
            if (next.type === "mfa-code") {
                this.setAuthStep("mfa-code", "Verification code sent. Enter the code below.");
                return [];
            }
            if (next.type === "mfa-method" && next.error) {
                this.setAuthStep("mfa-method", next.error, { authPhone: next.phone });
                throw new Error(next.error);
            }
            if (next.type === "login") {
                this.loginRequired = true;
                this.setAuthStep("login-required", next.error || "Texas Tech returned to the sign-in page.");
                throw new Error(next.error || "Texas Tech returned to the sign-in page.");
            }
            await pollDelay();
        }

        this.setAuthStep("mfa-method", "Texas Tech did not reach the verification-code page. Try sending the code again.", { authPhone: auth.phone });
        throw new Error("Timed out waiting for the Texas Tech verification-code page.");
    }

    async verifyMfa(code, registerBrowser = false) {
        code = normalizeText(code);
        if (!code) throw new Error("Enter the verification code sent by Texas Tech.");

        const auth = await this.detectAuthState();
        if (auth.type === "ready") return await this.finishConnection(auth.frame);
        if (auth.type !== "mfa-code") {
            throw new Error("The Texas Tech verification-code page is not currently available.");
        }

        this.setAuthStep("mfa-verifying", "Verifying the Texas Tech code...");
        await auth.frame.locator("#MainContent_verifycode_txtToken").fill(code);
        code = "";

        const remember = auth.frame.locator("#MainContent_verifycode_chkRegisterBrowser");
        if (await remember.count()) {
            if (registerBrowser) await remember.check();
            else await remember.uncheck();
        }

        await auth.frame.locator("#MainContent_verifycode_btnVerifyToken").click();

        const deadline = Date.now() + 90000;
        while (Date.now() < deadline) {
            const next = await this.detectAuthState();
            if (next.type === "ready") {
                this.authStep = "none";
                this.authPhone = "";
                return await this.finishConnection(next.frame);
            }
            if (next.type === "mfa-code" && next.error) {
                this.setAuthStep("mfa-code", next.error);
                const error = new Error(next.error);
                error.code = "MFA_CODE_ERROR";
                throw error;
            }
            if (next.type === "mfa-method") {
                this.setAuthStep("mfa-method", next.error || "Choose a verification method again.", { authPhone: next.phone });
                return [];
            }
            if (next.type === "login") {
                this.loginRequired = true;
                this.setAuthStep("login-required", next.error || "Texas Tech returned to the sign-in page.");
                throw new Error(next.error || "Texas Tech returned to the sign-in page.");
            }
            await pollDelay();
        }

        this.setAuthStep("mfa-code", "Texas Tech is taking longer than expected to verify the code. You can retry or preview the authentication page.");
        throw new Error("Timed out waiting for Texas Tech to finish verification.");
    }

    async getAuthPreview() {
        if (!this.context) throw new Error("The authentication browser is not running.");
        const pages = this.context.pages();
        const currentPage = pages[pages.length - 1] || this.page;
        if (!currentPage) throw new Error("No Texas Tech authentication page is open.");
        return await currentPage.screenshot({ type: "png", fullPage: true });
    }

    async requireReady() {
        const terms = await this.connect();
        if (this.loginRequired || !terms.length) {
            const error = new Error("Texas Tech sign-in is required.");
            error.code = "LOGIN_REQUIRED";
            throw error;
        }
        return terms;
    }

    async keepAlive() {
        if (!this.context || !this.terms.length || this.authStep !== "none") return false;
        try {
            // Touch the visible prompt without changing the selected value, then
            // make a low-frequency authenticated request so the server-side
            // session is actually exercised.
            try {
                const frame = await this.findFormFrame(this.page, 3000);
                const term = frame.locator(SELECT_CONTROL_CSS).nth(TERM_INDEX);
                if (await term.count() && await term.isVisible().catch(() => false)) {
                    await term.click({ force: true }).catch(() => {});
                    await term.press("Escape").catch(() => {});
                }
            } catch {}
            const response = await this.context.request.get(COGNOS_URL, {
                timeout: 30000,
                failOnStatusCode: false
            });
            this.touch();
            return response.ok() || response.status() < 500;
        } catch {
            return false;
        }
    }

    async scrapeCourseHistory(courseCode, targetTerm = "", maxTerms = 6, selectedTerms = null) {
        await this.requireReady();
        const match = String(courseCode || "").toUpperCase().match(/^\s*([A-Z]{2,8})\s+(\d{3,5})\s*$/);
        if (!match) throw new Error(`Invalid course code: ${courseCode}`);
        const subjectValue = match[1];
        const courseNumber = match[2];
        const canonicalCourse = `${subjectValue} ${courseNumber}`;
        const targetValue = targetTerm ? termValue(targetTerm) : Infinity;
        const eligible = this.terms.filter(term => !targetTerm || termValue(term.text) < targetValue);

        let candidateTerms;
        if (Array.isArray(selectedTerms) && selectedTerms.length) {
            const wanted = new Set(selectedTerms.map(value => normalizeText(value)));
            candidateTerms = eligible.filter(term => wanted.has(normalizeText(term.text)));
        } else {
            candidateTerms = eligible.slice(0, Math.max(1, Number(maxTerms) || 6));
        }

        if (!candidateTerms.length) {
            throw new Error(`No eligible grade-history terms were selected for ${courseCode}.`);
        }

        // Historical grade scraping is intentionally isolated from the main Cognos tab.
        // Two worker tabs share the authenticated browser context but keep their own prompt/report
        // page state. If Cognos ever dislikes parallel report execution, each failed term is retried
        // on a fresh prompt before it is reported as unavailable.
        const workerCount = Math.max(1, Math.min(HISTORY_CONCURRENCY, candidateTerms.length));
        const pages = [];
        for (let i = 0; i < workerCount; i++) pages.push(await this.context.newPage());

        const results = new Array(candidateTerms.length);
        let nextIndex = 0;
        let completed = 0;
        let authError = null;

        const runWorker = async (page, workerIndex) => {
            while (true) {
                if (authError) return;
                const index = nextIndex++;
                if (index >= candidateTerms.length) return;
                const term = candidateTerms[index];
                this.status(`Grade history: ${canonicalCourse} — ${term.text}${workerCount > 1 ? ` (worker ${workerIndex + 1}/${workerCount})` : ""}`, {
                    phase: "schedule-grade-history",
                    course: canonicalCourse,
                    current: completed,
                    total: candidateTerms.length,
                    term: term.text,
                    workers: workerCount
                });

                try {
                    results[index] = await this.scrapeHistoricalTermWithRetry(
                        page,
                        term,
                        subjectValue,
                        courseNumber,
                        HISTORY_MAX_ATTEMPTS
                    );
                } catch (error) {
                    if (error.code === "LOGIN_REQUIRED") {
                        authError = error;
                        return;
                    }
                    results[index] = {
                        term: term.text,
                        status: "failed",
                        rows: [],
                        attempts: HISTORY_MAX_ATTEMPTS,
                        error: error.message
                    };
                } finally {
                    completed++;
                    this.status(`Grade history: ${canonicalCourse} — ${completed}/${candidateTerms.length} terms checked`, {
                        phase: "schedule-grade-history",
                        course: canonicalCourse,
                        current: completed,
                        total: candidateTerms.length,
                        workers: workerCount
                    });
                }
            }
        };

        try {
            await Promise.all(pages.map((page, index) => runWorker(page, index)));
        } finally {
            await Promise.allSettled(pages.map(page => page.close()));
        }

        if (authError) throw authError;

        const termResults = results.filter(Boolean);
        const allRows = termResults.flatMap(result => result.status === "success" ? result.rows : []);
        const usedTerms = termResults.filter(result => result.status === "success").map(result => result.term);
        const missingTerms = termResults.filter(result => result.status === "missing").map(result => result.term);
        const failedTerms = termResults.filter(result => result.status === "failed").map(result => result.term);
        this.touch();

        return {
            courseCode: canonicalCourse,
            targetTerm,
            requestedTerms: candidateTerms.map(term => term.text),
            terms: usedTerms,
            missingTerms,
            failedTerms,
            termResults,
            rows: allRows
        };
    }

    async detectAuthStateOnPage(page) {
        if (!page || page.isClosed()) return { type: "unknown" };
        for (const frame of page.frames()) {
            try {
                const selectCount = await frame.locator(SELECT_CONTROL_CSS).count();
                if (selectCount >= 3) return { type: "ready", frame };
                if (await frame.locator("#userNameInput").count() && await frame.locator("#passwordInput").count()) {
                    return { type: "login", frame };
                }
                if (await frame.locator("#MainContent_selectcontactmethod_rblContactMethod_1").count() &&
                    await frame.locator("#MainContent_selectcontactmethod_btnSendCode").count()) {
                    return { type: "mfa-method", frame };
                }
                if (await frame.locator("#MainContent_verifycode_txtToken").count() &&
                    await frame.locator("#MainContent_verifycode_btnVerifyToken").count()) {
                    return { type: "mfa-code", frame };
                }
            } catch {}
        }
        return { type: "unknown" };
    }

    async findFormFrameOnPage(page, timeoutMs = 60000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const auth = await this.detectAuthStateOnPage(page);
            if (auth.type === "ready") return auth.frame;
            if (["login", "mfa-method", "mfa-code"].includes(auth.type)) {
                const error = new Error("Texas Tech sign-in is required.");
                error.code = "LOGIN_REQUIRED";
                throw error;
            }
            await pollDelay();
        }
        throw new Error("Timed out waiting for the Cognos prompt.");
    }

    async waitForSelectReadyOnPage(page, index, kind, timeoutMs = 30000, desiredMatcher = null) {
        const deadline = Date.now() + timeoutMs;
        let lastFingerprint = "";
        let stableSince = 0;
        let latest = null;

        while (Date.now() < deadline) {
            try {
                const frame = await this.findFormFrameOnPage(page, 2000);
                const locator = frame.locator(SELECT_CONTROL_CSS).nth(index);
                if (await locator.isEnabled().catch(() => false)) {
                    const options = await this.getRealOptions(locator, kind);
                    if (options.length) {
                        latest = { frame, options };
                        if (!desiredMatcher || options.some(option => desiredMatcher(option))) return latest;

                        // Cognos can enable a dependent dropdown before its final option
                        // list has finished replacing the previous contents. Do not turn
                        // the first partial list into a definitive "course not offered".
                        // If the target never appears, wait until the option set has been
                        // unchanged for a short settle window before declaring it absent.
                        const fingerprint = JSON.stringify(options.map(option => [option.value, option.text, option.disabled]));
                        if (fingerprint !== lastFingerprint) {
                            lastFingerprint = fingerprint;
                            stableSince = Date.now();
                        } else if (stableSince && Date.now() - stableSince >= 1000) {
                            return latest;
                        }
                    }
                }
            } catch (error) {
                if (error.code === "LOGIN_REQUIRED") throw error;
            }
            await pollDelay();
        }
        if (latest) return latest;
        throw new Error(`Timed out waiting for the ${kind} dropdown.`);
    }

    async waitForFinishReadyOnPage(page, timeoutMs = 15000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            try {
                const frame = await this.findFormFrameOnPage(page, 2000);
                const candidates = [
                    frame.getByRole("button", { name: "Finish", exact: true }),
                    frame.locator('[id*="finish"]')
                ];
                for (const candidate of candidates) {
                    if (!(await candidate.count())) continue;
                    const button = candidate.first();
                    if (await button.isVisible().catch(() => false) && await button.isEnabled().catch(() => false)) return frame;
                }
            } catch (error) {
                if (error.code === "LOGIN_REQUIRED") throw error;
            }
            await pollDelay();
        }
        throw new Error("Timed out waiting for the Finish button.");
    }

    async findReportFrameOnPage(page, expectedTerm, expectedCourse, timeoutMs = 60000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const auth = await this.detectAuthStateOnPage(page);
            if (["login", "mfa-method", "mfa-code"].includes(auth.type)) {
                const error = new Error("Texas Tech sign-in is required.");
                error.code = "LOGIN_REQUIRED";
                throw error;
            }
            for (const frame of page.frames()) {
                try {
                    const found = await frame.evaluate(({ expectedTerm, expectedCourse }) => {
                        const normalize = text => String(text || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
                        const bodyText = normalize(document.body?.innerText || "");
                        const upperBody = bodyText.toUpperCase();
                        const upperCourse = String(expectedCourse || "").toUpperCase();
                        const courseNumber = (upperCourse.match(/(\d{3,5})/) || [])[1] || "";
                        const courseVisible = upperBody.includes(upperCourse) || (courseNumber && new RegExp(`\\b${courseNumber}\\b`).test(upperBody));
                        if (!bodyText.includes(expectedTerm) || !courseVisible) return false;
                        const tables = Array.from(document.querySelectorAll("table.ls"));
                        return tables.some(table => {
                            const getHeader = cid => {
                                const cell = table.querySelector(`td[type="columnTitle"][cid="${cid}"]`);
                                return cell ? normalize(cell.textContent) : "";
                            };
                            return getHeader(0).toLowerCase().includes("instructor") &&
                                getHeader(1).toLowerCase().includes("section") &&
                                getHeader(2) === "A" && getHeader(3) === "B" && getHeader(4) === "C" &&
                                getHeader(5) === "D" && getHeader(6) === "F" && getHeader(7) === "I" &&
                                getHeader(8) === "CR" && getHeader(9) === "P" && getHeader(10) === "NC" &&
                                getHeader(11) === "PR" && getHeader(12) === "W" && getHeader(13) === "O";
                        });
                    }, { expectedTerm, expectedCourse });
                    if (found) return frame;
                } catch {}
            }
            await pollDelay();
        }
        throw new Error(`Timed out waiting for ${expectedTerm} ${expectedCourse}.`);
    }

    async scrapeHistoricalTermOnce(page, term, subjectValue, courseNumber) {
        await page.goto(COGNOS_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
        let frame = await this.findFormFrameOnPage(page, 120000);
        await this.selectOption(frame, TERM_INDEX, term);

        const subjectMatcher = item => String(item.value || "").toUpperCase() === subjectValue ||
            new RegExp(`^${subjectValue}\\b`, "i").test(normalizeText(item.text));
        const subjectReady = await this.waitForSelectReadyOnPage(page, SUBJECT_INDEX, "subject", 30000, subjectMatcher);
        const subject = subjectReady.options.find(subjectMatcher);
        if (!subject) return { status: "missing", reason: "subject-not-found", rows: [] };
        await this.selectOption(subjectReady.frame, SUBJECT_INDEX, subject);

        const exactCoursePattern = new RegExp(`^${subjectValue}\\s+${courseNumber}\\b`, "i");
        const courseMatcher = item => String(item.value || "") === courseNumber || exactCoursePattern.test(normalizeText(item.text));
        const courseReady = await this.waitForSelectReadyOnPage(page, COURSE_INDEX, "course", 30000, courseMatcher);
        const course = courseReady.options.find(courseMatcher);
        if (!course) return { status: "missing", reason: "course-not-found", rows: [] };

        await this.selectOption(courseReady.frame, COURSE_INDEX, course);
        frame = await this.waitForFinishReadyOnPage(page, 15000);
        await this.clickFinish(frame);

        const canonicalCourse = `${subjectValue} ${courseNumber}`;
        const reportFrame = await this.findReportFrameOnPage(page, term.text, canonicalCourse, 60000);
        const rows = await this.waitForStableGradeRows(reportFrame);
        if (!rows.length) return { status: "empty", reason: "empty-grade-table", rows: [] };

        return {
            status: "success",
            rows: rows.map(row => ({
                ...row,
                term: term.text,
                subject: subject.text,
                course: course.text,
                courseNumber: course.value
            }))
        };
    }

    async scrapeHistoricalTermWithRetry(page, term, subjectValue, courseNumber, maxAttempts = HISTORY_MAX_ATTEMPTS) {
        const canonicalCourse = `${subjectValue} ${courseNumber}`;
        const baseAttempts = Math.max(2, Number(maxAttempts) || HISTORY_MAX_ATTEMPTS);
        const ambiguousMaxAttempts = Math.max(baseAttempts + 1, 3);
        const missingReasons = [];
        let last = null;
        let attempt = 0;

        while (attempt < ambiguousMaxAttempts) {
            attempt++;
            try {
                const result = await this.scrapeHistoricalTermOnce(page, term, subjectValue, courseNumber);
                last = result;
                if (result.status === "success") {
                    return { term: term.text, status: "success", rows: result.rows, attempts: attempt, error: "" };
                }

                const reason = result.reason || result.status || "empty";
                missingReasons.push(reason);
                const confirmations = missingReasons.filter(value => value === reason).length;
                if (confirmations >= 2) {
                    return { term: term.text, status: "missing", rows: [], attempts: attempt, reason, negativeVerification: "same-reason-v2", error: "" };
                }

                const normalRetryRemaining = attempt < baseAttempts;
                const ambiguousRetry = attempt >= baseAttempts && attempt < ambiguousMaxAttempts;
                if (normalRetryRemaining || ambiguousRetry) {
                    this.status(ambiguousRetry
                        ? `Grade history: ${canonicalCourse} — ${term.text} returned inconsistent empty results; making one final fresh Cognos check...`
                        : `Grade history: ${canonicalCourse} — ${term.text} returned no rows; retrying on a fresh Cognos prompt...`, {
                        phase: "schedule-grade-history-retry",
                        course: canonicalCourse,
                        term: term.text,
                        attempt: attempt + 1,
                        maxAttempts: ambiguousRetry ? ambiguousMaxAttempts : baseAttempts
                    });
                    await pollDelay();
                    continue;
                }
            } catch (error) {
                if (error.code === "LOGIN_REQUIRED") throw error;
                last = { status: "failed", reason: "request-error", error: error.message };

                // A missing result followed by a transient request failure (or the reverse)
                // is not enough evidence to permanently cache "no history". Spend one
                // tiebreaker attempt before returning an unverified failure.
                const canRetry = attempt < baseAttempts || (attempt < ambiguousMaxAttempts && missingReasons.length > 0);
                if (canRetry) {
                    this.status(`Grade history: ${canonicalCourse} — ${term.text} failed (${error.message}); retrying on a fresh Cognos prompt...`, {
                        phase: "schedule-grade-history-retry",
                        course: canonicalCourse,
                        term: term.text,
                        attempt: attempt + 1,
                        maxAttempts: missingReasons.length ? ambiguousMaxAttempts : baseAttempts
                    });
                    await pollDelay();
                    continue;
                }
                return { term: term.text, status: "failed", rows: [], attempts: attempt, error: error.message };
            }
        }

        // If three fresh attempts disagree, fail open: surface the term as unverified
        // and do not put a false negative into the persistent per-term cache.
        const reasonSummary = missingReasons.length ? ` Conflicting empty states: ${[...new Set(missingReasons)].join(", ")}.` : "";
        return {
            term: term.text,
            status: "failed",
            rows: [],
            attempts: attempt,
            error: `${last?.error || "Cognos did not produce a stable grade-history result."}${reasonSummary}`.trim()
        };
    }

    async close() {
        if (this.context) {
            try {
                await this.context.close();
            } catch {}
        }

        this.context = null;
        this.page = null;
        this.connectPromise = null;
        this.loginRequired = false;
        this.authStep = "none";
        this.authPhone = "";
        this.terms = [];
    }

    async getTerms() {
        await this.requireReady();
        return this.terms;
    }

    async getSubjectsForTerms(terms) {
        await this.requireReady();

        const byTerm = [];
        const union = new Map();

        for (let i = 0; i < terms.length; i++) {
            const term = terms[i];
            const cacheKey = term.text;

            this.status(`Loading subjects for ${term.text}...`, {
                phase: "loading-subjects",
                current: i + 1,
                total: terms.length
            });

            let subjects = this.subjectsByTerm.get(cacheKey);

            if (!subjects) {
                const frame = await this.openFreshPrompt();
                await this.selectOption(frame, TERM_INDEX, term);

                const ready = await this.waitForSelectReady(
                    this.page,
                    SUBJECT_INDEX,
                    "subject",
                    30000
                );

                subjects = ready.options;
                this.subjectsByTerm.set(cacheKey, subjects);
            }

            byTerm.push({ term, subjects });

            for (const subject of subjects) {
                const key = normalizeText(subject.text).toLowerCase();
                if (!union.has(key)) {
                    union.set(key, {
                        text: subject.text,
                        availableTerms: []
                    });
                }
                union.get(key).availableTerms.push(term.text);
            }
        }

        const subjects = Array.from(union.values()).sort((a, b) =>
            a.text.localeCompare(b.text)
        );

        this.status(`Loaded ${subjects.length} unique subjects.`, {
            phase: "ready",
            connected: true
        });

        return { byTerm, subjects };
    }

    async getCoursesForSelection(terms, subjectNames) {
        await this.requireReady();

        const groups = [];
        const combinations = [];

        for (const term of terms) {
            let subjects = this.subjectsByTerm.get(term.text);
            if (!subjects) {
                const subjectResult = await this.getSubjectsForTerms([term]);
                subjects = subjectResult.byTerm[0].subjects;
            }

            for (const subjectName of subjectNames) {
                const subject = subjects.find(
                    item => normalizeText(item.text) === normalizeText(subjectName)
                );

                if (subject) {
                    combinations.push({ term, subject });
                }
            }
        }

        for (let i = 0; i < combinations.length; i++) {
            const { term, subject } = combinations[i];
            const key = this.groupKey(term, subject);

            this.status(`Loading courses: ${term.text} — ${subject.text}`, {
                phase: "loading-courses",
                current: i + 1,
                total: combinations.length
            });

            let courses = this.coursesByGroup.get(key);

            if (!courses) {
                const frame = await this.openFreshPrompt();
                await this.selectOption(frame, TERM_INDEX, term);

                const subjectReady = await this.waitForSelectReady(
                    this.page,
                    SUBJECT_INDEX,
                    "subject",
                    30000
                );

                const currentSubject = subjectReady.options.find(
                    option =>
                        option.value === subject.value ||
                        normalizeText(option.text) === normalizeText(subject.text)
                );

                if (!currentSubject) {
                    continue;
                }

                await this.selectOption(subjectReady.frame, SUBJECT_INDEX, currentSubject);

                const courseReady = await this.waitForSelectReady(
                    this.page,
                    COURSE_INDEX,
                    "course",
                    30000
                );

                courses = courseReady.options;
                this.coursesByGroup.set(key, courses);
            }

            groups.push({
                id: key,
                term,
                subject,
                courses
            });
        }

        this.status(`Loaded courses for ${groups.length} term/subject groups.`, {
            phase: "ready",
            connected: true
        });

        return groups;
    }

    async scrapeGroups(groups, progressCallback = () => {}) {
        await this.requireReady();

        const jobs = [];
        for (const group of groups) {
            for (const course of group.courses || []) {
                jobs.push({ term: group.term, subject: group.subject, course });
            }
        }
        if (!jobs.length) throw new Error("No courses were selected.");

        // The standalone Grade Scraper now uses the same conservative two-way Cognos
        // parallelism as Schedule Analyzer grade history. Each worker owns an isolated
        // page so term/subject/course selections cannot overwrite the other worker.
        const workerCount = Math.max(1, Math.min(HISTORY_CONCURRENCY, jobs.length));
        const pages = [];
        for (let i = 0; i < workerCount; i++) pages.push(await this.context.newPage());

        const resultsByJob = new Array(jobs.length);
        let nextIndex = 0;
        let completed = 0;
        let errors = 0;
        let authError = null;

        const runWorker = async (page, workerIndex) => {
            while (true) {
                if (authError) return;
                const index = nextIndex++;
                if (index >= jobs.length) return;
                const job = jobs[index];
                const workerLabel = workerCount > 1 ? ` (worker ${workerIndex + 1}/${workerCount})` : "";
                const progress = {
                    current: completed,
                    total: jobs.length,
                    term: job.term.text,
                    subject: job.subject.text,
                    course: job.course.text,
                    errors,
                    workers: workerCount
                };

                this.status(`Scraping ${job.term.text} — ${job.course.text}${workerLabel}...`, { phase: "scraping", ...progress });
                progressCallback(progress);

                try {
                    resultsByJob[index] = await this.scrapeOneCourseOnPageWithRetry(
                        page, job.term, job.subject, job.course, 2
                    );
                } catch (error) {
                    if (error.code === "LOGIN_REQUIRED") {
                        authError = error;
                        return;
                    }
                    errors++;
                    resultsByJob[index] = [{
                        rowType: "error",
                        term: job.term.text,
                        subject: job.subject.text,
                        course: job.course.text,
                        courseNumber: job.course.value,
                        instructor: "ERROR",
                        section: "",
                        A: 0, B: 0, C: 0, D: 0, F: 0, I: 0, CR: 0, P: 0, NC: 0, PR: 0, W: 0, O: 0,
                        error: error.message
                    }];
                    this.status(`Error on ${job.term.text} — ${job.course.text}: ${error.message}`, {
                        phase: "scraping", ...progress, errors
                    });
                } finally {
                    completed++;
                    this.status(`Grade scrape: ${completed}/${jobs.length} courses processed${workerCount > 1 ? ` with ${workerCount} Cognos workers` : ""}.`, {
                        phase: "scraping",
                        current: completed,
                        total: jobs.length,
                        errors,
                        workers: workerCount
                    });
                    progressCallback({ current: completed, total: jobs.length, errors, workers: workerCount });
                }
            }
        };

        try {
            await Promise.all(pages.map((page, index) => runWorker(page, index)));
        } finally {
            await Promise.allSettled(pages.map(page => page.close()));
        }

        if (authError) throw authError;
        const allResults = resultsByJob.flatMap(rows => Array.isArray(rows) ? rows : []);
        const outputPath = this.generateHTML(allResults);
        const dataRows = allResults.filter(row => row.rowType === "data").length;

        this.status(`Complete. ${jobs.length} courses processed, ${dataRows} grade rows, ${errors} errors.`, {
            phase: "complete",
            current: jobs.length,
            total: jobs.length,
            errors,
            outputPath
        });

        return { outputPath, jobs: jobs.length, rows: allResults.length, dataRows, errors, cognosWorkers: workerCount };
    }

    groupKey(term, subject) {
        return `${term.text}::${subject.text}`;
    }

    async openFreshPrompt() {
        await this.requireReady();

        await this.page.goto(COGNOS_URL, {
            waitUntil: "domcontentloaded",
            timeout: 120000
        });

        return await this.findFormFrame(this.page, 120000);
    }

    async findFormFrame(page, timeoutMs = 60000) {
        const deadline = Date.now() + timeoutMs;

        while (Date.now() < deadline) {
            const pages = page.context().pages();

            for (const currentPage of pages) {
                for (const frame of currentPage.frames()) {
                    try {
                        const count = await frame.locator(SELECT_CONTROL_CSS).count();
                        if (count >= 3) {
                            return frame;
                        }
                    } catch {}
                }
            }

            await pollDelay();
        }

        throw new Error("Timed out waiting for the Cognos prompt.");
    }

    async getOptions(locator) {
        return await locator.evaluate(select => {
            const normalize = text =>
                String(text || "")
                    .replace(/\u00a0/g, " ")
                    .replace(/\s+/g, " ")
                    .trim();

            return Array.from(select.options).map(option => ({
                value: String(option.value || "").trim(),
                text: normalize(option.getAttribute("dv") || option.textContent),
                disabled: option.disabled
            }));
        });
    }

    async getRealOptions(locator, kind) {
        const options = await this.getOptions(locator);

        return options.filter(option => {
            if (!option.value || !option.text || option.disabled) {
                return false;
            }

            const lower = option.text.toLowerCase();
            return !lower.includes(`select a ${kind}`) &&
                !lower.includes(`select ${kind}`);
        });
    }

    async selectOption(frame, index, option) {
        const locator = frame.locator(SELECT_CONTROL_CSS).nth(index);
        const options = await this.getOptions(locator);

        const match = options.find(item => item.value === option.value) ||
            options.find(item => normalizeText(item.text) === normalizeText(option.text));

        if (!match) {
            throw new Error(`Could not find "${option.text}" in Cognos dropdown.`);
        }

        await locator.selectOption({ value: match.value });
    }

    async waitForSelectReady(page, index, kind, timeoutMs = 30000, desired = null) {
        const deadline = Date.now() + timeoutMs;

        while (Date.now() < deadline) {
            try {
                const frame = await this.findFormFrame(page, 2000);
                const locator = frame.locator(SELECT_CONTROL_CSS).nth(index);

                if (await locator.isEnabled().catch(() => false)) {
                    const options = await this.getRealOptions(locator, kind);

                    if (options.length) {
                        if (!desired) {
                            return { frame, options };
                        }

                        const found = options.some(option =>
                            option.value === desired.value ||
                            normalizeText(option.text) === normalizeText(desired.text)
                        );

                        if (found) {
                            return { frame, options };
                        }
                    }
                }
            } catch {}

            await pollDelay();
        }

        throw new Error(`Timed out waiting for the ${kind} dropdown.`);
    }

    async waitForFinishReady(page, timeoutMs = 15000) {
        const deadline = Date.now() + timeoutMs;

        while (Date.now() < deadline) {
            try {
                const frame = await this.findFormFrame(page, 2000);
                const candidates = [
                    frame.getByRole("button", { name: "Finish", exact: true }),
                    frame.locator('[id*="finish"]')
                ];

                for (const candidate of candidates) {
                    if (!(await candidate.count())) {
                        continue;
                    }

                    const button = candidate.first();
                    const visible = await button.isVisible().catch(() => false);
                    const enabled = await button.isEnabled().catch(() => false);

                    if (visible && enabled) {
                        return frame;
                    }
                }
            } catch {}

            await pollDelay();
        }

        throw new Error("Timed out waiting for the Finish button.");
    }

    async clickFinish(frame) {
        const candidates = [
            frame.getByRole("button", { name: "Finish", exact: true }),
            frame.getByText("Finish", { exact: true }),
            frame.locator("[title='Finish']"),
            frame.locator('[id*="finish"]')
        ];

        for (const candidate of candidates) {
            try {
                if (!(await candidate.count())) {
                    continue;
                }

                const button = candidate.first();
                if (!(await button.isVisible()) || !(await button.isEnabled())) {
                    continue;
                }

                await button.click();
                return;
            } catch {}
        }

        throw new Error("Could not click the Cognos Finish button.");
    }

    async scrapeOneCourseOnPage(page, term, subject, course) {
        await page.goto(COGNOS_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
        let frame = await this.findFormFrameOnPage(page, 120000);
        await this.selectOption(frame, TERM_INDEX, term);

        const subjectMatcher = item => item.value === subject.value ||
            normalizeText(item.text) === normalizeText(subject.text);
        const subjectReady = await this.waitForSelectReadyOnPage(page, SUBJECT_INDEX, "subject", 30000, subjectMatcher);
        const selectedSubject = subjectReady.options.find(subjectMatcher);
        if (!selectedSubject) throw new Error(`Could not find "${subject.text}" in Cognos for ${term.text}.`);
        await this.selectOption(subjectReady.frame, SUBJECT_INDEX, selectedSubject);

        const courseMatcher = item => item.value === course.value ||
            normalizeText(item.text) === normalizeText(course.text);
        const courseReady = await this.waitForSelectReadyOnPage(page, COURSE_INDEX, "course", 30000, courseMatcher);
        const selectedCourse = courseReady.options.find(courseMatcher);
        if (!selectedCourse) throw new Error(`Could not find "${course.text}" in Cognos for ${term.text}.`);
        await this.selectOption(courseReady.frame, COURSE_INDEX, selectedCourse);

        frame = await this.waitForFinishReadyOnPage(page, 15000);
        await this.clickFinish(frame);
        const reportFrame = await this.findReportFrameOnPage(page, term.text, course.text, 60000);
        const rows = await this.waitForStableGradeRows(reportFrame);
        this.touch();
        return rows.map(row => ({
            ...row,
            term: term.text,
            subject: subject.text,
            course: course.text,
            courseNumber: course.value
        }));
    }

    async scrapeOneCourseOnPageWithRetry(page, term, subject, course, maxAttempts = 2) {
        const attempts = Math.max(1, Number(maxAttempts) || 2);
        let lastError = null;
        let emptyReads = 0;
        for (let attempt = 1; attempt <= attempts; attempt++) {
            try {
                const rows = await this.scrapeOneCourseOnPage(page, term, subject, course);
                if (rows.length) return rows;
                emptyReads++;
                if (emptyReads >= 2 || attempt >= attempts) return rows;
                this.status(`Grade scrape: ${term.text} — ${course.text} returned an empty table; retrying once on a fresh Cognos prompt...`, {
                    phase: "scraping-retry", term: term.text, course: course.text, attempt: attempt + 1, maxAttempts: attempts
                });
            } catch (error) {
                if (error.code === "LOGIN_REQUIRED") throw error;
                lastError = error;
                if (attempt >= attempts) throw error;
                this.status(`Grade scrape: ${term.text} — ${course.text} failed (${error.message}); retrying once on a fresh Cognos prompt...`, {
                    phase: "scraping-retry", term: term.text, course: course.text, attempt: attempt + 1, maxAttempts: attempts
                });
            }
            await pollDelay();
        }
        if (lastError) throw lastError;
        return [];
    }

    async scrapeOneCourse(term, subject, course) {
        return await this.scrapeOneCourseOnPageWithRetry(this.page, term, subject, course, 2);
    }

    async findReportFrame(page, expectedTerm, expectedCourse, timeoutMs = 60000) {
        const deadline = Date.now() + timeoutMs;

        while (Date.now() < deadline) {
            const pages = page.context().pages();

            for (const currentPage of pages) {
                for (const frame of currentPage.frames()) {
                    try {
                        const found = await frame.evaluate(
                            ({ expectedTerm, expectedCourse }) => {
                                const normalize = text =>
                                    String(text || "")
                                        .replace(/\u00a0/g, " ")
                                        .replace(/\s+/g, " ")
                                        .trim();

                                const bodyText = normalize(document.body?.innerText || "");

                                if (!bodyText.includes(expectedTerm) || !bodyText.includes(expectedCourse)) {
                                    return false;
                                }

                                const tables = Array.from(document.querySelectorAll("table.ls"));

                                for (const table of tables) {
                                    const getHeader = cid => {
                                        const cell = table.querySelector(
                                            `td[type="columnTitle"][cid="${cid}"]`
                                        );
                                        return cell ? normalize(cell.textContent) : "";
                                    };

                                    if (
                                        getHeader(0).toLowerCase().includes("instructor") &&
                                        getHeader(1).toLowerCase().includes("section") &&
                                        getHeader(2) === "A" &&
                                        getHeader(3) === "B" &&
                                        getHeader(4) === "C" &&
                                        getHeader(5) === "D" &&
                                        getHeader(6) === "F" &&
                                        getHeader(7) === "I" &&
                                        getHeader(8) === "CR" &&
                                        getHeader(9) === "P" &&
                                        getHeader(10) === "NC" &&
                                        getHeader(11) === "PR" &&
                                        getHeader(12) === "W" &&
                                        getHeader(13) === "O"
                                    ) {
                                        return true;
                                    }
                                }

                                return false;
                            },
                            { expectedTerm, expectedCourse }
                        );

                        if (found) {
                            return frame;
                        }
                    } catch {}
                }
            }

            await pollDelay();
        }

        throw new Error(`Timed out waiting for ${expectedTerm} ${expectedCourse}.`);
    }

    async waitForStableGradeRows(frame, timeoutMs = 5000) {
        // Cognos can paint the report header a little before its data rows. Treating
        // that intermediate DOM as a real empty report was one source of false
        // "No grade history" results. Give the table a short grace period and require
        // two matching non-empty reads before accepting it. Genuine course-not-found
        // cases return earlier and do not pay this delay.
        const deadline = Date.now() + Math.max(300, Number(timeoutMs) || 5000);
        let lastFingerprint = "";
        let stableReads = 0;
        let lastRows = [];
        while (Date.now() < deadline) {
            const rows = await this.extractGradeTable(frame);
            if (rows.length) {
                const fingerprint = JSON.stringify(rows);
                if (fingerprint === lastFingerprint) stableReads++;
                else {
                    lastFingerprint = fingerprint;
                    stableReads = 1;
                }
                lastRows = rows;
                if (stableReads >= 2) return rows;
            } else {
                lastFingerprint = "";
                stableReads = 0;
            }
            await new Promise(resolve => setTimeout(resolve, 120));
        }
        return lastRows;
    }

    async extractGradeTable(frame) {
        return await frame.evaluate(() => {
            const normalize = text =>
                String(text || "")
                    .replace(/\u00a0/g, " ")
                    .replace(/\s+/g, " ")
                    .trim();

            const getNumber = cell => {
                if (!cell) {
                    return 0;
                }

                const value = Number(normalize(cell.textContent).replace(/,/g, ""));
                return Number.isFinite(value) ? value : 0;
            };

            const tables = Array.from(document.querySelectorAll("table.ls"));
            let gradeTable = null;

            for (const table of tables) {
                const getHeader = cid => {
                    const cell = table.querySelector(
                        `td[type="columnTitle"][cid="${cid}"]`
                    );
                    return cell ? normalize(cell.textContent) : "";
                };

                if (
                    getHeader(0).toLowerCase().includes("instructor") &&
                    getHeader(1).toLowerCase().includes("section") &&
                    getHeader(2) === "A" &&
                    getHeader(3) === "B" &&
                    getHeader(4) === "C" &&
                    getHeader(5) === "D" &&
                    getHeader(6) === "F" &&
                    getHeader(7) === "I" &&
                    getHeader(8) === "CR" &&
                    getHeader(9) === "P" &&
                    getHeader(10) === "NC" &&
                    getHeader(11) === "PR" &&
                    getHeader(12) === "W" &&
                    getHeader(13) === "O"
                ) {
                    gradeTable = table;
                    break;
                }
            }

            if (!gradeTable) {
                return [];
            }

            const rows = Array.from(gradeTable.querySelectorAll("tr"));
            const results = [];
            let lastInstructor = "";

            for (const row of rows) {
                const dataCells = row.querySelectorAll('td[type="datavalue"]');

                if (dataCells.length) {
                    const instructorCell = row.querySelector('td[type="datavalue"][cid="0"]');
                    let instructor = instructorCell ? normalize(instructorCell.textContent) : "";

                    if (instructor) {
                        lastInstructor = instructor;
                    } else {
                        instructor = lastInstructor;
                    }

                    const sectionCell = row.querySelector('td[type="datavalue"][cid="1"]');
                    const section = sectionCell ? normalize(sectionCell.textContent) : "";

                    results.push({
                        rowType: "data",
                        instructor,
                        section,
                        A: getNumber(row.querySelector('td[type="datavalue"][cid="2"]')),
                        B: getNumber(row.querySelector('td[type="datavalue"][cid="3"]')),
                        C: getNumber(row.querySelector('td[type="datavalue"][cid="4"]')),
                        D: getNumber(row.querySelector('td[type="datavalue"][cid="5"]')),
                        F: getNumber(row.querySelector('td[type="datavalue"][cid="6"]')),
                        I: getNumber(row.querySelector('td[type="datavalue"][cid="7"]')),
                        CR: getNumber(row.querySelector('td[type="datavalue"][cid="8"]')),
                        P: getNumber(row.querySelector('td[type="datavalue"][cid="9"]')),
                        NC: getNumber(row.querySelector('td[type="datavalue"][cid="10"]')),
                        PR: getNumber(row.querySelector('td[type="datavalue"][cid="11"]')),
                        W: getNumber(row.querySelector('td[type="datavalue"][cid="12"]')),
                        O: getNumber(row.querySelector('td[type="datavalue"][cid="13"]'))
                    });
                    continue;
                }

                const summaryCells = row.querySelectorAll('td[type="summary"]');

                if (summaryCells.length) {
                    const totalLabel = row.querySelector('td[type="summary"][cid="0"]');

                    if (
                        totalLabel &&
                        normalize(totalLabel.textContent).toLowerCase().includes("total")
                    ) {
                        results.push({
                            rowType: "summary",
                            instructor: "Total",
                            section: "",
                            A: getNumber(row.querySelector('td[type="summary"][cid="2"]')),
                            B: getNumber(row.querySelector('td[type="summary"][cid="3"]')),
                            C: getNumber(row.querySelector('td[type="summary"][cid="4"]')),
                            D: getNumber(row.querySelector('td[type="summary"][cid="5"]')),
                            F: getNumber(row.querySelector('td[type="summary"][cid="6"]')),
                            I: getNumber(row.querySelector('td[type="summary"][cid="7"]')),
                            CR: getNumber(row.querySelector('td[type="summary"][cid="8"]')),
                            P: getNumber(row.querySelector('td[type="summary"][cid="9"]')),
                            NC: getNumber(row.querySelector('td[type="summary"][cid="10"]')),
                            PR: getNumber(row.querySelector('td[type="summary"][cid="11"]')),
                            W: getNumber(row.querySelector('td[type="summary"][cid="12"]')),
                            O: getNumber(row.querySelector('td[type="summary"][cid="13"]'))
                        });
                    }
                }
            }

            return results;
        });
    }

    generateHTML(results) {
        const outputFile = "TTU_grade_distribution.html";
        const outputPath = path.join(this.outputDir, outputFile);
        const templatePath = path.join(__dirname, "analytics-template.html");
        const compareOutputPath = path.join(this.outputDir, "TTU_professor_compare.html");
        const compareTemplatePath = path.join(__dirname, "compare-template.html");

        const safeJSON = value => JSON.stringify(value)
            .replace(/</g, "\\u003c")
            .replace(/>/g, "\\u003e")
            .replace(/&/g, "\\u0026");

        const dataJSON = safeJSON(results.filter(row => row.rowType === "data"));
        const allRowsJSON = safeJSON(results);

        let html = fs.readFileSync(templatePath, "utf8");
        html = html.replace("__DATA_JSON__", dataJSON);
        html = html.replace("__ALL_ROWS_JSON__", allRowsJSON);

        fs.writeFileSync(outputPath, html, "utf8");

        if (fs.existsSync(compareTemplatePath)) {
            let compareHTML = fs.readFileSync(compareTemplatePath, "utf8");
            compareHTML = compareHTML.replace("__DATA_JSON__", dataJSON);
            fs.writeFileSync(compareOutputPath, compareHTML, "utf8");
        }

        return outputPath;
    }

}

module.exports = {
    TTUGradeScraper,
    COGNOS_URL,
    normalizeText,
    safeName
};
