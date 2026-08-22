// Copyright 2026 Ty Anderson
// SPDX-License-Identifier: Apache-2.0

const { chromium } = require("playwright");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { normalizeCourseCode } = require("./schedule-engine");

const SCHEDULE_URL = "https://schedulebuilder.ttu.edu/vsb/";
const POLL_MS = 75;

function normalizeText(text) {
    return String(text || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function delay(ms = POLL_MS) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function installScheduleResourceRouting(context) {
    if (!context || typeof context.route !== "function") return;
    await context.route("**/*", async route => {
        const request = route.request();
        const type = request.resourceType();
        const url = request.url();
        let host = "";
        try { host = new URL(url).hostname.toLowerCase(); } catch {}

        // Keep VSB images. Some Schedule Builder controls (including remove/trash UI on
        // enrolled-course rows) are image-backed, so blocking images can collapse or hide
        // interactive hit targets and make an otherwise valid course impossible to clear.
        // Fonts/media are nonessential and remain blocked to keep the five-session setup lean.
        if (type === "media" || type === "font") {
            await route.abort().catch(() => {});
            return;
        }
        await route.continue().catch(() => {});
    });
}

function weekStartFromLabel(label) {
    const text = normalizeText(label);
    const match = text.match(/^([A-Za-z]+)\s+\d{1,2}\s*-\s*(?:([A-Za-z]+)\s+)?(\d{1,2}),\s*(20\d{2})$/);
    if (!match) return null;
    const months = {
        january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
        july: 6, august: 7, september: 8, october: 9, november: 10, december: 11
    };
    const endMonthName = (match[2] || match[1]).toLowerCase();
    const month = months[endMonthName];
    if (month === undefined) return null;
    const end = Date.UTC(Number(match[4]), month, Number(match[3]));
    if (!Number.isFinite(end)) return null;
    return end - 6 * 24 * 60 * 60 * 1000;
}

function isoDateUTC(ms) {
    return new Date(ms).toISOString().slice(0, 10);
}

function minutesToClock(minutes) {
    minutes = Math.max(0, Math.min(24 * 60 - 1, Math.round(Number(minutes) / 5) * 5));
    const hour24 = Math.floor(minutes / 60);
    const minute = minutes % 60;
    const suffix = hour24 >= 12 ? "PM" : "AM";
    const hour = hour24 % 12 || 12;
    return `${hour}:${String(minute).padStart(2, "0")} ${suffix}`;
}

function sundayForIso(iso) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ""))) return "";
    const d = new Date(`${iso}T00:00:00Z`);
    if (!Number.isFinite(d.getTime())) return "";
    d.setUTCDate(d.getUTCDate() - d.getUTCDay());
    return d.toISOString().slice(0, 10);
}

function addIsoDays(iso, days) {
    const d = new Date(`${iso}T00:00:00Z`);
    if (!Number.isFinite(d.getTime())) return "";
    d.setUTCDate(d.getUTCDate() + Number(days || 0));
    return d.toISOString().slice(0, 10);
}

function buildSessionWeeks(startIso, endIso) {
    const first = sundayForIso(startIso);
    const last = sundayForIso(endIso);
    if (!first || !last || first > last) return [];
    const weeks = [];
    let current = first;
    for (let guard = 0; guard < 32 && current <= last; guard++) {
        weeks.push({
            weekStart: current,
            label: `${current} - ${addIsoDays(current, 6)}`,
            source: "session-range"
        });
        current = addIsoDays(current, 7);
    }
    return weeks;
}

function mergeOccurrenceLists(...lists) {
    const seen = new Set();
    const merged = [];
    for (const list of lists) {
        for (const item of Array.isArray(list) ? list : []) {
            const key = `${item.date || ""}|${item.start || ""}|${item.end || ""}`;
            if (!item.date || seen.has(key)) continue;
            seen.add(key);
            merged.push({ ...item });
        }
    }
    merged.sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")) || String(a.start || "").localeCompare(String(b.start || "")));
    return merged;
}

function sectionKind(section) {
    const text = normalizeText(section);
    if (/^no\s+credit\b/i.test(text)) return /lab/i.test(text) ? "No Credit Lab" : "No Credit";
    if (/^(lec|lecture)\b/i.test(text)) return "Lecture";
    if (/^(lab|laboratory)\b/i.test(text)) return "Lab";
    if (/^(dis|disc|dsc|discussion)\b/i.test(text)) return "Discussion";
    if (/^(rec|recitation)\b/i.test(text)) return "Recitation";
    if (/^(sem|seminar)\b/i.test(text)) return "Seminar";
    return text || "Meeting";
}

