const { chromium } = require("playwright");
const fs = require("fs");
const os = require("os");
const path = require("path");

const COGNOS_URL =
    "https://cognos.texastech.edu/ibmcognos/bi/?perspective=classicviewer&id=iC0E72F9A3AB64E9A9D5E54C2DB5D4643&objRef=iC0E72F9A3AB64E9A9D5E54C2DB5D4643&action=run&format=HTML&prompt=false";

const SELECT_CONTROL_CSS = "select.clsSelectControl";
const TERM_INDEX = 0;
const SUBJECT_INDEX = 1;
const COURSE_INDEX = 2;
const POLL_MS = 50;

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
        this.headless = true;
        this.terms = [];
        this.subjectsByTerm = new Map();
        this.coursesByGroup = new Map();

        fs.mkdirSync(this.outputDir, { recursive: true });
        fs.mkdirSync(this.profileDir, { recursive: true });
    }

    status(message, extra = {}) {
        this.onStatus({ message, ...extra });
    }

    async connect() {
        if (this.terms.length && this.context && this.page) {
            return this.terms;
        }

        // A headless browser may already be sitting on the TTU sign-in page.
        // Do not launch a second persistent context against the same profile.
        if (this.context && this.page && this.loginRequired) {
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
            const type = route.request().resourceType();

            if (type === "image" || type === "media" || type === "font") {
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

        const auth = await this.waitForAuthState(this.page, 120000);

        if (auth.type === "login") {
            this.loginRequired = true;
            this.status("Texas Tech sign-in required.", {
                phase: "login-required",
                connected: false,
                loginRequired: true
            });
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

        this.status(`Connected. Found ${this.terms.length} terms.`, {
            phase: "ready",
            connected: true,
            loginRequired: false
        });

        return this.terms;
    }

    async waitForAuthState(page, timeoutMs = 120000) {
        const deadline = Date.now() + timeoutMs;

        while (Date.now() < deadline) {
            const pages = page.context().pages();

            for (const currentPage of pages) {
                for (const frame of currentPage.frames()) {
                    try {
                        const selectCount = await frame.locator(SELECT_CONTROL_CSS).count();
                        if (selectCount >= 3) {
                            return { type: "ready", frame };
                        }

                        const user = frame.locator("#userNameInput");
                        const pass = frame.locator("#passwordInput");
                        if (await user.count() && await pass.count()) {
                            return { type: "login", frame };
                        }
                    } catch {}
                }
            }

            await pollDelay();
        }

        throw new Error("Timed out waiting for Texas Tech login or the Cognos prompt.");
    }

    async findLoginFrame(timeoutMs = 15000) {
        if (!this.page || !this.context) {
            return null;
        }

        const deadline = Date.now() + timeoutMs;

        while (Date.now() < deadline) {
            for (const currentPage of this.context.pages()) {
                for (const frame of currentPage.frames()) {
                    try {
                        if (
                            await frame.locator("#userNameInput").count() &&
                            await frame.locator("#passwordInput").count()
                        ) {
                            return frame;
                        }
                    } catch {}
                }
            }

            await pollDelay();
        }

        return null;
    }

    async login(username, password) {
        username = normalizeText(username);
        password = String(password || "");

        if (!username || (!username.includes("@") && !username.includes("\\"))) {
            throw new Error("Use your @ttu.edu email or a ttu\\username style account name.");
        }

        if (!password) {
            throw new Error("Enter your Texas Tech password.");
        }

        await this.connect();

        if (!this.loginRequired && this.terms.length) {
            return this.terms;
        }

        const frame = await this.findLoginFrame(15000);
        if (!frame) {
            throw new Error("Texas Tech login form was not found. Try reconnecting.");
        }

        this.status("Signing in to Texas Tech...", {
            phase: "signing-in",
            connected: false,
            loginRequired: true
        });

        await frame.locator("#userNameInput").fill(username);
        await frame.locator("#passwordInput").fill(password);

        // Credentials are intentionally not stored on disk or retained by this object.
        username = "";
        password = "";

        const submit = frame.locator("#submitButton");
        if (!await submit.count()) {
            throw new Error("Texas Tech Sign in button was not found.");
        }

        await submit.click();

        this.status("Credentials submitted. Approve Duo/MFA if Texas Tech asks.", {
            phase: "mfa",
            connected: false,
            loginRequired: false
        });

        const deadline = Date.now() + 180000;

        while (Date.now() < deadline) {
            // Successful auth eventually returns us to the Cognos prompt.
            let loginError = "";

            for (const currentPage of this.context.pages()) {
                for (const currentFrame of currentPage.frames()) {
                    try {
                        const selectCount = await currentFrame.locator(SELECT_CONTROL_CSS).count();
                        if (selectCount >= 3) {
                            return await this.finishConnection(currentFrame);
                        }

                        const errorText = await currentFrame
                            .locator("#errorText")
                            .textContent()
                            .catch(() => "");

                        if (normalizeText(errorText)) {
                            loginError = normalizeText(errorText);
                            break;
                        }
                    } catch {
                        // Frames frequently detach while ADFS / Duo redirects.
                    }
                }

                if (loginError) break;
            }

            if (loginError) {
                this.loginRequired = true;
                this.status(loginError, {
                    phase: "login-required",
                    connected: false,
                    loginRequired: true
                });
                throw new Error(loginError);
            }

            await pollDelay();
        }

        this.loginRequired = true;
        this.status("MFA/login did not finish. Try signing in again.", {
            phase: "login-required",
            connected: false,
            loginRequired: true
        });

        throw new Error("Timed out waiting for Duo/MFA or Cognos to finish signing in.");
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
                jobs.push({
                    term: group.term,
                    subject: group.subject,
                    course
                });
            }
        }

        if (!jobs.length) {
            throw new Error("No courses were selected.");
        }

        const allResults = [];
        let errors = 0;

        for (let i = 0; i < jobs.length; i++) {
            const job = jobs[i];

            const progress = {
                current: i + 1,
                total: jobs.length,
                term: job.term.text,
                subject: job.subject.text,
                course: job.course.text,
                errors
            };

            this.status(
                `Scraping ${job.term.text} — ${job.course.text}...`,
                { phase: "scraping", ...progress }
            );
            progressCallback(progress);

            try {
                const rows = await this.scrapeOneCourse(
                    job.term,
                    job.subject,
                    job.course
                );

                allResults.push(...rows);
            } catch (error) {
                errors++;
                allResults.push({
                    rowType: "error",
                    term: job.term.text,
                    subject: job.subject.text,
                    course: job.course.text,
                    courseNumber: job.course.value,
                    instructor: "ERROR",
                    section: "",
                    A: 0,
                    B: 0,
                    C: 0,
                    D: 0,
                    F: 0,
                    I: 0,
                    CR: 0,
                    P: 0,
                    NC: 0,
                    PR: 0,
                    W: 0,
                    O: 0,
                    error: error.message
                });

                this.status(
                    `Error on ${job.term.text} — ${job.course.text}: ${error.message}`,
                    { phase: "scraping", ...progress, errors }
                );
            }
        }

        const outputPath = this.generateHTML(allResults);
        const dataRows = allResults.filter(row => row.rowType === "data").length;

        this.status(
            `Complete. ${jobs.length} courses processed, ${dataRows} grade rows, ${errors} errors.`,
            {
                phase: "complete",
                current: jobs.length,
                total: jobs.length,
                errors,
                outputPath
            }
        );

        return {
            outputPath,
            jobs: jobs.length,
            rows: allResults.length,
            dataRows,
            errors
        };
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

    async scrapeOneCourse(term, subject, course) {
        let frame = await this.openFreshPrompt();

        await this.selectOption(frame, TERM_INDEX, term);

        const subjectReady = await this.waitForSelectReady(
            this.page,
            SUBJECT_INDEX,
            "subject",
            30000,
            subject
        );

        await this.selectOption(subjectReady.frame, SUBJECT_INDEX, subject);

        const courseReady = await this.waitForSelectReady(
            this.page,
            COURSE_INDEX,
            "course",
            30000,
            course
        );

        await this.selectOption(courseReady.frame, COURSE_INDEX, course);
        frame = await this.waitForFinishReady(this.page, 15000);
        await this.clickFinish(frame);

        const reportFrame = await this.findReportFrame(
            this.page,
            term.text,
            course.text,
            60000
        );

        const rows = await this.extractGradeTable(reportFrame);

        return rows.map(row => ({
            ...row,
            term: term.text,
            subject: subject.text,
            course: course.text,
            courseNumber: course.value
        }));
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
        return outputPath;
    }

}

module.exports = {
    TTUGradeScraper,
    COGNOS_URL,
    normalizeText,
    safeName
};