function expandRecurringWithTermCalendar(components, termCalendar, sessionStart, sessionEnd) {
    if (!termCalendar?.complete || !Array.isArray(termCalendar.weeks) || !termCalendar.weeks.length) return [];
    const offsets = { M: 1, T: 2, W: 3, R: 4, F: 5, S: 6, U: 0 };
    const holidays = new Set(termCalendar.holidayDates || []);
    const out = [];
    const seen = new Set();
    for (const component of components || []) {
        for (const meeting of component.meetings || []) {
            for (const day of meeting.days || []) {
                if (!(day in offsets)) continue;
                for (const week of termCalendar.weeks) {
                    const date = addIsoDays(week.weekStart, offsets[day]);
                    if (!date) continue;
                    if (sessionStart && date < sessionStart) continue;
                    if (sessionEnd && date > sessionEnd) continue;
                    if (holidays.has(date)) continue;
                    const key = `${date}|${meeting.start}|${meeting.end}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    out.push({
                        date,
                        day,
                        start: meeting.start,
                        end: meeting.end,
                        kind: sectionKind(component.section),
                        section: component.section || "",
                        online: Boolean(component.online),
                        special: false,
                        source: "vsb-legend+term-calendar"
                    });
                }
            }
        }
    }
    return out.sort((a, b) => a.date.localeCompare(b.date) || String(a.start).localeCompare(String(b.start)));
}

class TTUScheduleScraper {
    constructor(options = {}) {
        this.onStatus = options.onStatus || (() => {});
        this.profileDir = options.profileDir || path.join(os.homedir(), ".ttu-grade-scraper", "schedule-profile");
        this.context = null;
        this.browser = null;
        this.page = null;
        this.connectPromise = null;
        this.loginRequired = false;
        this.authStep = "none";
        this.authPhone = "";
        this.terms = [];
        this.currentTerm = "";
        this.lastActivityAt = 0;
        this.termCalendarCache = new Map();
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

    async launchContext() {
        this.context = await chromium.launchPersistentContext(this.profileDir, {
            headless: true,
            viewport: { width: 1500, height: 1050 }
        });
        await installScheduleResourceRouting(this.context);
        const pages = this.context.pages();
        this.page = pages.length ? pages[0] : await this.context.newPage();
    }

    async createParallelWorker(options = {}) {
        await this.requireReady();
        // Persistent Playwright contexts intentionally report browser() as null, so a
        // worker cannot be created with this.context.browser(). Launch one small, isolated
        // Chromium instance instead. It receives the authenticated TTU SSO state but NOT
        // Schedule Builder's site-local session state, giving the second VSB its own server
        // session so clearCourses() in one worker cannot reset the other worker.
        const sourceState = await this.context.storageState();
        const storageState = {
            cookies: (sourceState.cookies || []).filter(cookie => !String(cookie.domain || "").toLowerCase().includes("schedulebuilder.ttu.edu")),
            origins: (sourceState.origins || []).filter(origin => !String(origin.origin || "").toLowerCase().includes("schedulebuilder.ttu.edu"))
        };
        const browser = await chromium.launch({ headless: true });
        let context;
        try {
            context = await browser.newContext({
                viewport: { width: 1500, height: 1050 },
                storageState
            });
            await installScheduleResourceRouting(context);
        } catch (error) {
            await browser.close().catch(() => {});
            throw error;
        }
        const worker = new TTUScheduleScraper({
            onStatus: options.onStatus || (() => {}),
            profileDir: this.profileDir
        });
        worker.browser = browser;
        worker.context = context;
        worker.terms = [...this.terms];
        worker.currentTerm = "";
        worker.authStep = "none";
        worker.loginRequired = false;

        let workerTimer = null;
        try {
            worker.page = await context.newPage();
            const prepare = async () => {
                await worker.page.goto(SCHEDULE_URL, { waitUntil: "domcontentloaded", timeout: 20000 });
                const state = await worker.waitForState(10000, ["ready", "welcome", "term-select", "recommendation", "login", "mfa-method", "mfa-code", "blocked"]);
                if (["login", "mfa-method", "mfa-code"].includes(state.type)) {
                    const error = new Error("A fresh Schedule Builder worker could not reuse the current Texas Tech sign-in.");
                    error.code = "PARALLEL_WORKER_UNAVAILABLE";
                    throw error;
                }
                const terms = await worker.finishConnection(state.page || worker.page);
                if (!terms.length || worker.authStep !== "none") {
                    const error = new Error("A fresh Schedule Builder worker did not reach the course-selection page.");
                    error.code = "PARALLEL_WORKER_UNAVAILABLE";
                    throw error;
                }
            };
            await Promise.race([
                prepare(),
                new Promise((_, reject) => {
                    workerTimer = setTimeout(() => {
                        const error = new Error("Parallel Schedule Builder worker startup timed out; using the primary session instead.");
                        error.code = "PARALLEL_WORKER_UNAVAILABLE";
                        reject(error);
                    }, 12000);
                })
            ]);
            return worker;
        } catch (error) {
            await worker.close().catch(() => {});
            if (!error.code) error.code = "PARALLEL_WORKER_UNAVAILABLE";
            throw error;
        } finally {
            if (workerTimer) clearTimeout(workerTimer);
        }
    }

    async connect() {
        if (this.context && this.page && this.terms.length && this.authStep === "none") return this.terms;
        if (this.context && this.page && (this.loginRequired || this.authStep !== "none")) return [];
        if (this.connectPromise) return await this.connectPromise;
        this.connectPromise = this._connectInternal();
        try {
            return await this.connectPromise;
        } finally {
            this.connectPromise = null;
        }
    }

    async _connectInternal() {
        this.status("Connecting to TTU Schedule Builder...", { phase: "connecting", connected: false });
        if (!this.context) await this.launchContext();
        await this.page.goto(SCHEDULE_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
        this.touch();
        const state = await this.waitForState(120000);
        if (state.type === "login") {
            this.loginRequired = true;
            this.setAuthStep("login-required", "Schedule Builder sign-in required.");
            return [];
        }
        if (state.type === "mfa-method") {
            this.loginRequired = false;
            this.setAuthStep("mfa-method", "Schedule Builder requires Texas Tech verification.", { authPhone: state.phone });
            return [];
        }
        if (state.type === "mfa-code") {
            this.loginRequired = false;
            this.setAuthStep("mfa-code", "Enter the Texas Tech verification code for Schedule Builder.");
            return [];
        }
        return await this.finishConnection(state.page || this.page);
    }

    async detectState() {
        if (!this.context) return { type: "unknown" };
        for (const currentPage of this.context.pages()) {
            for (const frame of currentPage.frames()) {
                try {
                    if (await frame.locator("#userNameInput").count() && await frame.locator("#passwordInput").count()) {
                        const error = normalizeText(await frame.locator("#errorText").textContent().catch(() => ""));
                        return { type: "login", page: currentPage, frame, error };
                    }
                    if (await frame.locator("#MainContent_selectcontactmethod_rblContactMethod_1").count() &&
                        await frame.locator("#MainContent_selectcontactmethod_btnSendCode").count()) {
                        const phone = normalizeText(await frame.locator("#MainContent_selectcontactmethod_lblPhone").textContent().catch(() => ""));
                        const error = normalizeText(await frame.locator("#MainContent_selectcontactmethod_lblErrorMessage").textContent().catch(() => ""));
                        return { type: "mfa-method", page: currentPage, frame, phone, error };
                    }
                    if (await frame.locator("#MainContent_verifycode_txtToken").count() &&
                        await frame.locator("#MainContent_verifycode_btnVerifyToken").count()) {
                        const error = normalizeText(await frame.locator("#MainContent_verifycode_lblErrorMessage").textContent().catch(() => ""));
                        return { type: "mfa-code", page: currentPage, frame, error };
                    }

                    const continueButton = frame.locator('.reg_welcome input.big_button[value="Continue"]').first();
                    if (await continueButton.count() && await continueButton.isVisible().catch(() => false)) {
                        return { type: "welcome", page: currentPage, frame };
                    }

                    const termCard = frame.locator("#welcomeTerms .term-card-title").first();
                    if (await termCard.count() && await termCard.isVisible().catch(() => false)) {
                        return { type: "term-select", page: currentPage, frame };
                    }

                    const recommendation = frame.locator(".reg_recommendation").first();
                    if (await recommendation.count() && await recommendation.isVisible().catch(() => false)) {
                        return { type: "recommendation", page: currentPage, frame };
                    }

                    const input = frame.locator("#code_number").first();
                    if (await input.count() && await input.isVisible().catch(() => false) && await input.isEnabled().catch(() => false)) {
                        const active = normalizeText(await frame.locator(".active-term-label").first().textContent().catch(() => ""));
                        if (active) return { type: "ready", page: currentPage, frame, activeTerm: active };
                    }

                    const blocked = frame.locator(".crnListWarning.importOnlyPlan").first();
                    if (await blocked.count() && await blocked.isVisible().catch(() => false)) {
                        const message = normalizeText(await blocked.textContent().catch(() => ""));
                        return { type: "blocked", page: currentPage, frame, message };
                    }
                } catch {}
            }
        }
        return { type: "unknown" };
    }

    async waitForState(timeoutMs = 120000, accepted = null) {
        const deadline = Date.now() + timeoutMs;
        const allowed = accepted ? new Set(accepted) : null;
        while (Date.now() < deadline) {
            const state = await this.detectState();
            if (state.type !== "unknown" && (!allowed || allowed.has(state.type))) return state;
            await delay();
        }
        throw new Error("Timed out waiting for TTU Schedule Builder or authentication.");
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

    async collectTerms(frame = null) {
        const target = frame || this.page;
        if (!target) return [];
        const data = await target.evaluate(() => {
            const clean = value => String(value || "").replace(/\s+/g, " ").trim();
            const values = [];
            const active = clean(document.querySelector(".active-term-label")?.textContent || "");
            if (active) values.push(active);
            for (const el of document.querySelectorAll("#welcomeTerms .term-card-title, a.select_term")) {
                const text = clean(el.textContent);
                if (text) values.push(text);
            }
            return { active, terms: [...new Set(values)] };
        });
        this.terms = data.terms;
        if (data.active) this.currentTerm = data.active;
        return this.terms;
    }

    async finishConnection(page) {
        this.page = page || this.page;
        const deadline = Date.now() + 90000;
        while (Date.now() < deadline) {
            const state = await this.detectState();
            if (state.page) this.page = state.page;

            if (state.type === "welcome") {
                this.status("Schedule Builder connected. Opening term selection...", { phase: "schedule-welcome", connected: true });
                await state.frame.locator('.reg_welcome input.big_button[value="Continue"]').click({ force: true });
                this.touch();
                await delay(150);
                continue;
            }

            if (state.type === "term-select") {
                const terms = await this.collectTerms(state.frame);
                this.currentTerm = "";
                this.loginRequired = false;
                this.authStep = "none";
                this.authPhone = "";
                this.touch();
                this.status(`Connected to Schedule Builder. Choose a planning term (${terms.length} available).`, {
                    phase: "choose-term",
                    connected: true,
                    terms,
                    currentTerm: ""
                });
                return terms;
            }

            if (state.type === "recommendation") {
                const skip = state.frame.locator("#skip_rec").first();
                if (await skip.count() && await skip.isVisible().catch(() => false) && await skip.isEnabled().catch(() => false)) {
                    await skip.click({ force: true });
                    this.touch();
                    await delay(150);
                    continue;
                }
                throw new Error("Schedule Builder is waiting on a recommendation/plan choice that cannot be skipped automatically.");
            }

            if (state.type === "ready") {
                const terms = await this.collectTerms(state.frame);
                this.currentTerm = state.activeTerm || this.currentTerm || "";
                this.loginRequired = false;
                this.authStep = "none";
                this.authPhone = "";
                this.touch();
                this.status(`Connected to Schedule Builder${this.currentTerm ? ` on ${this.currentTerm}` : ""}.`, {
                    phase: "ready",
                    connected: true,
                    terms,
                    currentTerm: this.currentTerm
                });
                return terms;
            }

            if (state.type === "blocked") {
                throw new Error(state.message || "Schedule Builder does not allow manual course selection for this account/term.");
            }

            if (state.type === "login") {
                this.loginRequired = true;
                this.setAuthStep("login-required", state.error || "Schedule Builder sign-in required.");
                return [];
            }
            if (state.type === "mfa-method" || state.type === "mfa-code") {
                this.loginRequired = false;
                this.setAuthStep(state.type, state.type === "mfa-method" ? "Choose a verification method." : "Enter the verification code.", { authPhone: state.phone || "" });
                return [];
            }
            await delay();
        }
        throw new Error("Timed out preparing TTU Schedule Builder.");
    }

    async login(username, password) {
        username = normalizeText(username);
        password = String(password || "");
        if (!username) throw new Error("Enter your Texas Tech username or email.");
        if (!password) throw new Error("Enter your Texas Tech password.");
        await this.connect();
        if (this.terms.length && this.authStep === "none") return this.terms;

        const state = await this.waitForState(20000, ["login", "ready", "welcome", "term-select", "recommendation", "mfa-method", "mfa-code"]);
        if (["ready", "welcome", "term-select", "recommendation"].includes(state.type)) return await this.finishConnection(state.page);
        if (state.type === "mfa-method" || state.type === "mfa-code") {
            this.setAuthStep(state.type, state.type === "mfa-method" ? "Choose a verification method." : "Enter the verification code.", { authPhone: state.phone || "" });
            return [];
        }

        this.setAuthStep("signing-in", "Signing in to TTU Schedule Builder...");
        await state.frame.locator("#userNameInput").fill(username);
        await state.frame.locator("#passwordInput").fill(password);
        await state.frame.locator("#submitButton").click();
        password = "";
        this.touch();

        const next = await this.waitForState(120000, ["ready", "welcome", "term-select", "recommendation", "login", "mfa-method", "mfa-code"]);
        if (["ready", "welcome", "term-select", "recommendation"].includes(next.type)) return await this.finishConnection(next.page);
        if (next.type === "login") {
            this.loginRequired = true;
            this.setAuthStep("login-required", next.error || "Schedule Builder sign-in was not accepted.");
            throw new Error(next.error || "Schedule Builder sign-in was not accepted.");
        }
        this.loginRequired = false;
        this.setAuthStep(next.type, next.type === "mfa-method" ? "Choose how to receive the verification code." : "Enter the verification code.", { authPhone: next.phone || "" });
        return [];
    }

    async sendMfa(method = "sms") {
        const state = await this.waitForState(20000, ["mfa-method", "ready", "welcome", "term-select", "recommendation"]);
        if (["ready", "welcome", "term-select", "recommendation"].includes(state.type)) return await this.finishConnection(state.page);
        const selector = method === "voice"
            ? "#MainContent_selectcontactmethod_rblContactMethod_0"
            : "#MainContent_selectcontactmethod_rblContactMethod_1";
        await state.frame.locator(selector).check();
        await state.frame.locator("#MainContent_selectcontactmethod_btnSendCode").click();
        this.touch();
        const next = await this.waitForState(60000, ["mfa-code", "ready", "welcome", "term-select", "recommendation", "mfa-method", "login"]);
        if (["ready", "welcome", "term-select", "recommendation"].includes(next.type)) return await this.finishConnection(next.page);
        if (next.type === "mfa-code") {
            this.setAuthStep("mfa-code", "Verification code sent. Enter it to continue.");
            return [];
        }
        if (next.type === "mfa-method") {
            this.setAuthStep("mfa-method", next.error || "Choose a verification method.", { authPhone: next.phone || "" });
            return [];
        }
        this.loginRequired = true;
        this.setAuthStep("login-required", next.error || "Texas Tech returned to sign in.");
        throw new Error(next.error || "Texas Tech returned to sign in.");
    }

    async verifyMfa(code, registerBrowser = false) {
        code = normalizeText(code);
        if (!code) throw new Error("Enter the verification code.");
        const state = await this.waitForState(20000, ["mfa-code", "ready", "welcome", "term-select", "recommendation"]);
        if (["ready", "welcome", "term-select", "recommendation"].includes(state.type)) return await this.finishConnection(state.page);
        await state.frame.locator("#MainContent_verifycode_txtToken").fill(code);
        const remember = state.frame.locator("#MainContent_verifycode_chkRegisterBrowser");
        if (await remember.count()) {
            if (registerBrowser) await remember.check().catch(() => {});
            else await remember.uncheck().catch(() => {});
        }
        await state.frame.locator("#MainContent_verifycode_btnVerifyToken").click();
        this.touch();
        const deadline = Date.now() + 120000;
        while (Date.now() < deadline) {
            const next = await this.detectState();
            if (["ready", "welcome", "term-select", "recommendation"].includes(next.type)) return await this.finishConnection(next.page);
            if (next.type === "mfa-code" && next.error) {
                this.setAuthStep("mfa-code", next.error);
                const error = new Error(next.error);
                error.code = "MFA_CODE_ERROR";
                throw error;
            }
            if (next.type === "mfa-method") {
                this.setAuthStep("mfa-method", next.error || "Choose a verification method again.", { authPhone: next.phone || "" });
                return [];
            }
            if (next.type === "login") {
                this.loginRequired = true;
                this.setAuthStep("login-required", next.error || "Texas Tech returned to sign in.");
                throw new Error(next.error || "Texas Tech returned to sign in.");
            }
            await delay();
        }
        throw new Error("Timed out waiting for Schedule Builder verification.");
    }

    async getAuthPreview() {
        if (!this.context) throw new Error("The Schedule Builder browser is not running.");
        const pages = this.context.pages();
        const current = pages[pages.length - 1] || this.page;
        if (!current) throw new Error("No Schedule Builder page is open.");
        return await current.screenshot({ type: "png", fullPage: true });
    }

    async requireReady() {
        const terms = await this.connect();
        if (!terms.length || this.authStep !== "none") {
            const error = new Error("Schedule Builder sign-in is required.");
            error.code = "LOGIN_REQUIRED";
            throw error;
        }
    }

    async setTerm(term) {
        await this.requireReady();
        term = normalizeText(term);
        if (!term) throw new Error("Choose a Schedule Builder term.");
        if (!this.terms.includes(term)) throw new Error(`Schedule Builder term "${term}" was not found.`);

        const deadline = Date.now() + 90000;
        while (Date.now() < deadline) {
            const state = await this.detectState();
            if (state.page) this.page = state.page;

            if (state.type === "welcome") {
                await state.frame.locator('.reg_welcome input.big_button[value="Continue"]').click({ force: true });
                this.touch();
                await delay(150);
                continue;
            }

            if (state.type === "term-select") {
                await this.collectTerms(state.frame);
                const clicked = await state.frame.evaluate(target => {
                    const clean = value => String(value || "").replace(/\s+/g, " ").trim();
                    const link = [...document.querySelectorAll("#welcomeTerms .term-card-title")]
                        .find(el => clean(el.textContent) === target);
                    if (!link) return false;
                    link.click();
                    return true;
                }, term);
                if (!clicked) throw new Error(`Schedule Builder term "${term}" was not found on the term selection page.`);
                this.touch();
                await delay(150);
                continue;
            }

            if (state.type === "recommendation") {
                const skip = state.frame.locator("#skip_rec").first();
                if (await skip.count() && await skip.isVisible().catch(() => false) && await skip.isEnabled().catch(() => false)) {
                    await skip.click({ force: true });
                    this.touch();
                    await delay(150);
                    continue;
                }
                throw new Error("Schedule Builder requires a recommendation/plan choice before manual course selection.");
            }

            if (state.type === "ready") {
                const active = normalizeText(state.activeTerm || await state.frame.locator(".active-term-label").first().textContent().catch(() => ""));
                if (active === term) {
                    this.currentTerm = term;
                    await this.collectTerms(state.frame);
                    this.touch();
                    return;
                }

                const clicked = await state.frame.evaluate(target => {
                    const clean = value => String(value || "").replace(/\s+/g, " ").trim();
                    const link = [...document.querySelectorAll("a.select_term")].find(el => clean(el.textContent) === target);
                    if (!link) return false;
                    link.click();
                    return true;
                }, term);
                if (!clicked) throw new Error(`Schedule Builder term "${term}" was not found in the term menu.`);
                this.touch();
                await delay(150);
                continue;
            }

            if (state.type === "blocked") {
                throw new Error(state.message || "Schedule Builder does not allow manual course selection for this term.");
            }
            if (["login", "mfa-method", "mfa-code"].includes(state.type)) {
                const error = new Error("Schedule Builder authentication expired.");
                error.code = "LOGIN_REQUIRED";
                throw error;
            }
            await delay();
        }
        throw new Error(`Timed out switching Schedule Builder to ${term}.`);
    }

    async resetForCourse(term) {
        await this.requireReady();

        // Do NOT navigate to criteria.jsp?src=clear here. That endpoint rebuilds the VSB
        // page/session and can briefly leave stale "no schedule combinations" state behind.
        // It also makes parallel workers more fragile. Stay on the current authenticated VSB
        // page and remove whatever courses are actually present, one at a time.
        await this.setTerm(term);
        await this.clearExistingCourses();

        // Clearing a course causes VSB to rebuild part of the criteria DOM. Wait until the
        // normal course-search control is usable again before typing the next exact course.
        const input = this.page.locator("#code_number").first();
        await input.waitFor({ state: "visible", timeout: 30000 });
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
            if (await input.isEnabled().catch(() => false)) break;
            await delay(100);
        }
        if (!(await input.isEnabled().catch(() => false))) {
            throw new Error("Schedule Builder course search did not become ready after clearing the previous courses.");
        }
        await input.fill("").catch(() => {});
        await input.press("Escape").catch(() => {});
        this.touch();
    }

    async readCourseRowState(box, index = -1) {
        const code = normalizeText(await box.locator(".cbox-cn").first().textContent().catch(() => ""));
        const dropdown = box.locator("select.cbox-dropdown").first();
        const dropdownInfo = await dropdown.count().catch(() => 0)
            ? await dropdown.evaluate(node => ({
                value: String(node.value || ""),
                selectedText: String(node.selectedOptions?.[0]?.textContent || node.selectedOptions?.[0]?.label || "").replace(/\s+/g, " ").trim(),
                options: [...node.options].map(option => ({
                    value: String(option.value || ""),
                    text: String(option.textContent || option.label || "").replace(/\s+/g, " ").trim()
                }))
            })).catch(() => ({ value: "", selectedText: "", options: [] }))
            : { value: "", selectedText: "", options: [] };

        const undo = box.locator(".cbox-trash-icon-undo").first();
        const undoVisible = await undo.count().catch(() => 0)
            ? await undo.isVisible().catch(() => false)
            : false;

        const trash = box.locator(".cnf_trash_button").first();
        const trashCount = await trash.count().catch(() => 0);
        const trashVisible = trashCount ? await trash.isVisible().catch(() => false) : false;

        const includeToggle = box.locator("input.ignore_check").first();
        const includeToggleCount = await includeToggle.count().catch(() => 0);
        const included = includeToggleCount
            ? await includeToggle.isChecked().catch(() => true)
            : true;

        const dropOption = (dropdownInfo.options || []).find(option =>
            /^dp_/i.test(option.value) || /\b(plan|mark)\s+to\s+drop\b/i.test(option.text)
        ) || null;

        return {
            index,
            code,
            dropdownValue: dropdownInfo.value,
            dropdownSelectedText: dropdownInfo.selectedText || "",
            dropdownOptions: dropdownInfo.options || [],
            dropOptionValue: dropOption?.value || "",
            dropped: /^dp_/i.test(dropdownInfo.value) || /\b(plan|mark)\s+to\s+drop\b/i.test(dropdownInfo.selectedText || "") || undoVisible,
            included,
            includeToggleCount,
            trashCount,
            trashVisible
        };
    }

    async activeCourseSnapshot() {
        const boxes = this.page.locator(".requirementDiv2:not(#templateCourse2)");
        const count = await boxes.count();
        const rows = [];
        for (let i = 0; i < count; i++) {
            const state = await this.readCourseRowState(boxes.nth(i), i);
            // VSB's blue checkbox means "include this course in schedule results". A row
            // may remain in the DOM after being marked to drop or ignored; neither state
            // is active and neither may constrain the requested course's result set.
            if (!state.dropped && state.included !== false) rows.push(state);
        }
        return { count: rows.length, rows, domCount: count };
    }

    async findCourseRowIndex(courseCode, fallbackIndex = -1, options = {}) {
        const wanted = normalizeCourseCode(courseCode);
        const boxes = this.page.locator(".requirementDiv2:not(#templateCourse2)");
        const count = await boxes.count();
        const includeInactive = options.includeInactive === true;

        // VSB can rebuild/reorder the criteria rows after every remove/drop operation.
        // Reacquire the exact course row instead of trusting the previous numeric index.
        if (wanted) {
            for (let i = 0; i < count; i++) {
                const state = await this.readCourseRowState(boxes.nth(i), i);
                if (normalizeCourseCode(state.code) !== wanted) continue;
                if (includeInactive || (!state.dropped && state.included !== false)) return i;
            }
            return -1;
        }

        return Number.isInteger(fallbackIndex) && fallbackIndex >= 0 && fallbackIndex < count
            ? fallbackIndex
            : -1;
    }

    async deactivateCourseRow(target, fallbackIndex = -1) {
        const boxes = this.page.locator(".requirementDiv2:not(#templateCourse2)");
        const currentIndex = await this.findCourseRowIndex(target.code, fallbackIndex, { includeInactive: true });
        if (currentIndex < 0) return { ok: true, method: "already-gone" };

        const box = boxes.nth(currentIndex);
        const current = await this.readCourseRowState(box, currentIndex);
        if (current.dropped || current.included === false) return { ok: true, method: "already-inactive" };

        // Enrolled TTU courses often do not expose the same trash control as manually-added
        // courses. Their supported VSB reset is the course dropdown's "Plan to drop" state.
        // This changes only the temporary Schedule Builder plan; it does NOT alter registration.
        if (current.dropOptionValue) {
            const dropdown = box.locator("select.cbox-dropdown").first();
            const selected = await dropdown.selectOption(current.dropOptionValue).then(() => true).catch(() => false);
            if (!selected) {
                const changed = await dropdown.evaluate((node, value) => {
                    const option = [...node.options].find(item => String(item.value || "") === String(value || ""));
                    if (!option) return false;
                    node.value = option.value;
                    node.dispatchEvent(new Event("input", { bubbles: true }));
                    node.dispatchEvent(new Event("change", { bubbles: true }));
                    return true;
                }, current.dropOptionValue).catch(() => false);
                if (changed) {
                    this.touch();
                    return { ok: true, method: "plan-to-drop" };
                }
            } else {
                this.touch();
                return { ok: true, method: "plan-to-drop" };
            }
        }

        // Manually-added courses normally have a trash button. Use a semantic DOM click as
        // well as the historic class because VSB's icon markup can change and the icon image
        // itself may have no useful Playwright visibility box during a redraw.
        const removed = await box.evaluate(node => {
            const candidates = [];
            const push = item => { if (item && !candidates.includes(item)) candidates.push(item); };
            push(node.querySelector(".cnf_trash_button"));
            push(node.querySelector(".cbox-trash-icon:not(.cbox-trash-icon-undo)"));
            for (const item of node.querySelectorAll("button,a,[role='button'],img,input[type='button']")) {
                const text = [
                    item.className,
                    item.id,
                    item.getAttribute("title"),
                    item.getAttribute("aria-label"),
                    item.getAttribute("alt"),
                    item.getAttribute("src"),
                    item.textContent
                ].filter(Boolean).join(" ").toLowerCase();
                if (/\b(undo|restore)\b/.test(text)) continue;
                if (/\b(trash|remove|delete)\b/.test(text)) push(item);
            }
            const target = candidates.find(item => item && item.isConnected);
            if (!target) return false;
            target.click();
            return true;
        }).catch(() => false);
        if (removed) {
            this.touch();
            return { ok: true, method: "remove-control" };
        }

        // Last-resort functional fallback: if this VSB version exposes neither a drop option
        // nor a removable icon, uncheck the course's native include box. The row may remain
        // visible, but it cannot constrain results. This is preferable to failing every course.
        const toggle = box.locator("input.ignore_check").first();
        if (await toggle.count().catch(() => 0)) {
            const checked = await toggle.isChecked().catch(() => true);
            if (checked) {
                const toggled = await toggle.click({ force: true }).then(() => true).catch(async () => {
                    return await toggle.evaluate(node => {
                        if (!node.checked) return true;
                        node.click();
                        return !node.checked;
                    }).catch(() => false);
                });
                if (toggled) {
                    this.touch();
                    return { ok: true, method: "include-checkbox" };
                }
            } else {
                return { ok: true, method: "already-ignored" };
            }
        }

        const optionSummary = (current.dropdownOptions || []).map(option => `${option.text || "?"}=${option.value || "?"}`).join(", ");
        return {
            ok: false,
            method: "none",
            problem: `no usable drop/remove/include control was found${optionSummary ? ` (dropdown: ${optionSummary})` : ""}`
        };
    }

    async clearExistingCourses() {
        // Each VSB session may start with any number of currently-enrolled courses. Clear
        // exactly what is present in that session, one row at a time, without navigating or
        // refreshing. Enrolled rows are marked "Plan to drop" in VSB; manually-added rows
        // use their remove control. Both are temporary planning actions only.
        const overallDeadline = Date.now() + 120000;
        let cleared = 0;
        const methods = new Map();

        while (Date.now() < overallDeadline) {
            const before = await this.activeCourseSnapshot();
            if (!before.count) break;

            const target = before.rows[before.rows.length - 1];
            const label = target.code || `course row ${target.index + 1}`;
            let confirmed = false;
            let lastProblem = "";
            let lastMethod = "";

            for (let attempt = 1; attempt <= 4 && !confirmed; attempt++) {
                const action = await this.deactivateCourseRow(target, target.index);
                lastMethod = action.method || lastMethod;
                if (!action.ok) {
                    lastProblem = action.problem || "the course could not be deactivated";
                    await delay(220);
                    continue;
                }

                const settleDeadline = Date.now() + 8000;
                while (Date.now() < settleDeadline) {
                    const after = await this.activeCourseSnapshot();
                    const targetStillActive = target.code
                        ? after.rows.some(row => normalizeCourseCode(row.code) === normalizeCourseCode(target.code))
                        : after.count >= before.count;
                    if (after.count < before.count || !targetStillActive) {
                        confirmed = true;
                        break;
                    }
                    await delay(140);
                }
                if (!confirmed) {
                    lastProblem = `VSB did not confirm the ${lastMethod || "deactivation"} state change`;
                    await delay(220);
                }
            }

            if (!confirmed) {
                throw new Error(`Schedule Builder could not clear pre-existing ${label} after 4 attempts: ${lastProblem || "the row stayed active"}`);
            }

            cleared++;
            methods.set(lastMethod || "unknown", (methods.get(lastMethod || "unknown") || 0) + 1);
            await delay(180);
        }

        const remaining = await this.activeCourseSnapshot();
        if (remaining.count) {
            const names = remaining.rows.map(row => row.code || `row ${row.index + 1}`).join(", ");
            throw new Error(`Schedule Builder still has ${remaining.count} active pre-existing course${remaining.count === 1 ? "" : "s"} after clearing: ${names}.`);
        }

        if (cleared) {
            await delay(250);
            const methodSummary = [...methods.entries()].map(([method, count]) => `${count} ${method}`).join(", ");
            this.status(`Schedule Builder: cleared ${cleared} pre-existing course${cleared === 1 ? "" : "s"}${methodSummary ? ` (${methodSummary})` : ""}.`, {
                phase: "schedule-reset",
                clearedCourses: cleared,
                clearMethods: Object.fromEntries(methods)
            });
        }
        return cleared;
    }

    async assertOnlyCourseActive(courseCode) {
        const expected = normalizeCourseCode(courseCode);
        const snapshot = await this.activeCourseSnapshot();
        const activeCodes = snapshot.rows.map(row => normalizeCourseCode(row.code)).filter(Boolean);
        const matching = activeCodes.filter(code => code === expected).length;
        if (snapshot.count !== 1 || matching !== 1) {
            const shown = snapshot.rows.map(row => row.code || `row ${row.index + 1}`).join(", ") || "none";
            throw new Error(`Schedule Builder course isolation failed for ${expected}; active courses: ${shown}.`);
        }
        return true;
    }

    async courseIsAdded(courseCode) {
        const compact = courseCode.replace(/\s+/g, "").toUpperCase();
        return await this.page.evaluate(compactCode => {
            const clean = value => String(value || "").replace(/\s+/g, "").toUpperCase();
            for (const box of document.querySelectorAll(".requirementDiv2:not(#templateCourse2)")) {
                const code = clean(box.querySelector(".cbox-cn")?.textContent || "");
                if (code !== compactCode) continue;
                const dropdown = box.querySelector("select.cbox-dropdown");
                if (String(dropdown?.value || "").startsWith("dp_")) continue;
                return true;
            }
            return false;
        }, compact);
    }

    async reactivateDroppedCourse(courseCode) {
        const compact = courseCode.replace(/\s+/g, "").toUpperCase();
        return await this.page.evaluate(compactCode => {
            const clean = value => String(value || "").replace(/\s+/g, "").toUpperCase();
            for (const box of document.querySelectorAll(".requirementDiv2:not(#templateCourse2)")) {
                const code = clean(box.querySelector(".cbox-cn")?.textContent || "");
                if (code !== compactCode) continue;
                const dropdown = box.querySelector("select.cbox-dropdown");
                const selectedText = String(dropdown?.selectedOptions?.[0]?.textContent || dropdown?.selectedOptions?.[0]?.label || "");
                if (dropdown && (String(dropdown.value || "").startsWith("dp_") || /\b(plan|mark)\s+to\s+drop\b/i.test(selectedText))) {
                    const all = [...dropdown.options].find(option => option.value === "al")
                        || [...dropdown.options].find(option => /\b(try|use)\s+all\s+(classes|sections)\b/i.test(String(option.textContent || option.label || "")));
                    if (all) {
                        dropdown.value = all.value;
                        dropdown.dispatchEvent(new Event("input", { bubbles: true }));
                        dropdown.dispatchEvent(new Event("change", { bubbles: true }));
                        return true;
                    }
                }
                const undo = box.querySelector(".cbox-trash-icon-undo");
                const button = box.querySelector(".cnf_trash_button");
                if (button && undo && getComputedStyle(undo).display !== "none") {
                    button.click();
                    return true;
                }
            }
            return false;
        }, compact).catch(() => false);
    }

    async searchCourseSuggestions(query, term = this.currentTerm, limit = 10) {
        await this.requireReady();
        query = normalizeText(query);
        term = normalizeText(term || this.currentTerm);
        if (!query || query.length < 2) return [];
        if (!term) throw new Error("Choose a Schedule Builder term first.");
        await this.setTerm(term);

        const canonical = normalizeCourseCode(query);
        const searchText = canonical || query.toUpperCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
        const input = this.page.locator("#code_number").first();
        await input.waitFor({ state: "visible", timeout: 30000 });
        if (!(await input.isEnabled().catch(() => false))) throw new Error("Schedule Builder course search is not ready yet.");

        await input.fill(searchText);
        this.touch();

        const deadline = Date.now() + 5000;
        let results = [];
        while (Date.now() < deadline) {
            results = await this.page.evaluate(({ maxItems, exactCourse }) => {
                const clean = value => String(value || "").replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").trim();
                const visible = node => {
                    const style = getComputedStyle(node);
                    const rect = node.getBoundingClientRect();
                    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
                };
                const container = document.querySelector("#suggestion_container");
                if (!container) return [];

                // IMPORTANT: only inspect one top-level Schedule Builder suggestion at a time.
                // Searching descendant nodes causes prerequisite text such as "ECE 3311" inside
                // the ECE 3312 description to be mistaken for the actual course code.
                let nodes = [...container.children].filter(visible);
                if (!nodes.length) {
                    nodes = [...container.querySelectorAll(":scope > [role='option'], :scope > li, :scope > a")].filter(visible);
                }

                const out = [];
                const codes = new Set();
                for (const node of nodes) {
                    const raw = String(node.innerText || node.textContent || "").replace(/\r/g, "");
                    const lines = raw.split(/\n+/).map(clean).filter(Boolean);
                    if (!lines.length) continue;

                    // The real course identifier must LEAD the suggestion. References appearing
                    // later in prerequisites/corequisites are not suggestion identifiers.
                    const firstLine = lines[0];
                    const match = firstLine.toUpperCase().match(/^([A-Z]{2,8})\s*[- ]?\s*(\d{3,5})\b/);
                    if (!match) continue;
                    const courseCode = `${match[1]} ${match[2]}`;
                    if (codes.has(courseCode)) continue;
                    codes.add(courseCode);

                    // Only expose the canonical course code here. Schedule Builder's suggestion
                    // markup interleaves titles and prerequisite snippets, and showing a guessed
                    // subtitle is worse than showing no subtitle at all. The exact course code is
                    // the authoritative value used for selection and validation.
                    out.push({ courseCode, title: "" });
                }

                if (exactCourse) {
                    out.sort((a, b) => Number(b.courseCode === exactCourse) - Number(a.courseCode === exactCourse));
                }
                return out.slice(0, maxItems);
            }, {
                maxItems: Math.max(1, Math.min(20, Number(limit) || 10)),
                exactCourse: canonical || ""
            }).catch(() => []);
            if (results.length) break;
            await delay(125);
        }

        await input.fill("").catch(() => {});
        await input.press("Escape").catch(() => {});
        this.touch();
        return results;
    }

    async addCourse(courseCode) {
        courseCode = normalizeCourseCode(courseCode);
        if (!courseCode) throw new Error("Invalid course code.");
        const input = this.page.locator("#code_number");
        await input.waitFor({ state: "visible", timeout: 30000 });

        if (await this.courseIsAdded(courseCode)) {
            this.touch();
            return;
        }

        // A pre-enrolled course may remain in the DOM in a "Plan to drop" state
        // after the reset. Reactivate that exact course before doing a fresh search.
        if (await this.reactivateDroppedCourse(courseCode)) {
            await delay(350);
            if (await this.courseIsAdded(courseCode)) {
                this.touch();
                return;
            }
        }

        const beforeCount = await this.page.locator(".requirementDiv2:not(#templateCourse2)").count();
        await input.fill(courseCode);
        this.touch();

        // Never fall back to ArrowDown/Enter: that can choose a neighboring course
        // when the requested number only appears in prerequisite text. Wait for an
        // exact leading course-code match and click only that row.
        const deadline = Date.now() + 12000;
        let clicked = false;
        while (Date.now() < deadline && !clicked) {
            clicked = await this.page.evaluate(target => {
                const desired = String(target || "").replace(/\s+/g, "").toUpperCase();
                const visible = node => {
                    const style = getComputedStyle(node);
                    const rect = node.getBoundingClientRect();
                    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
                };
                const leadingCourseCode = node => {
                    const raw = String(node.innerText || node.textContent || "").replace(/\u00a0/g, " ").trim();
                    const firstLine = raw.split(/\n+/).map(x => x.trim()).filter(Boolean)[0] || "";
                    const match = firstLine.toUpperCase().match(/^([A-Z]{2,8})\s*[- ]?\s*(\d{3,5})\b/);
                    return match ? `${match[1]}${match[2]}` : "";
                };

                const container = document.querySelector("#suggestion_container");
                if (!container) return false;
                // Only top-level suggestion rows are eligible. A prerequisite may contain an
                // exact course-code text fragment, but it is nested inside a different row.
                const candidates = [...container.children].filter(visible);
                const exact = candidates.find(node => leadingCourseCode(node) === desired);
                if (!exact) return false;
                const clickTarget = exact.matches("a,button,[role='option']")
                    ? exact
                    : exact.querySelector("a,button,[role='option']") || exact;
                clickTarget.click();
                return true;
            }, courseCode).catch(() => false);
            if (!clicked) await delay(125);
        }

        if (!clicked) {
            await input.fill("").catch(() => {});
            throw new Error(`${courseCode} was not found as an exact Schedule Builder course match.`);
        }

        const addedDeadline = Date.now() + 45000;
        while (Date.now() < addedDeadline) {
            if (await this.courseIsAdded(courseCode)) {
                this.touch();
                return;
            }
            const count = await this.page.locator(".requirementDiv2:not(#templateCourse2)").count();
            if (count > beforeCount && await this.courseIsAdded(courseCode)) return;
            await delay(125);
        }
        throw new Error(`${courseCode} did not become the active Schedule Builder course. No approximate match was accepted.`);
    }

    async isolateCourse(courseCode) {
        const compactTarget = courseCode.replace(/\s+/g, "").toUpperCase();
        const boxes = this.page.locator(".requirementDiv2:not(#templateCourse2)");
        const count = await boxes.count();
        let found = false;

        for (let i = 0; i < count; i++) {
            const box = boxes.nth(i);
            const compact = normalizeText(await box.locator(".cbox-cn").textContent().catch(() => ""))
                .replace(/\s+/g, "")
                .toUpperCase();
            const wanted = compact === compactTarget;
            if (wanted) found = true;
            const toggle = box.locator("input.ignore_check").first();
            if (await toggle.count()) {
                const checked = await toggle.isChecked().catch(() => true);
                if (checked !== wanted) await toggle.click({ force: true }).catch(() => {});
            }
        }

        if (!found) throw new Error(`${courseCode} was not present in the Schedule Builder course list.`);

        // Enrolled courses can default to a pinned "Stay enrolled" section.
        // Switch the requested course to "Try all classes" when that option exists.
        for (let i = 0; i < count; i++) {
            const box = boxes.nth(i);
            const compact = normalizeText(await box.locator(".cbox-cn").textContent().catch(() => ""))
                .replace(/\s+/g, "")
                .toUpperCase();
            if (compact !== compactTarget) continue;

            const dropdown = box.locator("select.cbox-dropdown").first();
            if (await dropdown.count()) {
                const hasAll = await dropdown.locator('option[value="al"]').count();
                if (hasAll) await dropdown.selectOption("al").catch(() => {});
            }
            const classChecks = box.locator("input.class_chk");
            const n = await classChecks.count();
            for (let j = 0; j < n; j++) {
                const checkbox = classChecks.nth(j);
                if (!(await checkbox.isChecked().catch(() => true))) {
                    await checkbox.click({ force: true }).catch(() => {});
                }
            }
        }

        // Let Schedule Builder regenerate its result set after toggles/dropdown changes.
        await delay(350);
        this.touch();
    }

    async waitForResults(timeoutMs = 60000, shouldAbort = null, expectedTotal = 0) {
        const startedAt = Date.now();
        const deadline = startedAt + timeoutMs;
        const expected = Math.max(0, Math.floor(Number(expectedTotal) || 0));
        let lastPositiveTotal = 0;
        let stableSince = 0;
        let noResultsSince = 0;
        while (Date.now() < deadline) {
            if (typeof shouldAbort === "function" && shouldAbort()) {
                const error = new Error("Background timetable verification paused for interactive work.");
                error.code = "BACKGROUND_PAUSED";
                throw error;
            }
            const state = await this.detectState();
            if (state.type !== "ready") {
                if (["login", "mfa-method", "mfa-code"].includes(state.type)) {
                    const error = new Error("Schedule Builder authentication expired.");
                    error.code = "LOGIN_REQUIRED";
                    throw error;
                }
            }
            const totalText = normalizeText(await this.page.locator(".results-total-schedules").first().textContent().catch(() => ""));
            const total = Number(totalText.replace(/,/g, ""));
            const legendReady = Boolean(await this.page.locator("#legend_box .course_box").count());
            if (Number.isFinite(total) && total > 0 && legendReady) {
                if (total !== lastPositiveTotal) {
                    lastPositiveTotal = total;
                    stableSince = Date.now();
                }
                const stableFor = Date.now() - stableSince;
                if (expected > 0) {
                    // Parallel workers must see the same authoritative result count as the
                    // preliminary pass. VSB can briefly expose a stale/partial count while
                    // rebuilding, so give it time to converge instead of clamping a 87-107
                    // range down to a bogus 38-of-38 result set.
                    if (total === expected && stableFor >= 350) return total;
                    if (total !== expected && stableFor >= 10000) {
                        const error = new Error(`Schedule Builder returned ${total} results while ${expected} were expected; this worker will not scan a partial result set.`);
                        error.code = "RESULT_COUNT_MISMATCH";
                        error.actualTotal = total;
                        error.expectedTotal = expected;
                        throw error;
                    }
                } else if (stableFor >= 550) {
                    return total;
                }
            } else {
                lastPositiveTotal = 0;
                stableSince = 0;
            }
            const noResults = normalizeText(await this.page.locator("body").textContent().catch(() => ""));
            if (/no schedule combination\(s\)/i.test(noResults)) {
                // VSB can leave this text in the DOM while it is still rebuilding results
                // after a course is removed/added. Never accept that transient state as a
                // definitive zero-result course. Require it to persist after a grace period.
                if (!noResultsSince) noResultsSince = Date.now();
                const visibleFor = Date.now() - noResultsSince;
                const sinceStart = Date.now() - startedAt;
                if (expected === 0 && sinceStart >= 6000 && visibleFor >= 3000) return 0;
            } else {
                noResultsSince = 0;
            }
            await delay(150);
        }
        throw new Error(expected > 0
            ? `Timed out waiting for Schedule Builder to stabilize at the expected ${expected} results.`
            : "Timed out waiting for Schedule Builder results.");
    }

    async parseCurrentResult(courseCode) {
        return await this.page.evaluate(requestedCourse => {
            const clean = value => String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
            const dayMap = { Mon: "M", Tue: "T", Wed: "W", Thu: "R", Fri: "F", Sat: "S", Sun: "U" };
            const parseHeader = label => {
                const text = clean(String(label || "").replace(/%20/g, " "));
                const meetings = [];
                const regex = /\bon (.+?) from (\d{1,2}:\d{2}\s*[AP]M) to (\d{1,2}:\d{2}\s*[AP]M)(?=\s+(?:on\b|Given\b|Click\b|$)|$)/ig;
                let match;
                while ((match = regex.exec(text))) {
                    const days = Object.entries(dayMap)
                        .filter(([word]) => new RegExp(`\\b${word}\\b`, "i").test(match[1]))
                        .map(([, code]) => code);
                    if (!days.length) continue;
                    meetings.push({ days, start: clean(match[2]).toUpperCase(), end: clean(match[3]).toUpperCase() });
                }
                if (meetings.length) return meetings;
                const single = text.match(/\bon (.+?) from (\d{1,2}:\d{2}\s*[AP]M) to (\d{1,2}:\d{2}\s*[AP]M)/i);
                if (!single) return [];
                const days = Object.entries(dayMap).filter(([word]) => new RegExp(`\\b${word}\\b`, "i").test(single[1])).map(([, code]) => code);
                return days.length ? [{ days, start: clean(single[2]).toUpperCase(), end: clean(single[3]).toUpperCase() }] : [];
            };
            const normalizeCode = value => {
                const match = String(value || "").toUpperCase().match(/([A-Z]{2,8})\s*[- ]?\s*(\d{3,5})/);
                return match ? `${match[1]} ${match[2]}` : "";
            };
            const monthMap = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
            const isoForMonthDay = (monthName, day, year) => {
                const month = monthMap[String(monthName || "").slice(0,3).toLowerCase()];
                if (month === undefined || !Number.isFinite(Number(day)) || !Number.isFinite(Number(year))) return "";
                return new Date(Date.UTC(Number(year), month, Number(day))).toISOString().slice(0,10);
            };
            const activeTermText = clean(document.querySelector(".active-term-label")?.textContent || "");
            const activeYearMatch = activeTermText.match(/(20\d{2})/);
            const activeYear = activeYearMatch ? Number(activeYearMatch[1]) : null;
            const parseSessionRange = headerText => {
                const text = clean(headerText);
                const m = text.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})\s*-\s*(?:(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+)?(\d{1,2})/i);
                if (!m || !activeYear) return { start:"", end:"" };
                const startMonth = m[1], endMonth = m[3] || m[1];
                const startMonthIndex = monthMap[startMonth.slice(0,3).toLowerCase()];
                const endMonthIndex = monthMap[endMonth.slice(0,3).toLowerCase()];
                const endYear = endMonthIndex < startMonthIndex ? activeYear + 1 : activeYear;
                return { start: isoForMonthDay(startMonth, Number(m[2]), activeYear), end: isoForMonthDay(endMonth, Number(m[4]), endYear) };
            };
            const parseMeetingLine = line => {
                const text = clean(line);
                if (!text) return null;
                // Date-specific meetings must be recognized before recurring day patterns.
                // A line such as "Tue Sep 17: 6:00 PM to 8:00 PM" contains the word
                // "Tue" and would otherwise be mistaken for a weekly Tuesday meeting.
                const dated = text.match(/^(Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)[, ]+\s*(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:,?\s*(20\d{2}))?\s*:?\s*(\d{1,2}:\d{2}\s*[AP]M)\s+(?:to|-|–)\s+(\d{1,2}:\d{2}\s*[AP]M)$/i);
                if (dated) {
                    const year = Number(dated[4] || activeYear);
                    if (!Number.isFinite(year) || year < 2000) return { type:"unknown", raw:text };
                    const dayKey = dated[1].slice(0,3);
                    const dayCode = dayMap[dayKey[0].toUpperCase() + dayKey.slice(1).toLowerCase()];
                    const date = isoForMonthDay(dated[2], Number(dated[3]), year);
                    if (date && dayCode) return { type:"dated", date, day:dayCode, start:clean(dated[5]).toUpperCase(), end:clean(dated[6]).toUpperCase(), raw:text };
                }
                const recurring = text.match(/^(.+?)\s*:\s*(\d{1,2}:\d{2}\s*[AP]M)\s+(?:to|-|–)\s+(\d{1,2}:\d{2}\s*[AP]M)$/i);
                if (recurring) {
                    const days = Object.entries(dayMap).filter(([word]) => new RegExp(`\\b${word}\\b`, "i").test(recurring[1])).map(([, code]) => code);
                    if (days.length) return { type:"recurring", days, start:clean(recurring[2]).toUpperCase(), end:clean(recurring[3]).toUpperCase(), raw:text };
                }
                return { type:"unknown", raw:text };
            };
            const componentRole = section => clean(section).toLowerCase().replace(/\b[a-z]?\d+[a-z]?\b/ig,"#");
            const requested = normalizeCode(requestedCourse);

            const rowSelected = root => {
                const radio = root.querySelector('input[type="radio"]');
                if (radio) {
                    return Boolean(
                        radio.checked ||
                        radio.getAttribute("aria-checked") === "true" ||
                        radio.closest(".legend-radio-cont")?.classList?.contains("is-checked")
                    );
                }
                const select = root.querySelector(".legendSelect");
                const label = root.closest("label.vsbselectionnew");
                return Boolean(
                    select?.classList?.contains("is-checked") ||
                    select?.getAttribute("aria-checked") === "true" ||
                    label?.classList?.contains("is-checked")
                );
            };

            const componentFromTableRow = (row, selectionRoot, code) => {
                const section = clean(row.querySelector(".type_block")?.textContent || "");
                const crn = clean(row.querySelector(".crn_value")?.textContent || "");
                if (!section && !crn) return null;
                const instructor = clean(row.querySelector('[title="Instructor(s)"]')?.textContent || "");
                const campus = clean(row.querySelector(".campus_block")?.textContent || "");
                const method = clean(row.querySelector(".instructional_method_block")?.textContent || "");
                const location = clean(row.querySelector(".location_block")?.textContent || "");
                const seats = clean(row.querySelector(".seatText")?.textContent || row.querySelector(".fullText")?.textContent || "");
                const waitlist = clean(row.querySelector(".waitText")?.textContent || row.querySelector(".waitTextNoColor")?.textContent || "");
                const creditsText = clean(row.querySelector(".credits_block span")?.textContent || row.querySelector(".credits_block")?.textContent || "");
                const creditsMatch = creditsText.match(/\d+(?:\.\d+)?/);
                // TTU uses explicit "No Credit" companion rows for required labs/discussions.
                // They still carry a CRN and meeting time, but should add zero hours.
                const credits = /^no\s+credit\b/i.test(section) ? 0 : (creditsMatch ? Number(creditsMatch[0]) : null);
                const select = selectionRoot.querySelector(".legendSelect") || selectionRoot.closest("label.vsbselectionnew")?.querySelector(".legendSelect");
                const stateText = clean(select?.getAttribute("title") || "").toLowerCase();
                const classText = clean(select?.className || "").toLowerCase();
                let status = "open";
                if (stateText.includes("waitlist") || classText.includes("yellow")) status = "waitlist";
                else if (stateText.includes("full") || classText.includes("red")) status = "full";
                const online = /online|web|distance/i.test(method) || /online/i.test(location);
                return { courseCode: code, section, crn, instructor, campus, method, location, seats, waitlist, credits, status, online, meetings: [] };
            };

            const buildVariant = (roots, code, aggregateMeetings) => {
                const components = [];
                for (const root of roots) {
                    // One VSB selection can itself be a required bundle. ENGR/CS courses
                    // commonly put a 3-credit lecture and a 0-credit companion lab in
                    // separate <tr> rows under one radio choice. Preserve BOTH CRNs.
                    const detailRows = [...root.querySelectorAll("tr")].filter(row => row.querySelector(".type_block") && row.querySelector(".crn_value"));
                    if (detailRows.length) {
                        for (const row of detailRows) {
                            const component = componentFromTableRow(row, root, code);
                            if (component) components.push(component);
                        }
                    } else {
                        const component = componentFromTableRow(root, root, code);
                        if (component) components.push(component);
                    }
                }

                // VSB's course header lists the recurring meeting patterns in the same
                // order as bundled class rows. When counts agree, map lecture->lecture
                // and companion lab/discussion->its own time. If the structure is less
                // specific, duplicate all official patterns as a conservative fallback;
                // this can reject a questionable schedule but will not hide a conflict.
                if (components.length === 1) {
                    components[0].meetings = aggregateMeetings.map(m => ({ ...m, days: [...m.days] }));
                } else if (components.length && aggregateMeetings.length === components.length) {
                    components.forEach((component, index) => {
                        component.meetings = [{ ...aggregateMeetings[index], days: [...aggregateMeetings[index].days] }];
                    });
                } else if (components.length) {
                    components.forEach(component => {
                        component.meetings = aggregateMeetings.map(m => ({ ...m, days: [...m.days] }));
                    });
                }

                const crns = components.map(c => c.crn).filter(Boolean).sort();
                const sectionKey = components.map(c => `${c.section || "section"}:${c.crn || "no-crn"}`).sort();
                const meetingKey = components.flatMap(c => c.meetings.map(m => `${m.days.join("")}:${m.start}-${m.end}`)).sort();
                return {
                    courseCode: requestedCourse,
                    optionKey: `${crns.join("+")}|${sectionKey.join("+")}|${meetingKey.join("+")}`,
                    components
                };
            };

            for (const box of document.querySelectorAll("#legend_box .course_box")) {
                const courseEl = box.querySelector(".course_title");
                const code = normalizeCode(clean(courseEl?.textContent || ""));
                if (!code || code !== requested) continue;
                const hoursLegend = box.querySelector("#hoursInLegend");
                const rawMeetingLines = hoursLegend
                    ? String(hoursLegend.innerHTML || "").split(/<br\s*\/?\s*>/i).map(line => clean(line.replace(/<[^>]+>/g, " "))).filter(Boolean)
                    : [];
                const parsedMeetingLines = rawMeetingLines.map(parseMeetingLine);
                let aggregateMeetings = parsedMeetingLines
                    .filter(item => item?.type === "recurring")
                    .map(item => ({ days:[...item.days], start:item.start, end:item.end }));
                const legendOccurrences = parsedMeetingLines
                    .filter(item => item?.type === "dated")
                    .map(item => ({ date:item.date, day:item.day, start:item.start, end:item.end, kind:"Special meeting", special:true, source:"legend" }));
                const unparsedMeetingLines = parsedMeetingLines.filter(item => item?.type === "unknown").map(item => item.raw);
                if (!aggregateMeetings.length) aggregateMeetings = parseHeader(courseEl?.getAttribute("aria-label") || "");
                const sessionRange = parseSessionRange(box.querySelector(".header_cell")?.textContent || courseEl?.getAttribute("aria-label") || "");
                const allRows = [...box.querySelectorAll(".selection_row")];
                const radioRows = allRows.filter(root => root.classList.contains("selection_row_radio") || root.querySelector('input[type="radio"]'));

                let variants = [];
                let selectedIndex = 0;
                if (radioRows.length) {
                    // VSB groups same-time section alternatives behind radio buttons.
                    // They are NOT one mega-bundle: each radio row is a separate valid
                    // lecture + companion-lab choice with its own professor and CRNs.
                    variants = radioRows.map(root => buildVariant([root], code, aggregateMeetings)).filter(v => v.components.length);
                    const idx = radioRows.findIndex(rowSelected);
                    if (idx >= 0 && idx < variants.length) selectedIndex = idx;
                } else {
                    const selectedRows = allRows.filter(rowSelected);
                    if (selectedRows.length) {
                        variants = [buildVariant(selectedRows, code, aggregateMeetings)];
                    } else if (allRows.length <= 1) {
                        variants = [buildVariant(allRows.length ? allRows : [box], code, aggregateMeetings)];
                    } else {
                        // If VSB lists multiple unmarked same-time choices, keep them as
                        // independent options rather than accidentally cross-pairing them.
                        variants = allRows.map(root => buildVariant([root], code, aggregateMeetings)).filter(v => v.components.length);
                    }
                }
                variants = variants.filter(v => v.components.length);
                if (!variants.length) return { courseCode: requestedCourse, optionKey: "", components: [], variants: [] };
                const primary = variants[Math.max(0, Math.min(selectedIndex, variants.length - 1))];
                const mappingAmbiguous = primary.components.length > 1 && aggregateMeetings.length !== primary.components.length;
                const complexComponent = primary.components.some(component => !/^(lec|lecture|sem|seminar)\b/i.test(String(component.section || "")));
                const multiplePatterns = aggregateMeetings.length > 1;
                const noScheduledMeeting = primary.components.length > 0 && primary.components.every(component => component.online && !(component.meetings || []).length);
                const legendDataComplete = noScheduledMeeting || (rawMeetingLines.length ? unparsedMeetingLines.length === 0 : aggregateMeetings.length > 0);
                const needsDeepScan = !noScheduledMeeting && (!legendDataComplete || mappingAmbiguous || legendOccurrences.length > 0 || complexComponent || multiplePatterns);
                const roleSignature = primary.components.map(component => `${componentRole(component.section)}:${component.credits === 0 ? "zero" : "credit"}:${component.online ? "online" : "campus"}`).sort();
                const timetableSignature = JSON.stringify({
                    sessionStart: sessionRange.start,
                    sessionEnd: sessionRange.end,
                    lines: rawMeetingLines.map(line => clean(line).toLowerCase()),
                    recurring: aggregateMeetings.map(m => `${[...m.days].sort().join("")}:${m.start}-${m.end}`).sort(),
                    roles: roleSignature
                });
                return {
                    ...primary,
                    variants,
                    rawMeetingLines,
                    legendOccurrences,
                    unparsedMeetingLines,
                    sessionStart: sessionRange.start,
                    sessionEnd: sessionRange.end,
                    legendDataComplete,
                    mappingAmbiguous,
                    needsDeepScan,
                    noScheduledMeeting,
                    timetableSignature
                };
            }
            return { courseCode: requestedCourse, optionKey: "", components: [], variants: [] };
        }, courseCode);
    }

    async captureCurrentWeekSnapshot(courseCode) {
        const raw = await this.page.evaluate(requestedCourse => {
            const clean = value => String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
            const normalizeCode = value => {
                const match = String(value || "").toUpperCase().match(/([A-Z]{2,8})\s*[- ]?\s*(\d{3,5})/);
                return match ? `${match[1]} ${match[2]}` : "";
            };
            const parseClock = (hourText, suffixText) => {
                let hour = Number(String(hourText || "").trim());
                const suffix = String(suffixText || "").trim().toUpperCase();
                if (!Number.isFinite(hour)) return null;
                hour %= 12;
                if (suffix === "PM") hour += 12;
                return hour * 60;
            };

            const area = document.querySelector(".reg_schedule1 .weekArea");
            const times = document.querySelector(".reg_schedule1 .weekTimes");
            const weekLabel = clean(document.querySelector(".reg_schedule1 .disp_days")?.textContent || "");
            if (!area || !times || !weekLabel) return { weekLabel, events: [], requestedBlockCount: 0, geometryValid: false };

            const requestedBlocks = [...times.querySelectorAll(".time_block")].filter(block => normalizeCode(clean(block.textContent || "")) === requestedCourse);
            const areaRect = area.getBoundingClientRect();
            const refs = [...area.querySelectorAll(".hour_marker")].map(marker => {
                const row = marker.closest("tr");
                const suffix = row?.querySelector(".min_marker")?.textContent || "";
                const minutes = parseClock(marker.textContent, suffix);
                return row && minutes !== null ? { minutes, y: row.getBoundingClientRect().top - areaRect.top } : null;
            }).filter(Boolean).sort((a, b) => a.y - b.y);

            let pixelsPerMinute = null;
            let anchor = refs[0] || null;
            for (let i = 1; i < refs.length && anchor; i++) {
                const minuteDelta = refs[i].minutes - anchor.minutes;
                const pixelDelta = refs[i].y - anchor.y;
                if (minuteDelta > 0 && pixelDelta > 0) {
                    pixelsPerMinute = pixelDelta / minuteDelta;
                    break;
                }
            }
            if (!anchor || !pixelsPerMinute) return { weekLabel, events: [], requestedBlockCount: requestedBlocks.length, geometryValid: false };

            const events = [];
            for (const block of requestedBlocks) {
                const rect = block.getBoundingClientRect();
                const centerX = rect.left + rect.width / 2 - areaRect.left;
                const dayIndex = Math.max(0, Math.min(4, Math.floor((centerX / areaRect.width) * 5)));
                const start = anchor.minutes + ((rect.top - areaRect.top - anchor.y) / pixelsPerMinute);
                const end = anchor.minutes + ((rect.bottom - areaRect.top - anchor.y) / pixelsPerMinute);
                const lines = String(block.querySelector(".nonmobile")?.innerText || block.innerText || "")
                    .split(/\n+/).map(clean).filter(Boolean);
                const kind = lines.slice(1).join(" ") || "Meeting";
                events.push({ dayIndex, start, end, kind });
            }
            return { weekLabel, events, requestedBlockCount: requestedBlocks.length, geometryValid: true };
        }, courseCode).catch(() => ({ weekLabel: "", events: [], requestedBlockCount: 0, geometryValid: false }));

        const startMs = weekStartFromLabel(raw.weekLabel);
        if (startMs === null) return { weekLabel: raw.weekLabel || "", weekStart: "", events: [], requestedBlockCount: raw.requestedBlockCount || 0, geometryValid: false };
        const dayCodes = ["M", "T", "W", "R", "F"];
        const events = (raw.events || []).map(event => {
            const dayIndex = Math.max(0, Math.min(4, Number(event.dayIndex) || 0));
            return {
                date: isoDateUTC(startMs + (dayIndex + 1) * 24 * 60 * 60 * 1000),
                day: dayCodes[dayIndex],
                start: minutesToClock(event.start),
                end: minutesToClock(event.end),
                kind: normalizeText(event.kind || "Meeting")
            };
        });
        return {
            weekLabel: raw.weekLabel,
            weekStart: isoDateUTC(startMs),
            events,
            requestedBlockCount: Number(raw.requestedBlockCount || 0),
            geometryValid: raw.geometryValid === true && events.length === Number(raw.requestedBlockCount || 0)
        };
    }

    async weekMoveAvailable(direction) {
        const selector = direction < 0 ? ".reg_schedule1 .sliderleft" : ".reg_schedule1 .sliderright";
        const button = this.page.locator(selector).first();
        if (!(await button.count())) return false;
        if (!(await button.isVisible().catch(() => false))) return false;
        return !(await button.isDisabled().catch(() => true));
    }

    async weekSliderPercent() {
        return await this.page.evaluate(() => {
            const handle = document.querySelector(".reg_schedule1 .slider .ui-slider-handle");
            if (!handle) return null;
            const inline = parseFloat(String(handle.style.left || "").replace("%", ""));
            if (Number.isFinite(inline)) return Math.max(0, Math.min(100, inline));
            const slider = handle.parentElement;
            if (!slider) return null;
            const sr = slider.getBoundingClientRect(), hr = handle.getBoundingClientRect();
            if (!sr.width) return null;
            return Math.max(0, Math.min(100, ((hr.left - sr.left) / sr.width) * 100));
        }).catch(() => null);
    }

    async atWeekBoundary(direction) {
        const pct = await this.weekSliderPercent();
        if (!Number.isFinite(pct)) return false;
        return direction < 0 ? pct <= 1.5 : pct >= 98.5;
    }

    async moveWeek(direction) {
        const selector = direction < 0 ? ".reg_schedule1 .sliderleft" : ".reg_schedule1 .sliderright";
        if (!(await this.weekMoveAvailable(direction))) return false;
        const before = normalizeText(await this.page.locator(".reg_schedule1 .disp_days").first().textContent().catch(() => ""));
        const invoked = await this.page.evaluate(sel => {
            const button = document.querySelector(sel);
            if (!button) return false;
            button.click();
            return true;
        }, selector).catch(() => false);
        if (!invoked) await this.page.locator(selector).first().click({ force: true }).catch(() => {});
        const deadline = Date.now() + 3500;
        while (Date.now() < deadline) {
            const after = normalizeText(await this.page.locator(".reg_schedule1 .disp_days").first().textContent().catch(() => ""));
            if (after && after !== before) {
                this.touch();
                return true;
            }
            await delay(45);
        }
        return false;
    }


    async captureTermCalendar(term, options = {}) {
        const key = normalizeText(term || this.currentTerm);
        if (key && this.termCalendarCache.has(key)) return this.termCalendarCache.get(key);
        if (!(await this.page.locator(".reg_schedule1 .disp_days").count())) {
            return { complete: false, weeks: [], holidayDates: [] };
        }

        this.status(`Schedule Builder: reading ${key || "term"} semester calendar once...`, {
            phase: options.phase || "schedule-course",
            course: options.course || "",
            scanMode: "term-calendar"
        });

        const abortIfRequested = () => {
            if (typeof options.shouldAbort === "function" && options.shouldAbort()) {
                const error = new Error("Background timetable verification paused for interactive work.");
                error.code = "BACKGROUND_PAUSED";
                throw error;
            }
        };

        const expectedWeekCount = await this.page.evaluate(() => {
            const slider = document.querySelector(".reg_schedule1 .slider");
            const n = Number(slider?.dataset?.end || 0);
            return Number.isFinite(n) && n > 0 ? n : 0;
        }).catch(() => 0);

        let reachedFirstWeek = false;
        for (let i = 0; i < 30; i++) {
            abortIfRequested();
            if (!(await this.weekMoveAvailable(-1))) { reachedFirstWeek = true; break; }
            if (!(await this.moveWeek(-1))) { reachedFirstWeek = await this.atWeekBoundary(-1); break; }
        }

        const weeks = [];
        const holidayDates = new Set();
        const seen = new Set();
        let reachedLastWeek = false;
        for (let i = 0; i < 30; i++) {
            abortIfRequested();
            const raw = await this.page.evaluate(() => {
                const clean = value => String(value || "").replace(/\s+/g, " ").trim();
                const label = clean(document.querySelector(".reg_schedule1 .disp_days")?.textContent || "");
                const holidays = [];
                const codes = ["2","3","4","5","6"];
                for (let i = 0; i < codes.length; i++) {
                    const el = document.querySelector(`.reg_schedule1 .holl_${codes[i]}`);
                    if (!el) continue;
                    const text = clean(el.textContent || el.getAttribute("title") || "");
                    const style = window.getComputedStyle ? window.getComputedStyle(el) : null;
                    const visible = style ? style.display !== "none" && style.visibility !== "hidden" : true;
                    if (text && visible) holidays.push({ dayIndex: i + 1, label: text });
                }
                return { label, holidays };
            }).catch(() => ({ label: "", holidays: [] }));
            const weekStartMs = weekStartFromLabel(raw.label);
            if (!weekStartMs) break;
            const weekStart = isoDateUTC(weekStartMs);
            if (seen.has(weekStart)) break;
            seen.add(weekStart);
            weeks.push({ weekStart, label: raw.label, source: "vsb-term-calendar" });
            if (typeof options.onWeekProgress === "function") {
                options.onWeekProgress({ current: weeks.length, total: expectedWeekCount || 0, label: raw.label });
            }
            for (const holiday of raw.holidays || []) {
                const date = addIsoDays(weekStart, holiday.dayIndex);
                if (date) holidayDates.add(date);
            }

            if (!(await this.weekMoveAvailable(1))) { reachedLastWeek = true; break; }
            if (!(await this.moveWeek(1))) { reachedLastWeek = await this.atWeekBoundary(1); break; }
        }

        const value = {
            complete: Boolean(reachedFirstWeek && reachedLastWeek && weeks.length),
            weeks,
            holidayDates: [...holidayDates].sort()
        };
        if (key && value.complete) this.termCalendarCache.set(key, value);
        return value;
    }

    async captureDetailedOccurrences(courseCode, components = [], options = {}) {
        // VSB's week arrows expose the exact dates that are actually occupied.
        // Capturing these lets the local optimizer distinguish alternating labs and
        // surface one-off discussion/test meetings instead of assuming every pattern
        // repeats every week.
        if (!(await this.page.locator(".reg_schedule1 .disp_days").count())) {
            return { occurrences: [], weeks: [], occurrenceCoverageComplete: false, scanDirection: "forward" };
        }

        const abortIfRequested = () => {
            if (typeof options.shouldAbort === "function" && options.shouldAbort()) {
                const error = new Error("Background timetable verification paused for interactive work.");
                error.code = "BACKGROUND_PAUSED";
                throw error;
            }
        };
        const expectedWeekCount = await this.page.evaluate(() => {
            const slider = document.querySelector(".reg_schedule1 .slider");
            const n = Number(slider?.dataset?.end || 0);
            return Number.isFinite(n) && n > 0 ? n : 0;
        }).catch(() => 0);

        // Deep verification used to rewind to week 1 before every option and then walk
        // forward through the semester. VSB normally preserves the week-slider position
        // when moving to the next result, so that doubled the expensive week transitions.
        // Scan in a snake pattern instead: if the previous option ended at the last week,
        // verify the next option backward; if it ended at the first week, verify forward.
        let direction = options.scanDirection === "backward" ? -1 : options.scanDirection === "forward" ? 1 : 0;
        if (!direction) {
            const canPrevious = await this.weekMoveAvailable(-1);
            const canNext = await this.weekMoveAvailable(1);
            if (!canPrevious && canNext) direction = 1;
            else if (canPrevious && !canNext) direction = -1;
            else {
                const pct = await this.weekSliderPercent();
                direction = Number.isFinite(pct) && pct > 50 ? -1 : 1;
            }
        }

        let reachedFirstWeek = false;
        let reachedLastWeek = false;
        const startBoundaryDirection = direction > 0 ? -1 : 1;
        for (let i = 0; i < 30; i++) {
            abortIfRequested();
            if (!(await this.weekMoveAvailable(startBoundaryDirection))) {
                if (startBoundaryDirection < 0) reachedFirstWeek = true;
                else reachedLastWeek = true;
                break;
            }
            if (!(await this.moveWeek(startBoundaryDirection))) {
                const atBoundary = await this.atWeekBoundary(startBoundaryDirection);
                if (startBoundaryDirection < 0) reachedFirstWeek = atBoundary;
                else reachedLastWeek = atBoundary;
                break;
            }
        }

        const snapshots = [];
        const seenWeeks = new Set();
        for (let i = 0; i < 30; i++) {
            abortIfRequested();
            const snapshot = await this.captureCurrentWeekSnapshot(courseCode);
            if (!snapshot.weekStart || seenWeeks.has(snapshot.weekStart)) break;
            seenWeeks.add(snapshot.weekStart);
            snapshots.push(snapshot);
            if (typeof options.onWeekProgress === "function") {
                options.onWeekProgress({ current: snapshots.length, total: expectedWeekCount || 0, label: snapshot.weekLabel, direction: direction > 0 ? "forward" : "backward" });
            }

            if (!(await this.weekMoveAvailable(direction))) {
                if (direction > 0) reachedLastWeek = true;
                else reachedFirstWeek = true;
                break;
            }
            if (!(await this.moveWeek(direction))) {
                const atBoundary = await this.atWeekBoundary(direction);
                if (direction > 0) reachedLastWeek = atBoundary;
                else reachedFirstWeek = atBoundary;
                break;
            }
        }

        const clockMinutes = value => {
            const match = normalizeText(value).toUpperCase().match(/(\d{1,2}):(\d{2})\s*(AM|PM)/);
            if (!match) return null;
            let hour = Number(match[1]) % 12;
            if (match[3] === "PM") hour += 12;
            return hour * 60 + Number(match[2]);
        };
        const basePatterns = [];
        for (const component of components || []) {
            for (const meeting of component.meetings || []) {
                const start = clockMinutes(meeting.start), end = clockMinutes(meeting.end);
                for (const day of meeting.days || []) {
                    if (start !== null && end !== null) basePatterns.push({ day, start, end });
                }
            }
        }
        const matchesBasePattern = event => {
            const start = clockMinutes(event.start), end = clockMinutes(event.end);
            if (start === null || end === null) return false;
            return basePatterns.some(pattern => pattern.day === event.day && Math.abs(pattern.start - start) <= 10 && Math.abs(pattern.end - end) <= 10);
        };

        const kindComponent = kind => {
            const lower = String(kind || "").toLowerCase();
            const list = components || [];
            if (lower.includes("no credit")) {
                const noCredit = list.find(component => /^no\s+credit\b/i.test(String(component.section || "")));
                if (noCredit) return noCredit;
            }
            const wanted = lower.includes("lab") ? "lab"
                : lower.includes("discussion") ? "dis"
                : lower.includes("recitation") ? "rec"
                : lower.includes("lecture") ? "lec"
                : lower.includes("seminar") ? "sem"
                : "";
            if (!wanted) return null;
            const exactRole = list.find(component => String(component.section || "").toLowerCase().startsWith(wanted));
            if (exactRole) return exactRole;
            if (wanted === "lab") return list.find(component => /^no\s+credit\b/i.test(String(component.section || ""))) || null;
            return null;
        };

        const occurrences = [];
        const seen = new Set();
        for (const snapshot of snapshots) {
            for (const event of snapshot.events || []) {
                const key = `${event.date}|${event.start}|${event.end}|${event.kind}`;
                if (seen.has(key)) continue;
                seen.add(key);
                const matchedComponent = kindComponent(event.kind);
                occurrences.push({
                    ...event,
                    section: matchedComponent?.section || "",
                    online: Boolean(matchedComponent?.online),
                    special: !matchesBasePattern(event)
                });
            }
        }

        occurrences.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
        const recurringPatternsObserved = basePatterns.every(pattern => occurrences.some(event => {
            const start = clockMinutes(event.start), end = clockMinutes(event.end);
            return start !== null && end !== null && pattern.day === event.day && Math.abs(pattern.start - start) <= 10 && Math.abs(pattern.end - end) <= 10;
        }));
        const geometryComplete = snapshots.every(snapshot => snapshot.geometryValid === true);
        const occurrenceCoverageComplete = Boolean(reachedFirstWeek && reachedLastWeek && snapshots.length && geometryComplete && recurringPatternsObserved);
        const orderedSnapshots = [...snapshots].sort((a, b) => String(a.weekStart || "").localeCompare(String(b.weekStart || "")));
        return {
            occurrences,
            weeks: orderedSnapshots.map(snapshot => ({ weekStart: snapshot.weekStart, label: snapshot.weekLabel })),
            occurrenceCoverageComplete,
            scanDirection: direction > 0 ? "forward" : "backward"
        };
    }

    async scrapeCourseOptions(term, courseCode, options = {}) {
        courseCode = normalizeCourseCode(courseCode);
        if (!courseCode) throw new Error("Invalid course code.");
        const preliminaryOnly = options.preliminaryOnly === true;
        const statusPhase = options.backgroundVerification === true ? "background-verification" : "schedule-course";
        const abortIfRequested = () => {
            if (typeof options.shouldAbort === "function" && options.shouldAbort()) {
                const error = new Error("Background timetable verification paused for interactive work.");
                error.code = "BACKGROUND_PAUSED";
                throw error;
            }
        };
        abortIfRequested();
        await this.resetForCourse(term);
        abortIfRequested();
        this.status(`Schedule Builder: loading ${courseCode}...`, { phase: statusPhase, course: courseCode, scanMode: preliminaryOnly ? "preliminary" : "setup" });
        await this.addCourse(courseCode);
        abortIfRequested();
        await this.isolateCourse(courseCode);
        abortIfRequested();
        await this.assertOnlyCourseActive(courseCode);
        abortIfRequested();
        const total = await this.waitForResults(90000, options.shouldAbort, options.expectedResultTotal);
        if (!total) throw new Error(`Schedule Builder found no valid timetable options for ${courseCode} in ${term}.`);

        const limit = Math.min(total, Number(options.maxResults || 1000));
        const requestedStart = Math.max(1, Math.min(limit, Number(options.resultStart || 1)));
        const requestedEnd = Math.max(requestedStart, Math.min(limit, Number(options.resultEnd || limit)));
        const reverseResults = options.resultDirection === "backward";
        const rangeStart = requestedStart;
        const rangeEnd = requestedEnd;
        const rangeCount = Math.max(0, rangeEnd - rangeStart + 1);
        const results = [];
        const seen = new Set();
        const detailCache = new Map();
        let deepScans = 0;
        let fastReads = 0;
        let reusedDetailed = 0;
        let termCalendar = null;
        const sharedDetailCache = options.sharedDetailCache instanceof Map ? options.sharedDetailCache : null;
        const visitedResultIndexes = [];

        const mapOccurrence = (event, variant) => {
            const lower = String(event.kind || "").toLowerCase();
            const components = variant.components || [];
            let component = null;
            if (lower.includes("no credit")) component = components.find(c => /^no\s+credit\b/i.test(String(c.section || ""))) || null;
            if (!component && lower.includes("lecture")) component = components.find(c => /^(lec|lecture)\b/i.test(String(c.section || ""))) || null;
            if (!component && lower.includes("discussion")) component = components.find(c => /^(dis|disc|dsc|discussion)\b/i.test(String(c.section || ""))) || null;
            if (!component && lower.includes("recitation")) component = components.find(c => /^(rec|recitation)\b/i.test(String(c.section || ""))) || null;
            if (!component && lower.includes("seminar")) component = components.find(c => /^(sem|seminar)\b/i.test(String(c.section || ""))) || null;
            if (!component && lower.includes("exam")) component = components.find(c => /^(lec|lecture)\b/i.test(String(c.section || ""))) || null;
            if (!component && lower.includes("lab")) component = components.find(c => /^(lab|laboratory)\b/i.test(String(c.section || ""))) || components.find(c => /^no\s+credit\b/i.test(String(c.section || ""))) || null;
            if (!component && components.length === 1) component = components[0];
            return {
                ...event,
                section: component?.section || event.section || "",
                online: component ? Boolean(component.online) : Boolean(event.online)
            };
        };

        const waitForResultNumber = async expected => {
            const deadline = Date.now() + 30000;
            while (Date.now() < deadline) {
                abortIfRequested();
                const text = normalizeText(await this.page.locator(".results-current-schedule").first().textContent().catch(() => ""));
                if (Number(text.replace(/,/g, "")) === expected) {
                    this.touch();
                    return true;
                }
                await delay(55);
            }
            return false;
        };

        const nextResult = async current => {
            abortIfRequested();
            const expected = current + 1;
            // VSB already exposes its own result navigation function. Calling it in the
            // page avoids Playwright's extra actionability/scroll work while preserving
            // the exact same state transition as clicking the native Next arrow.
            let invoked = await this.page.evaluate(() => {
                try {
                    if (window.UU && typeof window.UU.caseNextResult === "function") {
                        window.UU.caseNextResult();
                        return true;
                    }
                } catch {}
                return false;
            }).catch(() => false);
            if (!invoked) {
                const next = this.page.locator(".results-action-next").first();
                await next.click({ force: true }).catch(async () => {
                    await this.page.locator(".nav-next.results-nav-btn").first().click({ force: true });
                });
            }
            return await waitForResultNumber(expected);
        };

        const previousResult = async current => {
            abortIfRequested();
            const expected = current - 1;
            let invoked = await this.page.evaluate(() => {
                try {
                    if (window.UU) {
                        const previousFn = typeof window.UU.casePrevResult === "function"
                            ? window.UU.casePrevResult
                            : (typeof window.UU.casePreviousResult === "function" ? window.UU.casePreviousResult : null);
                        if (previousFn) {
                            previousFn.call(window.UU);
                            return true;
                        }
                    }
                } catch {}
                return false;
            }).catch(() => false);
            if (!invoked) {
                const selectors = [".results-action-prev", ".nav-prev.results-nav-btn", ".results-nav-prev", "[aria-label*='Previous schedule' i]"];
                let clicked = false;
                for (const selector of selectors) {
                    const previous = this.page.locator(selector).first();
                    if (!(await previous.count().catch(() => 0))) continue;
                    if (!(await previous.isVisible().catch(() => false))) continue;
                    clicked = await previous.click({ force: true }).then(() => true).catch(() => false);
                    if (clicked) break;
                }
                if (!clicked) return false;
            }
            return await waitForResultNumber(expected);
        };

        const moveToResult = async target => {
            let text = normalizeText(await this.page.locator(".results-current-schedule").first().textContent().catch(() => "1"));
            let current = Number(text.replace(/,/g, "")) || 1;
            while (current < target) {
                abortIfRequested();
                if (!(await nextResult(current))) return false;
                current++;
            }
            while (current > target) {
                abortIfRequested();
                if (!(await previousResult(current))) return false;
                current--;
            }
            return true;
        };

        const firstTarget = reverseResults ? rangeEnd : rangeStart;
        if (firstTarget !== 1) {
            this.status(`Schedule Builder: ${courseCode} positioning at option ${firstTarget} of ${total} for ${reverseResults ? "backward" : "forward"} parallel verification...`, {
                phase: statusPhase,
                course: courseCode,
                current: firstTarget,
                total,
                scanMode: "positioning"
            });
            if (!(await moveToResult(firstTarget))) {
                throw new Error(`Schedule Builder could not move to result ${firstTarget} while loading ${courseCode}.`);
            }
        }

        for (let step = 0; step < rangeCount; step++) {
            abortIfRequested();
            const expectedCurrent = reverseResults ? (rangeEnd - step) : (rangeStart + step);
            const currentText = normalizeText(await this.page.locator(".results-current-schedule").first().textContent().catch(() => String(expectedCurrent)));
            let current = Number(currentText.replace(/,/g, "")) || expectedCurrent;
            if (current !== expectedCurrent) {
                if (!(await moveToResult(expectedCurrent))) {
                    throw new Error(`Schedule Builder lost its result position while loading ${courseCode}; expected ${expectedCurrent} but saw ${current}.`);
                }
                current = expectedCurrent;
            }
            visitedResultIndexes.push(current);
            const result = await this.parseCurrentResult(courseCode);
            if (!result.components.length) {
                throw new Error(`Schedule Builder result ${current} did not contain the exact requested course ${courseCode}.`);
            }
            const variants = Array.isArray(result.variants) && result.variants.length ? result.variants : [result];
            for (const variant of variants) {
                const exactOnly = variant.components.every(component => normalizeCourseCode(component.courseCode) === courseCode);
                if (!exactOnly) {
                    throw new Error(`Schedule Builder returned a mismatched course while loading ${courseCode}; the result was rejected.`);
                }
            }

            const unseenVariants = variants.filter(variant => !seen.has(variant.optionKey));
            if (unseenVariants.length) {
                const detailKey = result.timetableSignature || result.optionKey || `result-${current}`;
                let detailed = detailCache.get(detailKey);
                if (detailed) {
                    reusedDetailed++;
                } else if (sharedDetailCache?.has(detailKey)) {
                    detailed = sharedDetailCache.get(detailKey);
                    if (detailed) {
                        detailCache.set(detailKey, detailed);
                        reusedDetailed++;
                    }
                }

                if (!detailed) {
                    const forceDeep = options.verifyAllWeeks === true;
                    const shouldDeepScan = forceDeep || result.needsDeepScan === true;
                    const syntheticWeeks = buildSessionWeeks(result.sessionStart, result.sessionEnd);

                    if (preliminaryOnly) {
                        // Progressive-loading fast path: use the authoritative VSB legend and
                        // session range immediately so the student can start planning while a
                        // lower-priority background pass verifies the semester week-by-week.
                        // We intentionally mark coverage incomplete until that pass finishes.
                        fastReads++;
                        const provisionalCalendar = { complete: true, weeks: syntheticWeeks, holidayDates: [] };
                        const expanded = expandRecurringWithTermCalendar(result.components, provisionalCalendar, result.sessionStart, result.sessionEnd);
                        detailed = {
                            occurrences: mergeOccurrenceLists(expanded, result.legendOccurrences),
                            weeks: syntheticWeeks,
                            occurrenceCoverageComplete: false,
                            source: "vsb-provisional",
                            rawMeetingLines: result.rawMeetingLines || [],
                            legendDataComplete: result.legendDataComplete === true
                        };
                    } else if (shouldDeepScan) {
                        deepScans++;
                        this.status(`Schedule Builder: ${courseCode} option ${current} of ${total} — verifying VSB week-by-week timetable...`, {
                            phase: statusPhase,
                            course: courseCode,
                            current,
                            total,
                            scanMode: "deep"
                        });
                        const captured = await this.captureDetailedOccurrences(courseCode, result.components, {
                            shouldAbort: options.shouldAbort,
                            onWeekProgress: info => this.status(`Schedule Builder: ${courseCode} option ${current} of ${total} — checking semester week ${info.current}${info.total ? `/${info.total}` : ""} ${info.direction === "backward" ? "(reverse)" : ""}...`, {
                                phase: statusPhase,
                                course: courseCode,
                                current,
                                total,
                                weekCurrent: info.current,
                                weekTotal: info.total || 0,
                                weekDirection: info.direction || "forward",
                                scanMode: "deep"
                            })
                        });
                        detailed = {
                            occurrences: mergeOccurrenceLists(captured.occurrences, result.legendOccurrences),
                            weeks: Array.isArray(captured.weeks) && captured.weeks.length ? captured.weeks : syntheticWeeks,
                            occurrenceCoverageComplete: captured.occurrenceCoverageComplete === true,
                            source: captured.occurrenceCoverageComplete === true ? "vsb-week-verified" : "vsb-week-partial",
                            rawMeetingLines: result.rawMeetingLines || [],
                            legendDataComplete: result.legendDataComplete === true
                        };
                    } else {
                        // Ordinary recurring sections do not need a per-result 16-20 week
                        // crawl. Scan the term rail once (including holidays) and combine it
                        // with VSB's accessibility legend, then reuse it for every simple
                        // timetable signature in the selected term.
                        fastReads++;
                        if (!termCalendar) termCalendar = await this.captureTermCalendar(term, {
                            shouldAbort: options.shouldAbort,
                            phase: statusPhase,
                            course: courseCode,
                            onWeekProgress: info => this.status(`Schedule Builder: ${courseCode} option ${current} of ${total} — mapping semester week ${info.current}${info.total ? `/${info.total}` : ""}...`, {
                                phase: statusPhase,
                                course: courseCode,
                                current,
                                total,
                                weekCurrent: info.current,
                                weekTotal: info.total || 0,
                                scanMode: "term-calendar"
                            })
                        });
                        const expanded = expandRecurringWithTermCalendar(result.components, termCalendar, result.sessionStart, result.sessionEnd);
                        const exactFromLegend = Boolean(termCalendar?.complete && result.legendDataComplete === true && (expanded.length || result.noScheduledMeeting === true));
                        detailed = {
                            occurrences: mergeOccurrenceLists(expanded, result.legendOccurrences),
                            weeks: Array.isArray(termCalendar?.weeks) && termCalendar.weeks.length ? termCalendar.weeks : syntheticWeeks,
                            occurrenceCoverageComplete: exactFromLegend,
                            source: exactFromLegend ? "vsb-legend+term-calendar" : "vsb-legend-fast",
                            rawMeetingLines: result.rawMeetingLines || [],
                            legendDataComplete: result.legendDataComplete === true
                        };
                    }
                    detailCache.set(detailKey, detailed);
                    if (sharedDetailCache && detailed) sharedDetailCache.set(detailKey, detailed);
                }

                for (const variant of unseenVariants) {
                    seen.add(variant.optionKey);
                    variant.occurrences = (detailed.occurrences || []).map(event => mapOccurrence(event, variant));
                    variant.weeks = detailed.weeks || [];
                    variant.occurrenceCoverageComplete = detailed.occurrenceCoverageComplete === true;
                    variant.timetableDetailSource = detailed.source || "unknown";
                    variant.legendMeetingLines = [...(detailed.rawMeetingLines || result.rawMeetingLines || [])];
                    variant.legendDataComplete = detailed.legendDataComplete === true;
                    variant.sessionStart = result.sessionStart || "";
                    variant.sessionEnd = result.sessionEnd || "";
                    variant.timetableSignature = result.timetableSignature || "";
                    variant.equivalentChoiceCount = variants.length;
                    variant.sameTimeAlternative = variants.length > 1;
                    variant.needsDeepScan = result.needsDeepScan === true;
                    variant.verificationPending = preliminaryOnly;
                    variant.vsbResultIndex = current;
                    results.push(variant);
                }
            }

            this.status(`Schedule Builder: ${courseCode} option ${current} of ${total} — ${deepScans} detailed timetable check${deepScans === 1 ? "" : "s"}, ${fastReads} fast legend read${fastReads === 1 ? "" : "s"}${reusedDetailed ? `, ${reusedDetailed} reused timetable pattern${reusedDetailed === 1 ? "" : "s"}` : ""}`, {
                phase: statusPhase,
                course: courseCode,
                current,
                total,
                scanMode: preliminaryOnly ? "preliminary" : (result.needsDeepScan ? "deep" : "fast")
            });
            if (step >= rangeCount - 1) break;

            const advanced = reverseResults ? await previousResult(current) : await nextResult(current);
            if (!advanced) {
                throw new Error(`Schedule Builder did not ${reverseResults ? "move backward" : "advance"} from result ${current} while loading ${courseCode}.`);
            }
        }

        this.touch();
        return {
            term,
            courseCode,
            totalReported: total,
            totalCaptured: results.length,
            truncated: total > limit,
            scanComplete: !preliminaryOnly && rangeStart === 1 && rangeEnd === limit && limit === total,
            rangeComplete: !preliminaryOnly,
            resultRange: { start: rangeStart, end: rangeEnd, direction: reverseResults ? "backward" : "forward" },
            preliminary: preliminaryOnly,
            scanStats: { deepScans, fastReads, reusedDetailed, uniqueTimetablePatterns: detailCache.size },
            visitedResultIndexes,
            options: results
        };
    }

    async keepAlive() {
        if (!this.context || !this.terms.length || this.authStep !== "none") return false;
        try {
            // Exercise the authenticated UI without changing the selected term.
            // This mirrors the Cognos keepalive: interact lightly, then make one
            // low-frequency authenticated request.
            try {
                const state = await this.detectState();
                if (state.type === "ready") {
                    const input = state.frame.locator("#code_number").first();
                    if (await input.count() && await input.isVisible().catch(() => false) && await input.isEnabled().catch(() => false)) {
                        const existing = await input.inputValue().catch(() => "");
                        if (!existing) {
                            // VSB times out after inactivity. Mimic harmless user activity by
                            // typing one character and deleting it; never select a suggestion.
                            await input.fill("x").catch(() => {});
                            await delay(90);
                            await input.fill("").catch(() => {});
                        } else {
                            await input.click({ force: true }).catch(() => {});
                        }
                        await input.press("Escape").catch(() => {});
                    } else {
                        const menuButton = state.frame.locator(".main_menu_button").first();
                        if (await menuButton.count() && await menuButton.isVisible().catch(() => false)) {
                            await menuButton.click({ force: true }).catch(() => {});
                            await state.frame.locator("body").press("Escape").catch(() => {});
                        }
                    }
                }
            } catch {}
            const response = await this.context.request.get(SCHEDULE_URL, { timeout: 30000, failOnStatusCode: false });
            this.touch();
            return response.ok() || response.status() < 500;
        } catch {
            return false;
        }
    }

    async close() {
        if (this.context) {
            try { await this.context.close(); } catch {}
        }
        if (this.browser) {
            try { await this.browser.close(); } catch {}
        }
        this.context = null;
        this.browser = null;
        this.page = null;
        this.connectPromise = null;
        this.loginRequired = false;
        this.authStep = "none";
        this.authPhone = "";
        this.terms = [];
        this.currentTerm = "";
    }
}

module.exports = { TTUScheduleScraper, SCHEDULE_URL };
