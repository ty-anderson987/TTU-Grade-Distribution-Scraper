// Copyright 2026 Ty Anderson
// SPDX-License-Identifier: Apache-2.0

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { Worker } = require("worker_threads");
const { TTUGradeScraper, normalizeText } = require("./scraper");
const { TTUScheduleScraper } = require("./schedule-scraper");
const { CacheStore } = require("./cache-store");
const { RmpClient } = require("./rmp-client");
const { planParallelRanges, mergeParallelVerifiedOptions, partCoversRange } = require("./parallel-utils");
const { parseCourseList, normalizeCourseCode, analyzeSchedules, termValue, buildGradeSummary, instructorKey, optionDeliveryMode, optionIsHonors, primaryOptionComponents } = require("./schedule-engine");

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 3847);
const ROOT = __dirname;
const INDEX_FILE = path.join(ROOT, "index.html");
const SCHEDULE_FILE = path.join(ROOT, "schedule-analyzer.html");
const DATA_DIR = path.join(ROOT, "data");
const OUTPUT_DIR = path.join(ROOT, "output");
const PID_FILE = path.join(ROOT, ".server.pid");
const INSTANCE_ID = `${Date.now()}-${process.pid}`;
const LOCAL_HOSTS = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);
const LOCAL_ORIGINS = new Set([`http://${HOST}:${PORT}`, `http://localhost:${PORT}`, `http://[::1]:${PORT}`]);
const SECURITY_HEADERS = {
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-origin"
};

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

let state = {
    phase: "starting",
    message: "Starting local server...",
    connected: false,
    loginRequired: false,
    authStep: "none",
    authPhone: "",
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


let scheduleState = {
    phase: "starting",
    message: "Schedule Builder is starting...",
    connected: false,
    loginRequired: false,
    authStep: "none",
    authPhone: "",
    busy: false,
    terms: [],
    term: "",
    queueLength: 0,
    processingCourse: "",
    verificationQueueLength: 0,
    verificationCourse: "",
    lastError: null,
    updatedAt: new Date().toISOString()
};

function patchScheduleState(patch) {
    scheduleState = { ...scheduleState, ...patch, updatedAt: new Date().toISOString() };
}

const scheduleScraper = new TTUScheduleScraper({
    onStatus(update) {
        patchScheduleState(update);
        updateVerificationFromScheduleStatus(update);
        if (update.message) console.log(`[schedule] ${update.message}`);
    }
});

const MAX_SCHEDULE_PREFETCH_WORKERS = 5;
const MIN_PARALLEL_DEEP_RESULTS = 8;
const MIN_THREE_WAY_DEEP_RESULTS = 24;
const MIN_FOUR_WAY_DEEP_RESULTS = 60;
const MIN_FIVE_WAY_DEEP_RESULTS = 100;
let scheduleWorkerPool = [];
let scheduleWorkerPoolDisabledUntil = 0;
let scheduleWorkerPoolStartup = null;
let activeParallelVerificationProgress = null;

async function closeScheduleWorkerPool() {
    // If a worker is halfway through startup, let that startup settle first so a
    // just-created browser cannot escape the close and linger in the background.
    if (scheduleWorkerPoolStartup) {
        await scheduleWorkerPoolStartup.catch(() => {});
    }
    const workers = scheduleWorkerPool;
    scheduleWorkerPool = [];
    await Promise.allSettled(workers.map(worker => worker.close()));
}

async function ensureScheduleWorkerPool(count) {
    const wanted = Math.max(0, Math.min(MAX_SCHEDULE_PREFETCH_WORKERS - 1, Number(count) || 0));
    if (!wanted) return [];
    if (scheduleWorkerPool.length >= wanted) return scheduleWorkerPool.slice(0, wanted);
    if (Date.now() < scheduleWorkerPoolDisabledUntil) return scheduleWorkerPool.slice(0, wanted);

    // Prefetch, verification, and reconnect paths can all ask for workers. Serialize
    // creation so two near-simultaneous callers can never launch duplicate Chromium
    // workers beyond the configured 5-session cap.
    if (!scheduleWorkerPoolStartup) {
        scheduleWorkerPoolStartup = (async () => {
            const needed = wanted - scheduleWorkerPool.length;
            if (needed <= 0) return;
            const base = scheduleWorkerPool.length;
            console.log(`[schedule-workers] Starting ${needed} isolated Schedule Builder worker${needed === 1 ? "" : "s"}; ${1 + scheduleWorkerPool.length + needed} total VSB session${1 + scheduleWorkerPool.length + needed === 1 ? "" : "s"}.`);
            const attempts = Array.from({ length: needed }, (_, offset) => {
                const workerNumber = base + offset + 2;
                const statusBridge = { handler: null };
                return scheduleScraper.createParallelWorker({
                    onStatus(update) {
                        if (update.message) console.log(`[schedule-worker-${workerNumber}] ${update.message}`);
                        if (typeof statusBridge.handler === "function") statusBridge.handler(update);
                    }
                }).then(worker => {
                    worker.__workerNumber = workerNumber;
                    worker.__statusBridge = statusBridge;
                    return worker;
                });
            });
            const settled = await Promise.allSettled(attempts);
            let failed = 0;
            for (const result of settled) {
                if (result.status === "fulfilled") {
                    if (scheduleWorkerPool.length < MAX_SCHEDULE_PREFETCH_WORKERS - 1) {
                        scheduleWorkerPool.push(result.value);
                        console.log(`[schedule-workers] Isolated worker ready (${scheduleWorkerPool.length + 1}/${MAX_SCHEDULE_PREFETCH_WORKERS} total VSB sessions).`);
                    } else {
                        await result.value.close().catch(() => {});
                    }
                } else {
                    failed++;
                    console.warn(`[schedule-workers] Parallel worker unavailable; primary VSB remains active: ${result.reason?.message || result.reason}`);
                }
            }
            if (failed) scheduleWorkerPoolDisabledUntil = Date.now() + 60 * 1000;
        })();
    }

    try {
        await scheduleWorkerPoolStartup;
    } finally {
        scheduleWorkerPoolStartup = null;
    }

    // A first caller may have requested only one extra worker while a second caller
    // arrived wanting two. Make one bounded follow-up pass instead of racing startups.
    if (scheduleWorkerPool.length < wanted && Date.now() >= scheduleWorkerPoolDisabledUntil) {
        return await ensureScheduleWorkerPool(wanted);
    }
    return scheduleWorkerPool.slice(0, wanted);
}

function scheduleConnectedPatch(terms, message = "") {
    const selected = scheduleState.term && terms.includes(scheduleState.term) ? scheduleState.term : "";
    return {
        busy: false,
        connected: true,
        loginRequired: false,
        authStep: "none",
        authPhone: "",
        phase: selected ? "ready" : "choose-term",
        terms,
        term: selected,
        message: message || (selected
            ? `Connected to Schedule Builder. Planning ${selected}.`
            : `Connected to Schedule Builder. Choose a planning term (${terms.length} available).`)
    };
}

const v3CourseSearchCache = new Map();
function getCourseSearchCache(term, query) {
    const key = `${term}::${String(query || "").toUpperCase().trim()}`;
    const entry = v3CourseSearchCache.get(key);
    if (!entry || Date.now() - entry.at > 5 * 60 * 1000) {
        if (entry) v3CourseSearchCache.delete(key);
        return null;
    }
    return entry.results;
}
function setCourseSearchCache(term, query, results) {
    const key = `${term}::${String(query || "").toUpperCase().trim()}`;
    v3CourseSearchCache.set(key, { at: Date.now(), results });
    if (v3CourseSearchCache.size > 250) {
        const oldest = [...v3CourseSearchCache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 50);
        for (const [oldKey] of oldest) v3CourseSearchCache.delete(oldKey);
    }
}

const v3Cache = new CacheStore(path.join(DATA_DIR, "schedule-analyzer-cache.json"));
const rmpClient = new RmpClient({
    cachePath: path.join(DATA_DIR, "rmp-cache.json"),
    onStatus(message) { if (message) console.log(`[rmp] ${message}`); }
});
const v3Courses = new Map();
let v3Queue = [];
let v3WorkerRunning = false;
let v3PumpTimer = null;
let v3SchedulePrefetchPromise = null;
let v3SchedulePrefetchRequested = false;
let v3VerificationQueue = [];
let v3VerificationRunning = false;
let v3VerificationPauseRequested = false;
let lastScheduleInteractiveAt = Date.now();
let lastCourseChangeAt = Date.now();
let lastKeepAliveAt = 0;
let v3GradeTerms = [];
let v3GradeTermsForPlanningTerm = "";

// Schedule ranking is CPU-heavy when a course set has many section combinations.
// Run it off the HTTP event loop so course toggles, status polling, and the UI remain responsive.
const v3AnalysisJobs = new Map();
let v3ActiveAnalysisJob = null;
let v3AnalysisJobSeq = 0;
const V3_ANALYSIS_JOB_TTL = 2 * 60 * 1000;

function cleanupV3AnalysisJobs() {
    const cutoff = Date.now() - V3_ANALYSIS_JOB_TTL;
    for (const [id, job] of v3AnalysisJobs) {
        if ((job.finishedAt || job.createdAt) < cutoff && job.status !== "running") v3AnalysisJobs.delete(id);
    }
}

function cancelActiveV3Analysis(reason = "Superseded by a newer schedule request.") {
    const job = v3ActiveAnalysisJob;
    if (!job || job.status !== "running") return;
    job.status = "cancelled";
    job.message = reason;
    job.finishedAt = Date.now();
    if (job.worker) job.worker.terminate().catch(() => {});
    v3ActiveAnalysisJob = null;
}

function analysisRecordsWithRmp(records) {
    return records.map(record => {
        const rmpByProfessor = {};
        const seen = new Set();
        for (const option of record.options || []) {
            for (const component of primaryOptionComponents(option)) {
                const name = normalizeText(component?.instructor || "");
                const key = instructorKey(name);
                if (!key || seen.has(key)) continue;
                seen.add(key);
                const cached = rmpClient.getCached(name, record.courseCode);
                if (cached) rmpByProfessor[key] = cached;
            }
        }
        return { ...record, rmpByProfessor };
    });
}

function startV3Analysis(records, prefs, activeCourseCodes) {
    cancelActiveV3Analysis();
    cleanupV3AnalysisJobs();
    const analysisRecords = analysisRecordsWithRmp(records);
    const id = `${Date.now()}-${++v3AnalysisJobSeq}`;
    const job = {
        id,
        status: "running",
        percent: 3,
        stage: "prepare",
        message: "Preparing cached timetable data…",
        processed: 0,
        theoretical: 0,
        result: null,
        error: "",
        activeCourseCodes: [...activeCourseCodes],
        createdAt: Date.now(),
        finishedAt: 0,
        worker: null
    };
    const worker = new Worker(path.join(ROOT, "analysis-worker.js"), {
        workerData: {
            records: analysisRecords,
            prefs: prefs || {}
        }
    });
    job.worker = worker;
    v3AnalysisJobs.set(id, job);
    v3ActiveAnalysisJob = job;

    worker.on("message", message => {
        if (!message || job.status !== "running") return;
        if (message.type === "progress") {
            const p = message.progress || {};
            job.percent = Math.max(job.percent, Math.min(99, Number(p.percent || 0)));
            job.stage = String(p.stage || job.stage);
            job.message = String(p.message || job.message);
            job.processed = Number(p.processed || job.processed || 0);
            job.theoretical = Number(p.theoretical || job.theoretical || 0);
            return;
        }
        if (message.type === "result") {
            job.status = "complete";
            job.percent = 100;
            job.stage = "complete";
            job.message = "Schedule analysis complete.";
            job.result = { ...(message.result || {}), activeCourses: records.length, readyCourses: records.length, missing: [], activeCourseCodes: [...activeCourseCodes] };
            job.finishedAt = Date.now();
            if (v3ActiveAnalysisJob === job) v3ActiveAnalysisJob = null;
            return;
        }
        if (message.type === "error") {
            job.status = "error";
            job.error = String(message.error || "Schedule analysis failed.");
            job.message = job.error.split("\n")[0];
            job.finishedAt = Date.now();
            if (v3ActiveAnalysisJob === job) v3ActiveAnalysisJob = null;
        }
    });
    worker.on("error", error => {
        if (job.status !== "running") return;
        job.status = "error";
        job.error = error?.stack || error?.message || String(error);
        job.message = error?.message || "Schedule analysis worker failed.";
        job.finishedAt = Date.now();
        if (v3ActiveAnalysisJob === job) v3ActiveAnalysisJob = null;
    });
    worker.on("exit", code => {
        job.worker = null;
        if (job.status === "running") {
            // A worker that exits cleanly without ever posting a result is still a
            // failed analysis. Treat it as an error instead of leaving the UI stuck in
            // an eternal "running" state.
            job.status = "error";
            job.error = code === 0
                ? "Schedule analysis worker exited before returning a result."
                : `Schedule analysis worker exited with code ${code}.`;
            job.message = job.error;
            job.finishedAt = Date.now();
            if (v3ActiveAnalysisJob === job) v3ActiveAnalysisJob = null;
        }
    });
    return job;
}

function publicV3AnalysisJob(job) {
    if (!job) return null;
    const payload = {
        id: job.id,
        status: job.status,
        percent: Number(job.percent || 0),
        stage: job.stage || "",
        message: job.message || "",
        processed: Number(job.processed || 0),
        theoretical: Number(job.theoretical || 0),
        activeCourseCodes: job.activeCourseCodes || []
    };
    if (job.status === "complete") payload.result = job.result;
    if (job.status === "error") payload.error = job.error || job.message;
    return payload;
}

function verificationState(value = {}) {
    const status = ["pending", "running", "complete", "error"].includes(String(value.status || "")) ? String(value.status) : "pending";
    const percent = status === "complete" ? 100 : Math.max(0, Math.min(99, Number(value.percent || 0)));
    return {
        status,
        current: Math.max(0, Number(value.current || 0)),
        total: Math.max(0, Number(value.total || 0)),
        percent,
        message: String(value.message || (status === "complete" ? "Full semester timetable scan complete." : "Full semester timetable scan queued.")),
        updatedAt: value.updatedAt || new Date().toISOString()
    };
}

function updateVerificationFromScheduleStatus(update = {}) {
    if (update.phase !== "background-verification") return;
    const code = normalizeCourseCode(update.course || scheduleState.verificationCourse || scheduleState.processingCourse || "");
    if (!code) return;
    if (activeParallelVerificationProgress && activeParallelVerificationProgress.courseCode === code) {
        activeParallelVerificationProgress.update(0, update);
        return;
    }
    const record = v3Courses.get(code);
    if (!record) return;
    const current = Math.max(0, Number(update.current || 0));
    const total = Math.max(0, Number(update.total || record.scheduleTotalReported || 0));
    const weekCurrent = Math.max(0, Number(update.weekCurrent || 0));
    const weekTotal = Math.max(0, Number(update.weekTotal || 0));
    // For deep scans, interpolate within the current result so a one-option course does
    // not appear stuck at 96% while VSB walks every semester week.
    const fraction = total > 0
        ? Math.max(0, Math.min(1, weekTotal > 0 && current > 0
            ? ((current - 1) + Math.min(1, weekCurrent / weekTotal)) / total
            : current / total))
        : 0.05;
    const percent = Math.max(4, Math.min(96, Math.round(4 + fraction * 92)));
    record.verification = verificationState({
        ...(record.verification || {}),
        status: "running",
        current,
        total,
        percent,
        message: update.message || "Verifying the full semester timetable in the background..."
    });
    v3Courses.set(code, record);
}

function foregroundScheduleWorkPending() {
    return v3Queue.some(job => {
        if (job.forceSchedule) return true;
        const record = v3Courses.get(job.courseCode);
        return !(record && Array.isArray(record.options) && record.options.length);
    });
}

function activeTimetableLoadsPending() {
    const planningTerm = scheduleState.term;
    if (!planningTerm) return false;
    for (const record of v3Courses.values()) {
        if (!record || record.term !== planningTerm) continue;
        if (Array.isArray(record.options) && record.options.length) continue;
        // Do not let a permanently failed/auth-blocked/stale record hold every other
        // course forever. Only records that are actively queued for timetable work block.
        if (["queued", "loading-schedule"].includes(record.status)) return true;
    }
    return false;
}

function enqueueV3Verification(courseCode) {
    const code = normalizeCourseCode(courseCode);
    const record = v3Courses.get(code);
    if (!record || !Array.isArray(record.options) || !record.options.length) return;
    const current = verificationState(record.verification || {});
    if (current.status === "complete" || current.status === "running") return;
    if (!v3VerificationQueue.some(job => job.courseCode === code && job.term === record.term)) {
        v3VerificationQueue.push({ courseCode: code, term: record.term });
    }
    record.verification = verificationState({
        ...current,
        status: "pending",
        percent: Math.max(2, current.percent || 2),
        message: "Fast timetable loaded. Full semester scan will start after all active course timetables finish fast-loading."
    });
    v3Courses.set(code, record);
    patchScheduleState({ verificationQueueLength: v3VerificationQueue.length });
    pumpV3VerificationQueue().catch(error => console.error("[v3 verification]", error));
}

function createParallelVerificationProgress(courseCode, ranges, total) {
    const workerFractions = new Map();
    const rangeSizes = ranges.map(range => Math.max(1, range.end - range.start + 1));
    const totalWeight = rangeSizes.reduce((sum, value) => sum + value, 0) || Math.max(1, total);
    let lastSummaryBucket = -1;

    const update = (workerIndex, raw = {}) => {
        const range = ranges[workerIndex];
        if (!range || raw.phase !== "background-verification") return;
        const reportedTotal = Math.max(0, Number(raw.total || 0));
        if (reportedTotal && reportedTotal !== total) return;
        const rawCurrent = Number(raw.current || 0);
        if (rawCurrent && (rawCurrent < range.start || rawCurrent > range.end)) return;
        const current = rawCurrent || (range.direction === "backward" ? range.end : range.start);
        const weekCurrent = Math.max(0, Number(raw.weekCurrent || 0));
        const weekTotal = Math.max(0, Number(raw.weekTotal || 0));
        const positioning = raw.scanMode === "positioning" || raw.scanMode === "setup";
        let completed = 0;
        if (!positioning) {
            const before = range.direction === "backward" ? (range.end - current) : (current - range.start);
            const within = weekTotal > 0 ? Math.max(0, Math.min(1, weekCurrent / weekTotal)) : 1;
            completed = Math.max(0, Math.min(rangeSizes[workerIndex], before + within));
        }
        workerFractions.set(workerIndex, completed / rangeSizes[workerIndex]);

        let weighted = 0;
        for (let index = 0; index < ranges.length; index++) {
            weighted += (workerFractions.get(index) || 0) * rangeSizes[index];
        }
        const fraction = Math.max(0, Math.min(1, weighted / totalWeight));
        const verifiedPositions = Math.min(total, Math.floor(fraction * total));
        const summaryBucket = Math.floor(fraction * 10);
        if (summaryBucket > lastSummaryBucket && summaryBucket > 0) {
            lastSummaryBucket = summaryBucket;
            const lanes = ranges.map((_, index) => {
                const done = Math.min(rangeSizes[index], Math.floor((workerFractions.get(index) || 0) * rangeSizes[index]));
                return `W${index + 1} ${done}/${rangeSizes[index]}`;
            }).join(" | ");
            console.log(`[schedule-workers] ${courseCode} parallel progress: ${lanes} | combined ${verifiedPositions}/${total}.`);
        }
        const record = v3Courses.get(courseCode);
        if (!record) return;
        record.verification = verificationState({
            ...(record.verification || {}),
            status: "running",
            current: verifiedPositions,
            total,
            percent: Math.max(4, Math.min(96, Math.round(4 + fraction * 92))),
            message: `Parallel full-semester scan — ${verifiedPositions}/${total} VSB results verified across ${ranges.length} sessions.`
        });
        v3Courses.set(courseCode, record);
    };

    return { courseCode, update };
}

async function verifyV3CourseWithParallelVsb(job, record) {
    const shouldAbort = () => v3VerificationPauseRequested || foregroundScheduleWorkPending() || activeTimetableLoadsPending();
    const runSingle = async reason => {
        if (reason) console.warn(`[schedule-workers] ${job.courseCode}: ${reason} Falling back to the primary VSB full scan.`);
        return await scheduleScraper.scrapeCourseOptions(job.term, job.courseCode, {
            backgroundVerification: true,
            shouldAbort
        });
    };

    const expectedTotal = Math.max(1, Number(record.scheduleTotalReported || 0));
    if (expectedTotal < MIN_PARALLEL_DEEP_RESULTS) return await runSingle("");

    // Scale VSB deep verification only when the result set is large enough to amortize
    // each additional isolated Chromium session. Cognos remains capped separately at 2.
    const desiredSessions = expectedTotal >= MIN_FIVE_WAY_DEEP_RESULTS ? 5
        : expectedTotal >= MIN_FOUR_WAY_DEEP_RESULTS ? 4
        : expectedTotal >= MIN_THREE_WAY_DEEP_RESULTS ? 3
        : 2;
    let extraWorkers = [];
    try {
        extraWorkers = await ensureScheduleWorkerPool(desiredSessions - 1);
    } catch (error) {
        return await runSingle(`Could not start parallel VSB workers (${error.message}).`);
    }

    const sessions = [scheduleScraper, ...extraWorkers.slice(0, desiredSessions - 1)];
    if (sessions.length < 2) return await runSingle("No isolated VSB worker is available.");

    const sessionCount = sessions.length;
    const ranges = planParallelRanges(expectedTotal, sessionCount);
    const scanDescription = ranges.map((range, index) => {
        const first = range.direction === "backward" ? range.end : range.start;
        const last = range.direction === "backward" ? range.start : range.end;
        return `worker ${index + 1} scans ${first}→${last}`;
    }).join("; ");
    console.log(`[schedule-workers] Parallel deep verification: ${job.courseCode} — ${scanDescription}.`);

    const progress = createParallelVerificationProgress(job.courseCode, ranges, expectedTotal);
    activeParallelVerificationProgress = progress;
    for (let index = 1; index < sessions.length; index++) {
        const worker = sessions[index];
        if (worker?.__statusBridge) worker.__statusBridge.handler = update => progress.update(index, update);
    }

    const common = {
        backgroundVerification: true,
        shouldAbort,
        expectedResultTotal: expectedTotal
    };
    const sharedDetailCache = new Map();
    const runRange = (worker, range) => worker.scrapeCourseOptions(job.term, job.courseCode, {
        ...common,
        resultStart: range.start,
        resultEnd: range.end,
        resultDirection: range.direction,
        sharedDetailCache
    });

    let settled;
    try {
        settled = await Promise.allSettled(sessions.map((worker, index) => runRange(worker, ranges[index])));
    } finally {
        if (activeParallelVerificationProgress === progress) activeParallelVerificationProgress = null;
        for (let index = 1; index < sessions.length; index++) {
            const worker = sessions[index];
            if (worker?.__statusBridge) worker.__statusBridge.handler = null;
        }
    }

    const pauseFailure = settled.find(item => item.status === "rejected" && item.reason?.code === "BACKGROUND_PAUSED");
    if (pauseFailure) throw pauseFailure.reason;
    const primaryAuthFailure = settled[0]?.status === "rejected" && settled[0].reason?.code === "LOGIN_REQUIRED" ? settled[0].reason : null;
    if (primaryAuthFailure) throw primaryAuthFailure;

    const goodParts = new Array(ranges.length).fill(null);
    const healthySessions = [];

    const removeBrokenWorker = async (worker, reason) => {
        if (!worker || worker === scheduleScraper) return;
        const workerNumber = worker.__workerNumber || "?";
        console.warn(`[schedule-worker-${workerNumber}] ${job.courseCode} removed from the parallel pool: ${reason}`);
        worker.__parallelBroken = true;
        scheduleWorkerPool = scheduleWorkerPool.filter(candidate => candidate !== worker);
        await worker.close().catch(() => {});
        scheduleWorkerPoolDisabledUntil = Date.now() + 60 * 1000;
    };

    for (let index = 0; index < settled.length; index++) {
        const item = settled[index];
        const worker = sessions[index];
        const range = ranges[index];
        if (item.status === "fulfilled" && partCoversRange(item.value, range, expectedTotal)) {
            goodParts[index] = item.value;
            healthySessions.push(worker);
            continue;
        }

        const reason = item.status === "rejected"
            ? (item.reason?.message || String(item.reason))
            : `returned ${Number(item.value?.totalReported || 0) || "an unknown number of"} results or incomplete range coverage; expected ${expectedTotal}`;
        if (worker === scheduleScraper) {
            console.warn(`[schedule] ${job.courseCode} parallel range ${range.start}–${range.end} needs repair: ${reason}`);
        } else {
            await removeBrokenWorker(worker, reason);
        }
    }

    let repairCandidates = [...new Set(healthySessions)];
    // A bad primary range does not prove the primary session is unusable for all work, but
    // prefer sessions that already returned a complete, correctly-sized range first.
    if (!repairCandidates.length && settled[0]?.status === "fulfilled") repairCandidates.push(scheduleScraper);

    const missingRangeIndexes = goodParts.map((part, index) => part ? -1 : index).filter(index => index >= 0);
    for (const rangeIndex of missingRangeIndexes) {
        if (shouldAbort()) {
            const error = new Error("Background timetable verification paused for interactive work.");
            error.code = "BACKGROUND_PAUSED";
            throw error;
        }
        const range = ranges[rangeIndex];
        let repaired = null;
        let lastError = null;
        const candidates = repairCandidates.length ? [...repairCandidates] : [scheduleScraper];

        for (const worker of candidates) {
            const workerNumber = worker === scheduleScraper ? 1 : (worker.__workerNumber || "?");
            console.warn(`[schedule-workers] ${job.courseCode}: retrying only VSB results ${range.start}–${range.end} on worker ${workerNumber}; completed ranges are being kept.`);
            const latest = v3Courses.get(job.courseCode);
            if (latest) {
                latest.verification = verificationState({
                    ...(latest.verification || {}),
                    status: "running",
                    percent: Math.min(96, Math.max(6, Number(latest.verification?.percent || 6))),
                    message: `Repairing VSB results ${range.start}–${range.end}; already-verified ranges are being kept.`
                });
                v3Courses.set(job.courseCode, latest);
            }
            try {
                const part = await runRange(worker, range);
                if (partCoversRange(part, range, expectedTotal)) {
                    repaired = part;
                    break;
                }
                lastError = new Error(`worker ${workerNumber} returned an inconsistent result count or incomplete coverage`);
                if (worker !== scheduleScraper) {
                    await removeBrokenWorker(worker, lastError.message);
                    repairCandidates = repairCandidates.filter(candidate => candidate !== worker);
                }
            } catch (error) {
                if (error?.code === "BACKGROUND_PAUSED") throw error;
                if (worker === scheduleScraper && error?.code === "LOGIN_REQUIRED") throw error;
                lastError = error;
                if (worker !== scheduleScraper) {
                    await removeBrokenWorker(worker, error?.message || String(error));
                    repairCandidates = repairCandidates.filter(candidate => candidate !== worker);
                }
            }
        }

        // If every initially healthy isolated session failed the repair, make one last
        // narrow-range attempt on the primary before throwing away all completed work.
        if (!repaired && !candidates.includes(scheduleScraper)) {
            try {
                console.warn(`[schedule-workers] ${job.courseCode}: final targeted repair attempt for ${range.start}–${range.end} on primary worker 1.`);
                const part = await runRange(scheduleScraper, range);
                if (partCoversRange(part, range, expectedTotal)) repaired = part;
            } catch (error) {
                if (error?.code === "BACKGROUND_PAUSED" || error?.code === "LOGIN_REQUIRED") throw error;
                lastError = error;
            }
        }

        if (!repaired) {
            return await runSingle(`Targeted repair for VSB results ${range.start}–${range.end} failed (${lastError?.message || "unknown error"}).`);
        }
        goodParts[rangeIndex] = repaired;
    }

    let { merged, verifiedByKey, resultIndexes } = mergeParallelVerifiedOptions(record.options, goodParts);
    const expectedKeys = new Set((record.options || []).map(option => option.optionKey).filter(Boolean));
    let missingKeys = [...expectedKeys].filter(key => !verifiedByKey.has(key));
    let allResultIndexesCovered = resultIndexes.size === expectedTotal
        && Array.from({ length: expectedTotal }, (_, index) => index + 1).every(index => resultIndexes.has(index));

    // Never cache a partial merge. Targeted repair handles failed/inconsistent worker
    // ranges first; this full fallback is now only for a genuinely untrustworthy final merge.
    if (missingKeys.length || !allResultIndexesCovered) {
        const details = [
            missingKeys.length ? `${missingKeys.length} option key${missingKeys.length === 1 ? "" : "s"} missing` : "",
            !allResultIndexesCovered ? "result-index coverage incomplete" : ""
        ].filter(Boolean).join(", ");
        return await runSingle(`Parallel verification still did not pass its merge check after targeted repair (${details}).`);
    }

    const scanStats = goodParts.reduce((sum, part) => ({
        deepScans: sum.deepScans + Number(part?.scanStats?.deepScans || 0),
        fastReads: sum.fastReads + Number(part?.scanStats?.fastReads || 0),
        reusedDetailed: sum.reusedDetailed + Number(part?.scanStats?.reusedDetailed || 0),
        uniqueTimetablePatterns: sum.uniqueTimetablePatterns + Number(part?.scanStats?.uniqueTimetablePatterns || 0)
    }), { deepScans: 0, fastReads: 0, reusedDetailed: 0, uniqueTimetablePatterns: 0 });

    console.log(`[schedule-workers] Parallel deep verification complete: ${job.courseCode} — ${expectedTotal} VSB results covered across up to ${sessionCount} sessions.`);
    return {
        term: job.term,
        courseCode: job.courseCode,
        totalReported: expectedTotal,
        totalCaptured: merged.length,
        truncated: false,
        scanComplete: true,
        preliminary: false,
        parallelVerification: true,
        parallelVerificationWorkers: sessionCount,
        scanStats,
        options: merged
    };
}

async function pumpV3VerificationQueue() {
    if (v3VerificationRunning) return;
    v3VerificationRunning = true;
    try {
        while (v3VerificationQueue.length) {
            // Finish every active course's fast timetable pass before deep verification starts.
            // Grade-history work uses a different browser, so verification may continue while Cognos is busy.
            while (scheduleState.busy || foregroundScheduleWorkPending() || activeTimetableLoadsPending() || Date.now() - lastScheduleInteractiveAt < 1400) {
                await new Promise(resolve => setTimeout(resolve, 120));
            }

            const job = v3VerificationQueue.shift();
            const record = v3Courses.get(job.courseCode);
            if (!record || record.term !== job.term || !record.options?.length) continue;
            if (record.verification?.status === "complete") continue;

            v3VerificationPauseRequested = false;
            record.verification = verificationState({
                status: "running",
                current: 0,
                total: record.scheduleTotalReported || record.options.length || 1,
                percent: 4,
                message: "Background full-semester timetable verification starting..."
            });
            v3Courses.set(job.courseCode, record);
            patchScheduleState({
                busy: true,
                phase: "background-verification",
                processingCourse: job.courseCode,
                verificationCourse: job.courseCode,
                verificationQueueLength: v3VerificationQueue.length,
                current: 0,
                total: record.scheduleTotalReported || 0,
                message: `Verifying ${job.courseCode} across the full semester in the background...`
            });

            try {
                const verified = await verifyV3CourseWithParallelVsb(job, record);
                const latest = v3Courses.get(job.courseCode);
                if (!latest || latest.term !== job.term) continue;
                latest.options = verified.options || latest.options;
                latest.scheduleTotalReported = verified.totalReported || latest.scheduleTotalReported || latest.options.length;
                const conservativeFallbacks = (latest.options || []).filter(option => option.occurrenceCoverageComplete !== true).length;
                const verificationSummary = `Full semester scan complete — ${verified.scanStats?.deepScans || 0} detailed pattern${verified.scanStats?.deepScans === 1 ? "" : "s"}, ${verified.scanStats?.fastReads || 0} legend/calendar pattern${verified.scanStats?.fastReads === 1 ? "" : "s"}`
                    + (conservativeFallbacks ? `; ${conservativeFallbacks} option${conservativeFallbacks === 1 ? "" : "s"} kept the safer recurring-time fallback.` : ".");
                latest.verification = verificationState({
                    status: "complete",
                    current: latest.scheduleTotalReported,
                    total: latest.scheduleTotalReported,
                    percent: 100,
                    message: verificationSummary
                });
                v3Courses.set(job.courseCode, latest);
                const cached = v3Cache.get(job.term, job.courseCode) || {};
                v3Cache.set(job.term, job.courseCode, {
                    ...cached,
                    schedule: { ...verified, scanComplete: true },
                    gradeHistory: latest.gradeHistory || cached.gradeHistory || null,
                    gradeTermsKey: latest.gradeTermsKey || cached.gradeTermsKey || "",
                    requestedGradeTerms: latest.requestedGradeTerms || cached.requestedGradeTerms || []
                });
            } catch (error) {
                const latest = v3Courses.get(job.courseCode);
                if (error.code === "BACKGROUND_PAUSED" || error.code === "LOGIN_REQUIRED") {
                    if (latest && latest.term === job.term) {
                        const previous = verificationState(latest.verification || {});
                        latest.verification = verificationState({
                            ...previous,
                            status: "pending",
                            percent: Math.min(95, Math.max(4, previous.percent || 4)),
                            message: error.code === "LOGIN_REQUIRED"
                                ? "Full scan paused because the Schedule Builder session expired; reconnect to resume."
                                : "Full scan paused for interactive Schedule Builder work; it will resume automatically."
                        });
                        v3Courses.set(job.courseCode, latest);
                    }
                    if (!v3VerificationQueue.some(item => item.courseCode === job.courseCode && item.term === job.term)) {
                        v3VerificationQueue.push(job);
                    }
                } else if (latest && latest.term === job.term) {
                    latest.verification = verificationState({
                        ...(latest.verification || {}),
                        status: "error",
                        percent: Math.min(95, Math.max(4, Number(latest.verification?.percent || 4))),
                        message: `Full semester verification stopped: ${error.message}`
                    });
                    v3Courses.set(job.courseCode, latest);
                }
                if (error.code === "LOGIN_REQUIRED") {
                    patchScheduleState({ connected: false, loginRequired: true, phase: "login-required", message: "Schedule Builder sign-in expired during background verification." });
                    break;
                }
            } finally {
                patchScheduleState({
                    busy: false,
                    phase: scheduleState.connected ? "ready" : scheduleState.phase,
                    processingCourse: "",
                    verificationCourse: "",
                    verificationQueueLength: v3VerificationQueue.length,
                    current: 0,
                    total: 0,
                    message: scheduleState.connected ? `Planning ${scheduleState.term}. Background timetable verification ${v3VerificationQueue.length ? "will continue when idle." : "is up to date."}` : scheduleState.message
                });
            }

            // If foreground work requested the browser, yield immediately.
            if (v3VerificationPauseRequested || foregroundScheduleWorkPending()) {
                await new Promise(resolve => setTimeout(resolve, 160));
            }
        }
    } finally {
        v3VerificationRunning = false;
        patchScheduleState({ verificationQueueLength: v3VerificationQueue.length, verificationCourse: "" });
    }
}

function defaultCoursePreferences() {
    return { professorPriority: 3, delivery: "either", professors: {} };
}

function normalizeProfessorPreferences(value = {}) {
    const out = {};
    if (!value || typeof value !== "object") return out;
    for (const [nameOrKey, stateValue] of Object.entries(value)) {
        const state = String(stateValue || "").toLowerCase();
        if (!["prefer", "avoid"].includes(state)) continue;
        const key = instructorKey(nameOrKey);
        if (key) out[key] = state;
    }
    return out;
}

function normalizeCoursePreferences(value = {}) {
    const priority = Number(value.professorPriority ?? 3);
    const delivery = ["either", "in-person", "online"].includes(String(value.delivery || "either"))
        ? String(value.delivery || "either")
        : "either";
    return {
        professorPriority: Math.max(1, Math.min(5, Number.isFinite(priority) ? Math.round(priority) : 3)),
        delivery,
        professors: normalizeProfessorPreferences(value.professors || {})
    };
}

function eligibleGradeTerms(planningTerm = scheduleState.term) {
    if (!planningTerm || !Array.isArray(scraper.terms)) return [];
    const target = termValue(planningTerm);
    return scraper.terms
        .map(term => normalizeText(term.text))
        .filter(Boolean)
        .filter(term => !target || termValue(term) < target);
}

function ensureDefaultGradeTerms() {
    const planningTerm = scheduleState.term || "";
    if (!planningTerm) return;
    const eligible = eligibleGradeTerms(planningTerm);
    if (!eligible.length) return;
    const eligibleSet = new Set(eligible);
    const stillValid = v3GradeTerms.filter(term => eligibleSet.has(term));
    if (v3GradeTermsForPlanningTerm === planningTerm && stillValid.length === v3GradeTerms.length && v3GradeTerms.length) return;
    v3GradeTerms = eligible.slice(0, 6);
    v3GradeTermsForPlanningTerm = planningTerm;
}

function currentGradeTermsKey(terms = v3GradeTerms) {
    return [...terms].map(normalizeText).filter(Boolean).join("|");
}

function stableGradeTermEntry(entry) {
    if (!entry) return false;
    if (entry.status === "success") return true;
    // v3.0.7 intentionally rechecks negative cache entries from older builds. A
    // missing term is stable only when two fresh Cognos attempts agreed on the
    // same reason under the stricter verifier.
    return entry.status === "missing" && entry.negativeVerification === "same-reason-v2";
}

function gradeTermCacheFromCourseCache(cached = {}) {
    const out = {};
    const stored = cached.gradeHistoryByTerm && typeof cached.gradeHistoryByTerm === "object" ? cached.gradeHistoryByTerm : {};
    for (const [term, entry] of Object.entries(stored)) {
        if (entry?.status === "success") out[term] = entry;
        else if (entry?.status === "missing" && entry.negativeVerification === "same-reason-v2") out[term] = entry;
    }
    const history = cached.gradeHistory;
    if (!history || !Array.isArray(history.requestedTerms)) return out;

    const rowsByTerm = new Map();
    for (const row of Array.isArray(history.rows) ? history.rows : []) {
        const term = normalizeText(row.term);
        if (!term) continue;
        if (!rowsByTerm.has(term)) rowsByTerm.set(term, []);
        rowsByTerm.get(term).push(row);
    }
    const failed = new Set((history.failedTerms || []).map(normalizeText));
    const verifiedMissing = new Map();
    for (const result of Array.isArray(history.termResults) ? history.termResults : []) {
        const term = normalizeText(result.term);
        if (term && result.status === "missing" && Number(result.attempts || 0) >= 2 && result.negativeVerification === "same-reason-v2") {
            verifiedMissing.set(term, result);
        }
    }
    for (const term of history.requestedTerms.map(normalizeText).filter(Boolean)) {
        if (stableGradeTermEntry(out[term]) || failed.has(term)) continue;
        const rows = rowsByTerm.get(term) || [];
        if (rows.length) out[term] = { status: "success", rows, attempts: 1 };
        else if (verifiedMissing.has(term)) {
            const result = verifiedMissing.get(term);
            out[term] = { status: "missing", rows: [], attempts: Number(result.attempts || 2), reason: result.reason || "", negativeVerification: "same-reason-v2" };
        }
        // Do not trust legacy v3.0.2 `missingTerms` as permanent negatives. Those were
        // produced after a single Cognos path and are exactly the false-negative case
        // v3.0.3 is designed to re-check.
    }
    return out;
}

function mergeStableGradeTermResults(termCache, history) {
    const merged = { ...(termCache || {}) };
    for (const result of Array.isArray(history?.termResults) ? history.termResults : []) {
        const term = normalizeText(result.term);
        if (!term || !["success", "missing"].includes(result.status)) continue;
        merged[term] = {
            status: result.status,
            rows: result.status === "success" && Array.isArray(result.rows) ? result.rows : [],
            attempts: Math.max(1, Number(result.attempts || 1)),
            reason: result.reason || "",
            negativeVerification: result.status === "missing" ? "same-reason-v2" : "",
            cachedAt: new Date().toISOString()
        };
    }
    return merged;
}

function aggregateGradeHistory(courseCode, targetTerm, requestedTerms, termCache, failedTerms = []) {
    const rows = [];
    const terms = [];
    const missingTerms = [];
    const failed = new Set((failedTerms || []).map(normalizeText).filter(Boolean));
    const termResults = [];

    for (const rawTerm of requestedTerms || []) {
        const term = normalizeText(rawTerm);
        const entry = termCache?.[term];
        if (entry?.status === "success") {
            failed.delete(term);
            const termRows = Array.isArray(entry.rows) ? entry.rows : [];
            rows.push(...termRows);
            terms.push(term);
            termResults.push({ term, status: "success", rows: termRows, attempts: Number(entry.attempts || 1), error: "" });
        } else if (entry?.status === "missing") {
            failed.delete(term);
            missingTerms.push(term);
            termResults.push({ term, status: "missing", rows: [], attempts: Number(entry.attempts || 1), reason: entry.reason || "", negativeVerification: entry.negativeVerification || "", error: "" });
        } else {
            failed.add(term);
            termResults.push({ term, status: "failed", rows: [], attempts: 0, error: "Grade history was not verified." });
        }
    }

    return {
        courseCode,
        targetTerm,
        requestedTerms: [...(requestedTerms || [])],
        terms,
        missingTerms,
        failedTerms: [...failed],
        termResults,
        rows
    };
}

function gradeHistoryVerifiedForTerms(history, requestedTerms) {
    if (!history) return false;
    const requested = (requestedTerms || []).map(normalizeText).filter(Boolean);
    const positive = new Set((history.rows || []).map(row => normalizeText(row.term)).filter(Boolean));
    const verifiedMissing = new Set((history.termResults || [])
        .filter(result => result?.status === "missing" && Number(result.attempts || 0) >= 2 && result.negativeVerification === "same-reason-v2")
        .map(result => normalizeText(result.term))
        .filter(Boolean));
    const failed = new Set((history.failedTerms || []).map(normalizeText).filter(Boolean));
    return requested.every(term => !failed.has(term) && (positive.has(term) || verifiedMissing.has(term)));
}

function progressForCourse(record) {
    const status = record.status || "queued";
    if (status === "ready") return { stage: "ready", current: 1, total: 1, percent: 100 };
    if (status === "ready-partial") return { stage: "partial", current: 1, total: 1, percent: 100 };
    if (status === "error") return { stage: "error", current: 0, total: 1, percent: 0 };

    if (status === "loading-schedule") {
        const current = scheduleState.processingCourse === record.courseCode ? Number(scheduleState.current || 0) : 0;
        const total = scheduleState.processingCourse === record.courseCode ? Number(scheduleState.total || 0) : 0;
        const fraction = total > 0 ? Math.max(0, Math.min(1, current / total)) : 0.15;
        return { stage: "sections", current, total, percent: Math.round(5 + fraction * 40) };
    }

    if (status === "loading-grades") {
        const current = state.course === record.courseCode ? Number(state.current || 0) : 0;
        const total = state.course === record.courseCode ? Number(state.total || v3GradeTerms.length || 0) : Number(v3GradeTerms.length || 0);
        const fraction = total > 0 ? Math.max(0, Math.min(1, current / total)) : 0;
        return { stage: "grades", current, total, percent: Math.round(45 + fraction * 55) };
    }

    if (Array.isArray(record.options) && record.options.length) {
        return { stage: "grades-queued", current: 0, total: Number(v3GradeTerms.length || 0), percent: 45 };
    }
    return { stage: "queued", current: 0, total: 0, percent: 3 };
}

function publicV3Course(record) {
    const options = Array.isArray(record.options) ? record.options : [];
    const onlineOptionCount = options.filter(option => optionDeliveryMode(option) === "online").length;
    const inPersonOptionCount = options.filter(option => optionDeliveryMode(option) === "in-person").length;
    const honorsOptionCount = options.filter(option => optionIsHonors(option)).length;

    const gradeSummary = buildGradeSummary(record.gradeHistory || {}, record.term || "");
    const professorMap = new Map();
    for (const option of options) {
        // Professor controls represent the instructor(s) of record for the option.
        // Required zero-credit companion labs remain attached to the option/CRNs, but
        // do not appear as separate "professor" choices merely because a TA is named.
        for (const component of primaryOptionComponents(option)) {
            const name = normalizeText(component.instructor || "");
            if (!name || /^tba$/i.test(name)) continue;
            const key = instructorKey(name);
            if (!key) continue;
            if (!professorMap.has(key)) professorMap.set(key, { name, key, sections: new Set(), online: 0, inPerson: 0 });
            const item = professorMap.get(key);
            if (component.section) item.sections.add(component.section);
            if (optionDeliveryMode(option) === "online") item.online++; else item.inPerson++;
        }
    }
    const professorPrefs = normalizeCoursePreferences(record.preferences || defaultCoursePreferences()).professors;
    const professors = [...professorMap.values()].map(item => {
        const grade = gradeSummary.professors?.[item.key] || null;
        return {
            name: item.name,
            key: item.key,
            sections: [...item.sections],
            hasOnline: item.online > 0,
            hasInPerson: item.inPerson > 0,
            currentTerm: true,
            preference: professorPrefs[item.key] || "neutral",
            gpa: grade?.gpa ?? null,
            adjustedGpa: grade?.adjustedGpa ?? null,
            aRate: grade?.aRate ?? null,
            dfwRate: grade?.dfwRate ?? null,
            students: grade?.students ?? 0,
            trend: grade?.trend ?? null,
            predictedGpa: grade?.predictedGpa ?? null,
            predictionLow: grade?.predictionLow ?? null,
            predictionHigh: grade?.predictionHigh ?? null,
            predictionConfidence: grade?.predictionConfidence || "insufficient",
            regressionTerms: grade?.regressionTerms ?? 0,
            terms: Array.isArray(grade?.terms) ? grade.terms : [],
            rmp: rmpClient.getCached(item.name, record.courseCode)
        };
    }).sort((a, b) => {
        const av = Number.isFinite(a.adjustedGpa) ? a.adjustedGpa : -1;
        const bv = Number.isFinite(b.adjustedGpa) ? b.adjustedGpa : -1;
        return bv - av || a.name.localeCompare(b.name);
    });

    // Keep historical instructors separate from the instructors actually offered in the
    // selected Schedule Builder term.  The UI can optionally include these people in the
    // comparison view without implying that the student can currently register for them.
    const currentProfessorKeys = new Set(professors.map(item => item.key));
    const historicalProfessors = Object.entries(gradeSummary.professors || {})
        .filter(([key]) => !currentProfessorKeys.has(key))
        .map(([key, grade]) => ({
            name: grade?.name || key,
            key,
            sections: [],
            hasOnline: false,
            hasInPerson: false,
            currentTerm: false,
            preference: "neutral",
            gpa: grade?.gpa ?? null,
            adjustedGpa: grade?.adjustedGpa ?? null,
            aRate: grade?.aRate ?? null,
            dfwRate: grade?.dfwRate ?? null,
            students: grade?.students ?? 0,
            trend: grade?.trend ?? null,
            predictedGpa: grade?.predictedGpa ?? null,
            predictionLow: grade?.predictionLow ?? null,
            predictionHigh: grade?.predictionHigh ?? null,
            predictionConfidence: grade?.predictionConfidence || "insufficient",
            regressionTerms: grade?.regressionTerms ?? 0,
            terms: Array.isArray(grade?.terms) ? grade.terms : [],
            rmp: rmpClient.getCached(grade?.name || key, record.courseCode)
        }))
        .sort((a, b) => {
            const av = Number.isFinite(a.adjustedGpa) ? a.adjustedGpa : -1;
            const bv = Number.isFinite(b.adjustedGpa) ? b.adjustedGpa : -1;
            return bv - av || a.name.localeCompare(b.name);
        });

    return {
        courseCode: record.courseCode,
        term: record.term,
        status: record.status,
        message: record.message || "",
        optionCount: options.length,
        optionKeys: options.map(option => option.optionKey).filter(Boolean),
        onlineOptionCount,
        inPersonOptionCount,
        honorsOptionCount,
        scheduleTotalReported: record.scheduleTotalReported || 0,
        gradeTerms: Array.isArray(record.gradeHistory?.terms) ? record.gradeHistory.terms : [],
        gradeMissingTerms: Array.isArray(record.gradeHistory?.missingTerms) ? record.gradeHistory.missingTerms : [],
        gradeFailedTerms: Array.isArray(record.gradeHistory?.failedTerms) ? record.gradeHistory.failedTerms : [],
        requestedGradeTerms: Array.isArray(record.requestedGradeTerms) ? record.requestedGradeTerms : [],
        gradeRows: Array.isArray(record.gradeHistory?.rows) ? record.gradeHistory.rows.length : 0,
        gradeAvailable: Boolean(record.gradeHistory && Array.isArray(record.gradeHistory.rows) && record.gradeHistory.rows.length),
        gradeError: record.gradeError || "",
        courseGrade: gradeSummary.course || null,
        courseGradeTerms: Array.isArray(gradeSummary.courseTerms) ? gradeSummary.courseTerms : [],
        preferences: normalizeCoursePreferences(record.preferences || defaultCoursePreferences()),
        professors,
        historicalProfessors,
        progress: progressForCourse(record),
        verification: verificationState(record.verification || { status: "pending", percent: 0 }),
        cached: Boolean(record.cached),
        error: record.error || ""
    };
}

function publicV3State() {
    ensureDefaultGradeTerms();
    const eligible = eligibleGradeTerms();
    return {
        schedule: scheduleState,
        grade: {
            connected: state.connected,
            loginRequired: state.loginRequired,
            authStep: state.authStep,
            authPhone: state.authPhone,
            busy: state.busy,
            phase: state.phase,
            message: state.message,
            current: Number(state.current || 0),
            total: Number(state.total || 0),
            course: state.course || "",
            term: state.term || "",
            availableTerms: eligible,
            selectedTerms: [...v3GradeTerms],
            lastError: state.lastError
        },
        courses: Array.from(v3Courses.values()).map(publicV3Course),
        queueLength: v3Queue.length + (v3WorkerRunning ? 1 : 0),
        verificationQueueLength: v3VerificationQueue.length + (v3VerificationRunning ? 1 : 0),
        processing: v3WorkerRunning,
        verifying: v3VerificationRunning,
        selectedTerm: scheduleState.term || ""
    };
}

function v3Key(term, courseCode) {
    return `${term}::${courseCode}`;
}

function enqueueV3Course(courseCode, options = {}) {
    const opts = typeof options === "boolean" ? { forceAll: options } : (options || {});
    const forceSchedule = Boolean(opts.forceAll || opts.forceSchedule);
    const forceGrade = Boolean(opts.forceAll || opts.forceGrade);
    const term = scheduleState.term;
    if (!term) throw new Error("Choose a Schedule Builder term first.");
    const normalized = normalizeCourseCode(courseCode);
    if (!normalized) throw new Error(`Could not understand course code: ${courseCode}`);
    ensureDefaultGradeTerms();
    const requestedGradeTerms = [...v3GradeTerms];
    const requestedGradeKey = currentGradeTermsKey(requestedGradeTerms);

    let record = v3Courses.get(normalized);
    const preferences = normalizeCoursePreferences(record?.preferences || defaultCoursePreferences());
    if (!record || record.term !== term) {
        record = {
            courseCode: normalized,
            term,
            status: "queued",
            message: "Waiting to load course data...",
            options: [],
            gradeHistory: null,
            gradeTermsKey: "",
            requestedGradeTerms,
            preferences,
            cached: false,
            verification: verificationState({ status: "pending", percent: 0, message: "Waiting for timetable scan." }),
            error: ""
        };
        v3Courses.set(normalized, record);
    } else {
        record.preferences = preferences;
        record.requestedGradeTerms = requestedGradeTerms;
    }

    const cached = v3Cache.get(term, normalized);
    if (!forceSchedule && cached?.schedule?.options?.length && !record.options?.length) {
        record.options = cached.schedule.options;
        record.scheduleTotalReported = cached.schedule.totalReported || cached.schedule.options.length;
        record.cached = true;
        record.verification = verificationState(cached.schedule.scanComplete === true
            ? { status: "complete", percent: 100, current: record.scheduleTotalReported, total: record.scheduleTotalReported, message: "Full semester timetable scan loaded from verified cache." }
            : { status: "pending", percent: 2, message: "Fast timetable loaded from cache; full semester verification queued." });
    }

    const cachedGradeValid = !forceGrade && cached?.gradeHistory && !cached.gradeHistory.error &&
        cached.gradeTermsKey === requestedGradeKey && gradeHistoryVerifiedForTerms(cached.gradeHistory, requestedGradeTerms);
    if (!forceGrade && record.gradeHistory && record.gradeTermsKey === requestedGradeKey && gradeHistoryVerifiedForTerms(record.gradeHistory, requestedGradeTerms)) {
        record.gradeError = "";
        record.error = "";
        // Grade history can outlive a timetable cache entry (for example after a
        // partial/corrupt cache cleanup). Never mark the course ready unless the
        // Schedule Builder side is present too; otherwise queue only the missing
        // timetable work and reuse these already-verified grades.
        if (Array.isArray(record.options) && record.options.length) {
            record.status = "ready";
            record.message = "Loaded from active session cache.";
            v3Courses.set(normalized, record);
            if (record.verification?.status !== "complete") enqueueV3Verification(normalized);
            return record;
        }
    }
    if (cachedGradeValid) {
        record.gradeHistory = cached.gradeHistory;
        record.gradeTermsKey = requestedGradeKey;
        record.requestedGradeTerms = requestedGradeTerms;
        record.cached = true;
        record.gradeError = "";
        record.error = "";
        if (Array.isArray(record.options) && record.options.length) {
            record.status = "ready";
            record.message = "Loaded from local cache.";
            v3Courses.set(normalized, record);
            if (record.verification?.status !== "complete") enqueueV3Verification(normalized);
            return record;
        }
    }

    // V3.0.3 stores stable Cognos results per historical term. Expanding from 6 to
    // 12 terms therefore scrapes only the six new terms instead of repeating all 12.
    if (!forceGrade && cached) {
        const termCache = gradeTermCacheFromCourseCache(cached);
        const allCovered = requestedGradeTerms.every(term => stableGradeTermEntry(termCache[normalizeText(term)]));
        if (allCovered) {
            record.gradeHistory = aggregateGradeHistory(normalized, term, requestedGradeTerms, termCache);
            record.gradeTermsKey = requestedGradeKey;
            record.requestedGradeTerms = requestedGradeTerms;
            record.cached = true;
            record.gradeError = "";
            record.error = "";
            if (Array.isArray(record.options) && record.options.length) {
                record.status = "ready";
                record.message = "Loaded selected grade terms from local per-term cache.";
                v3Courses.set(normalized, record);
                if (record.verification?.status !== "complete") enqueueV3Verification(normalized);
                return record;
            }
        }
    }

    record.status = "queued";
    record.message = record.options?.length ? "Schedule sections ready; grade history queued..." : "Waiting to load course data...";
    record.error = "";

    const key = v3Key(term, normalized);
    const existingJob = v3Queue.find(item => item.key === key);
    if (existingJob) {
        existingJob.forceSchedule = existingJob.forceSchedule || forceSchedule;
        existingJob.forceGrade = existingJob.forceGrade || forceGrade;
        existingJob.gradeTerms = requestedGradeTerms;
        existingJob.gradeTermsKey = requestedGradeKey;
    } else {
        v3Queue.push({
            key,
            term,
            courseCode: normalized,
            forceSchedule,
            forceGrade,
            gradeTerms: requestedGradeTerms,
            gradeTermsKey: requestedGradeKey
        });
        patchScheduleState({ queueLength: v3Queue.length });
    }
    if (!v3WorkerRunning && !v3PumpTimer) {
        // A tiny batching window lets a pasted/multi-add list settle before the main
        // course processor begins. Schedule prefetch itself is independently kicked
        // below so courses added during Cognos work do not wait behind grade history.
        v3PumpTimer = setTimeout(() => {
            v3PumpTimer = null;
            pumpV3Queue().catch(error => console.error("[v3 worker]", error));
        }, 60);
        v3PumpTimer.unref?.();
    }
    if (scheduleState.connected && v3JobNeedsSchedulePrefetch({ term, courseCode: normalized, forceSchedule })) {
        requestV3SchedulePrefetch().catch(error => console.error("[v3 prefetch]", error));
    }
    return record;
}

async function processV3Course(job) {
    const { term, courseCode, forceSchedule, forceGrade } = job;
    const jobGradeTerms = Array.isArray(job.gradeTerms) ? [...job.gradeTerms] : [...v3GradeTerms];
    const jobGradeKey = job.gradeTermsKey || currentGradeTermsKey(jobGradeTerms);
    const active = () => v3Courses.get(courseCode)?.term === term;
    let record = v3Courses.get(courseCode) || { courseCode, term, options: [], gradeHistory: null, preferences: defaultCoursePreferences() };
    const cached = v3Cache.get(term, courseCode);

    let scheduleData = (!forceSchedule && Array.isArray(record.options) && record.options.length)
        ? { term, courseCode, options: record.options, totalReported: record.scheduleTotalReported || record.options.length, scanComplete: record.verification?.status === "complete" }
        : (!forceSchedule ? (cached?.schedule || null) : null);

    let gradeTermCache = gradeTermCacheFromCourseCache(cached || {});
    if (forceGrade) {
        // A forced refresh must not silently fall back to a stale success/missing entry
        // if the new Cognos request fails. Remove only the requested terms; successful
        // fresh results will be merged back below.
        for (const termName of jobGradeTerms) delete gradeTermCache[normalizeText(termName)];
    }
    let gradeHistory = null;
    if (!forceGrade && record.gradeHistory && record.gradeTermsKey === jobGradeKey && gradeHistoryVerifiedForTerms(record.gradeHistory, jobGradeTerms)) {
        gradeHistory = record.gradeHistory;
    } else if (!forceGrade && cached?.gradeHistory && !cached.gradeHistory.error && cached.gradeTermsKey === jobGradeKey && gradeHistoryVerifiedForTerms(cached.gradeHistory, jobGradeTerms)) {
        gradeHistory = cached.gradeHistory;
    } else if (!forceGrade && jobGradeTerms.every(termName => stableGradeTermEntry(gradeTermCache[normalizeText(termName)]))) {
        gradeHistory = aggregateGradeHistory(courseCode, term, jobGradeTerms, gradeTermCache);
    }

    if (!scheduleData?.options?.length) {
        if (!scheduleState.connected) {
            record.status = "waiting-schedule-login";
            record.message = "Sign in to Schedule Builder to continue.";
            if (active()) v3Courses.set(courseCode, record);
            throw Object.assign(new Error("Schedule Builder sign-in required."), { code: "SCHEDULE_LOGIN_REQUIRED" });
        }
        if (active()) {
            record.status = "loading-schedule";
            record.message = `Reading exact ${courseCode} sections from Schedule Builder...`;
            record.error = "";
            v3Courses.set(courseCode, record);
        }
        patchScheduleState({ busy: true, processingCourse: courseCode, current: 0, total: 0, phase: "schedule-course", message: `Loading ${courseCode} from Schedule Builder...` });
        scheduleData = await scheduleScraper.scrapeCourseOptions(term, courseCode, { preliminaryOnly: true });
        patchScheduleState({ busy: false, current: scheduleData.options.length, total: scheduleData.totalReported || scheduleData.options.length, phase: "ready", message: `Schedule sections loaded for ${courseCode}.` });
    }

    if (active()) {
        record = v3Courses.get(courseCode) || record;
        record.options = scheduleData.options || [];
        record.scheduleTotalReported = scheduleData.totalReported || record.options.length;
        record.verification = verificationState(scheduleData.scanComplete === true
            ? { status: "complete", percent: 100, current: record.scheduleTotalReported, total: record.scheduleTotalReported, message: "Full semester timetable scan complete." }
            : (record.verification || { status: "pending", percent: 2, message: "Fast timetable loaded. Full semester scan will start after all active course timetables finish fast-loading." }));
        record.requestedGradeTerms = jobGradeTerms;
        record.status = "loading-grades";
        record.message = jobGradeTerms.length
            ? `Found ${record.options.length} timetable option${record.options.length === 1 ? "" : "s"}. Loading ${jobGradeTerms.length} selected grade term${jobGradeTerms.length === 1 ? "" : "s"}...`
            : `Found ${record.options.length} timetable options. No grade-history terms selected.`;
        v3Courses.set(courseCode, record);

        // Queue verification now, but pumpV3VerificationQueue deliberately waits until
        // every active course has its fast timetable. This keeps all VSB capacity on the
        // initial course load so the calendar becomes usable before expensive week scans.
        if (scheduleData.scanComplete !== true) enqueueV3Verification(courseCode);
    }

    if (!gradeHistory && jobGradeTerms.length) {
        const termsToFetch = forceGrade
            ? [...jobGradeTerms]
            : jobGradeTerms.filter(termName => !stableGradeTermEntry(gradeTermCache[normalizeText(termName)]));
        let failedTerms = [];

        if (termsToFetch.length && state.connected && !state.loginRequired) {
            patchState({
                busy: true,
                current: 0,
                total: termsToFetch.length,
                course: courseCode,
                phase: "schedule-grade-history",
                message: `Loading ${termsToFetch.length} uncached grade term${termsToFetch.length === 1 ? "" : "s"} for ${courseCode} with 2 Cognos workers...`,
                lastError: null
            });
            try {
                const freshHistory = await scraper.scrapeCourseHistory(courseCode, term, 6, termsToFetch);
                gradeTermCache = mergeStableGradeTermResults(gradeTermCache, freshHistory);
                failedTerms = freshHistory.failedTerms || [];
                record.gradeError = failedTerms.length
                    ? `Could not verify ${failedTerms.length} grade-history term${failedTerms.length === 1 ? "" : "s"} after retrying.`
                    : "";
            } catch (error) {
                if (error.code === "LOGIN_REQUIRED") {
                    patchState({ connected: false, loginRequired: true, phase: "login-required", message: "Cognos sign-in expired. Reconnect to add grade history." });
                }
                failedTerms = [...termsToFetch];
                record.gradeError = error.message;
            } finally {
                patchState({ busy: false, current: 0, total: 0, course: "", phase: state.connected ? "ready" : state.phase });
            }
        } else if (termsToFetch.length) {
            failedTerms = [...termsToFetch];
            record.gradeError = "Grade Distribution sign-in required.";
        }

        gradeHistory = aggregateGradeHistory(courseCode, term, jobGradeTerms, gradeTermCache, failedTerms);
    }

    // The background VSB verifier can finish while Cognos is still loading. Never
    // let this foreground job overwrite a newly verified timetable with the earlier
    // provisional snapshot. Cache whichever schedule is currently most authoritative.
    const latestBeforeCache = v3Courses.get(courseCode);
    const cachedBeforeWrite = v3Cache.get(term, courseCode) || {};
    const verifiedScheduleFromMemory = latestBeforeCache?.verification?.status === "complete" && Array.isArray(latestBeforeCache.options) && latestBeforeCache.options.length
        ? {
            ...(cachedBeforeWrite.schedule || scheduleData || {}),
            term,
            courseCode,
            options: latestBeforeCache.options,
            totalReported: latestBeforeCache.scheduleTotalReported || latestBeforeCache.options.length,
            totalCaptured: latestBeforeCache.options.length,
            scanComplete: true,
            preliminary: false
        }
        : null;
    const scheduleForCache = verifiedScheduleFromMemory || (cachedBeforeWrite.schedule?.scanComplete === true ? cachedBeforeWrite.schedule : scheduleData);
    v3Cache.set(term, courseCode, {
        ...cachedBeforeWrite,
        schedule: scheduleForCache,
        gradeHistory,
        gradeHistoryByTerm: gradeTermCache,
        gradeTermsKey: jobGradeKey,
        requestedGradeTerms: jobGradeTerms
    });

    if (!active()) return;

    // If the student changed grade-history terms while this course was loading,
    // keep the section data but do not let stale grade results overwrite the new request.
    if (jobGradeKey !== currentGradeTermsKey()) {
        record = v3Courses.get(courseCode) || record;
        const verifiedInBackground = record.verification?.status === "complete" && Array.isArray(record.options) && record.options.length;
        if (!verifiedInBackground) {
            record.options = scheduleData.options || [];
            record.scheduleTotalReported = scheduleData.totalReported || record.options.length;
        }
        record.gradeHistory = null;
        record.gradeTermsKey = "";
        record.status = "queued";
        record.message = "Grade-history terms changed. Updating this course...";
        v3Courses.set(courseCode, record);
        enqueueV3Course(courseCode);
        return;
    }

    record = v3Courses.get(courseCode) || record;
    const verifiedInBackground = record.verification?.status === "complete" && Array.isArray(record.options) && record.options.length;
    if (!verifiedInBackground) {
        record.options = scheduleData.options || [];
        record.scheduleTotalReported = scheduleData.totalReported || record.options.length;
    }
    record.gradeHistory = gradeHistory;
    record.gradeTermsKey = jobGradeKey;
    record.requestedGradeTerms = jobGradeTerms;
    record.cached = Boolean(cached);
    const failedGradeCount = gradeHistory?.failedTerms?.length || 0;
    if (!failedGradeCount) record.gradeError = "";
    record.status = failedGradeCount ? "ready-partial" : "ready";
    record.message = gradeHistory?.rows?.length
        ? (failedGradeCount
            ? `Ready — ${record.options.length} timetable options and ${gradeHistory.terms.length}/${jobGradeTerms.length} selected grade terms found; ${failedGradeCount} term${failedGradeCount === 1 ? "" : "s"} could not be verified after retrying.`
            : `Ready — ${record.options.length} timetable options and ${gradeHistory.terms.length}/${jobGradeTerms.length} selected grade terms found.`)
        : (failedGradeCount
            ? `Ready — ${record.options.length} timetable options. Cognos could not verify ${failedGradeCount} selected grade term${failedGradeCount === 1 ? "" : "s"} after retrying; this is not being cached as "no history".`
            : `Ready — ${record.options.length} timetable options. No grade history was confirmed for the selected terms.`);
    record.error = "";
    v3Courses.set(courseCode, record);
    if (scheduleData.scanComplete === true) {
        record.verification = verificationState({ status: "complete", percent: 100, current: record.scheduleTotalReported, total: record.scheduleTotalReported, message: "Full semester timetable scan complete." });
        v3Courses.set(courseCode, record);
    } else {
        enqueueV3Verification(courseCode);
    }
}

function v3JobNeedsSchedulePrefetch(job) {
    const record = v3Courses.get(job.courseCode);
    if (!record || record.term !== job.term) return false;
    if (job.forceSchedule) return true;
    if (Array.isArray(record.options) && record.options.length) return false;
    const cached = v3Cache.get(job.term, job.courseCode);
    return !(cached?.schedule?.options?.length);
}

async function prefetchV3SchedulesBatch(jobs) {
    const candidates = jobs.filter(v3JobNeedsSchedulePrefetch);
    if (!candidates.length || !scheduleState.connected) return;

    let next = 0;
    let completed = 0;
    let loaded = 0;
    const retryOnPrimary = [];
    patchScheduleState({
        busy: true,
        phase: "schedule-prefetch",
        processingCourse: "",
        current: 0,
        total: candidates.length,
        message: `Fast-loading ${candidates.length} queued courses with up to ${Math.min(MAX_SCHEDULE_PREFETCH_WORKERS, candidates.length)} Schedule Builder sessions (5-session limit)...`
    });

    const storePrefetch = (job, scheduleData, workerIndex) => {
        const record = v3Courses.get(job.courseCode);
        if (!record || record.term !== job.term) return false;
        record.options = scheduleData.options || [];
        record.scheduleTotalReported = scheduleData.totalReported || record.options.length;
        record.cached = false;
        record.verification = verificationState(scheduleData.scanComplete === true
            ? { status: "complete", percent: 100, current: record.scheduleTotalReported, total: record.scheduleTotalReported, message: "Full semester timetable scan complete." }
            : { status: "pending", percent: 2, current: 0, total: record.scheduleTotalReported, message: "Fast timetable loaded. Full semester scan will start after all active course timetables finish fast-loading." });
        record.status = "loading-grades";
        record.message = `Fast timetable loaded by Schedule Builder worker ${workerIndex + 1}.`;
        v3Courses.set(job.courseCode, record);

        const cached = v3Cache.get(job.term, job.courseCode) || {};
        v3Cache.set(job.term, job.courseCode, {
            ...cached,
            schedule: scheduleData
        });
        return true;
    };

    const runWorker = async (worker, workerIndex, isPrimary = false) => {
        while (true) {
            const index = next++;
            if (index >= candidates.length) return;
            const job = candidates[index];
            try {
                const scheduleData = await worker.scrapeCourseOptions(job.term, job.courseCode, { preliminaryOnly: true });
                if (storePrefetch(job, scheduleData, workerIndex)) loaded++;
            } catch (error) {
                // A secondary VSB session can occasionally miss an exact course while the
                // proven primary session can still find it. Preserve parallel speed, but repair
                // only that missed fast-load on the primary before grade-history work continues.
                console.warn(`[schedule-worker-${workerIndex + 1}] ${job.courseCode} prefetch failed; ${isPrimary ? "primary retry will remain queued" : "queueing immediate primary repair"}: ${error.message}`);
                if (!isPrimary) retryOnPrimary.push(job);
                if (!isPrimary && (error.code === "LOGIN_REQUIRED" || error.code === "PARALLEL_WORKER_UNAVAILABLE")) {
                    worker.__parallelBroken = true;
                }
            } finally {
                completed++;
                patchScheduleState({
                    current: completed,
                    total: candidates.length,
                    message: `Fast timetable pass ${completed}/${candidates.length}; ${loaded} loaded so far with parallel Schedule Builder workers...`
                });
            }
        }
    };

    try {
        // The already-authenticated primary VSB starts immediately. Extra isolated sessions
        // spin up in parallel while it works, so worker startup never blocks the proven path.
        const primaryTask = runWorker(scheduleScraper, 0, true);
        const extraTask = ensureScheduleWorkerPool(Math.max(0, Math.min(MAX_SCHEDULE_PREFETCH_WORKERS - 1, candidates.length - 1)))
            .then(workers => Promise.all(workers.map((worker, index) => runWorker(worker, index + 1, false))));
        await Promise.all([primaryTask, extraTask]);

        // Repair isolated-worker exact-match misses immediately while the primary VSB is
        // already warm. This keeps the fast-timetable phase ahead of Cognos/deep scans
        // instead of making the user wait for a later queue cycle.
        const seen = new Set();
        for (const job of retryOnPrimary) {
            if (seen.has(job.key) || !v3JobNeedsSchedulePrefetch(job)) continue;
            seen.add(job.key);
            try {
                console.warn(`[schedule-workers] ${job.courseCode}: retrying fast timetable on primary VSB before grade-history processing continues.`);
                const scheduleData = await scheduleScraper.scrapeCourseOptions(job.term, job.courseCode, { preliminaryOnly: true });
                if (storePrefetch(job, scheduleData, 0)) loaded++;
            } catch (error) {
                // Leave the course in the normal queue. processV3Course will make the final
                // primary attempt and surface a real course error only if that also fails.
                console.warn(`[schedule-workers] ${job.courseCode}: immediate primary fast-load repair did not complete; normal course processing will retry: ${error.message}`);
            }
        }
    } finally {
        const broken = scheduleWorkerPool.filter(worker => worker.__parallelBroken);
        if (broken.length) {
            scheduleWorkerPool = scheduleWorkerPool.filter(worker => !worker.__parallelBroken);
            await Promise.allSettled(broken.map(worker => worker.close()));
            scheduleWorkerPoolDisabledUntil = Date.now() + 60 * 1000;
        }
        patchScheduleState({
            busy: false,
            phase: scheduleState.connected ? "ready" : scheduleState.phase,
            current: 0,
            total: 0,
            processingCourse: "",
            message: scheduleState.connected ? `Planning ${scheduleState.term}.` : scheduleState.message
        });
    }
}

async function requestV3SchedulePrefetch() {
    v3SchedulePrefetchRequested = true;
    if (v3SchedulePrefetchPromise) return v3SchedulePrefetchPromise;

    v3SchedulePrefetchPromise = (async () => {
        // Small coalescing window: if the user adds several courses quickly, launch
        // them as one parallel fast-timetable batch. New courses added while Cognos
        // is reading another course are picked up by the next loop immediately.
        await new Promise(resolve => setTimeout(resolve, 90));
        while (v3SchedulePrefetchRequested) {
            v3SchedulePrefetchRequested = false;
            if (!scheduleState.connected) break;

            if (v3VerificationRunning) v3VerificationPauseRequested = true;
            while (scheduleState.busy) {
                if (!scheduleState.connected) return;
                await new Promise(resolve => setTimeout(resolve, 90));
            }

            const batch = v3Queue.filter(v3JobNeedsSchedulePrefetch);
            if (!batch.length) break;
            await prefetchV3SchedulesBatch(batch);
        }
    })().finally(() => {
        v3SchedulePrefetchPromise = null;
        if (v3SchedulePrefetchRequested && scheduleState.connected) {
            requestV3SchedulePrefetch().catch(error => console.error("[v3 prefetch]", error));
        }
    });

    return v3SchedulePrefetchPromise;
}

async function pumpV3Queue() {
    if (v3WorkerRunning) return;
    v3WorkerRunning = true;
    try {
        while (v3Queue.length) {
            // Fast timetable data has priority over Cognos and deep verification. If
            // additional courses arrived while the previous course's grade history was
            // loading, this drains those VSB fast-loads first so the calendar becomes
            // usable without waiting for sequential grade-history jobs.
            await requestV3SchedulePrefetch();
            while (scheduleState.busy) await new Promise(resolve => setTimeout(resolve, 100));
            const job = v3Queue.shift();
            patchScheduleState({ queueLength: v3Queue.length, processingCourse: job.courseCode });
            try {
                await processV3Course(job);
            } catch (error) {
                const record = v3Courses.get(job.courseCode);
                if (record && record.term === job.term) {
                    if (error.code === "SCHEDULE_LOGIN_REQUIRED" || error.code === "LOGIN_REQUIRED") {
                        record.status = "waiting-login";
                        record.message = error.message;
                    } else {
                        record.status = "error";
                        record.error = error.message;
                        record.message = error.message;
                    }
                    v3Courses.set(job.courseCode, record);
                }
                patchScheduleState({ lastError: error.message, message: error.message });
                if (error.code === "SCHEDULE_LOGIN_REQUIRED") break;
            }
        }
    } finally {
        v3WorkerRunning = false;
        patchScheduleState({ busy: false, queueLength: v3Queue.length, processingCourse: "", phase: scheduleState.connected ? "ready" : scheduleState.phase });
        if (v3VerificationQueue.length) pumpV3VerificationQueue().catch(error => console.error("[v3 verification]", error));
    }
}

function resumeV3Queue() {
    for (const record of v3Courses.values()) {
        if (["waiting-login", "waiting-schedule-login", "queued", "error"].includes(record.status)) {
            try { enqueueV3Course(record.courseCode); } catch {}
        }
        if (record.verification?.status !== "complete" && Array.isArray(record.options) && record.options.length) {
            try { enqueueV3Verification(record.courseCode); } catch {}
        }
    }
    if (v3VerificationQueue.length) pumpV3VerificationQueue().catch(error => console.error("[v3 verification]", error));
}

function localRequestAllowed(req) {
    const host = String(req.headers.host || "").toLowerCase();
    if (!LOCAL_HOSTS.has(host)) return false;

    // Browser cross-site form/fetch requests can reach localhost even though this app
    // binds only to 127.0.0.1. Reject cross-site state changes so a random webpage
    // cannot trigger reconnects, change preferences, or call /api/shutdown.
    if (!["GET", "HEAD", "OPTIONS"].includes(String(req.method || "GET").toUpperCase())) {
        const site = String(req.headers["sec-fetch-site"] || "").toLowerCase();
        if (site === "cross-site") return false;
        const origin = String(req.headers.origin || "").trim();
        if (origin && !LOCAL_ORIGINS.has(origin)) return false;
    }
    return true;
}

function json(res, statusCode, data) {
    const body = JSON.stringify(data);
    res.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        ...SECURITY_HEADERS
    });
    res.end(body);
}

function text(res, statusCode, body, contentType = "text/plain; charset=utf-8") {
    res.writeHead(statusCode, {
        "Content-Type": contentType,
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        ...SECURITY_HEADERS
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

        if (req.method === "GET" && url.pathname === "/api/v3/status") {
            return json(res, 200, publicV3State());
        }

        if (req.method === "POST" && (url.pathname === "/api/rmp/batch" || url.pathname === "/api/v3/rmp/batch")) {
            const body = await readJSON(req);
            const rawItems = Array.isArray(body.items) ? body.items : [];
            const seen = new Set();
            const items = [];
            for (const raw of rawItems.slice(0, 40)) {
                const name = normalizeText(raw?.name || "");
                const courseCode = normalizeCourseCode(raw?.courseCode || "");
                if (!name) continue;
                const key = `${instructorKey(name)}::${courseCode}`;
                if (!key || seen.has(key)) continue;
                seen.add(key);
                items.push({ name, courseCode });
            }
            if (!items.length) return json(res, 200, { results: [] });
            const results = await rmpClient.lookupBatch(items, 3);
            return json(res, 200, { results });
        }

        if (req.method === "POST" && url.pathname === "/api/v3/schedule/login") {
            if (scheduleState.busy) return json(res, 409, { error: "Schedule Builder is already busy." });
            const body = await readJSON(req);
            patchScheduleState({ busy: true, connected: false, loginRequired: false, phase: "signing-in", message: "Signing in to Schedule Builder...", lastError: null });
            try {
                await closeScheduleWorkerPool();
                scheduleWorkerPoolDisabledUntil = 0;
                const terms = await scheduleScraper.login(String(body.username || ""), String(body.password || ""));
                if (!terms.length && scheduleScraper.authStep !== "none") {
                    patchScheduleState({
                        busy: false,
                        connected: false,
                        loginRequired: scheduleScraper.authStep === "login-required",
                        authStep: scheduleScraper.authStep,
                        authPhone: scheduleScraper.authPhone || "",
                        phase: scheduleScraper.authStep
                    });
                    return json(res, 200, { ok: true, terms: [], authStep: scheduleScraper.authStep, authPhone: scheduleScraper.authPhone || "" });
                }
                patchScheduleState(scheduleConnectedPatch(terms));
                if (scheduleState.term) resumeV3Queue();
                return json(res, 200, { ok: true, terms, term: scheduleState.term });
            } catch (error) {
                patchScheduleState({ busy: false, connected: false, loginRequired: true, phase: "login-required", lastError: error.message, message: error.message });
                return json(res, 401, { error: error.message, loginRequired: true });
            }
        }

        if (req.method === "POST" && url.pathname === "/api/v3/schedule/mfa/send") {
            if (scheduleState.busy) return json(res, 409, { error: "Schedule Builder is already busy." });
            const body = await readJSON(req);
            const method = String(body.method || "sms").toLowerCase() === "voice" ? "voice" : "sms";
            patchScheduleState({ busy: true, phase: "mfa-sending", message: method === "voice" ? "Requesting Schedule Builder verification call..." : "Requesting Schedule Builder verification text...", lastError: null });
            try {
                const terms = await scheduleScraper.sendMfa(method);
                if (terms.length) {
                    patchScheduleState(scheduleConnectedPatch(terms));
                    if (scheduleState.term) resumeV3Queue();
                } else {
                    patchScheduleState({ busy: false, connected: false, loginRequired: false, authStep: scheduleScraper.authStep, authPhone: scheduleScraper.authPhone || scheduleState.authPhone || "", phase: scheduleScraper.authStep });
                }
                return json(res, 200, { ok: true, terms, authStep: scheduleScraper.authStep, authPhone: scheduleScraper.authPhone || "" });
            } catch (error) {
                patchScheduleState({ busy: false, connected: false, authStep: scheduleScraper.authStep || "mfa-method", phase: scheduleScraper.authStep || "mfa-method", lastError: error.message, message: error.message });
                return json(res, 400, { error: error.message, authStep: scheduleScraper.authStep || "mfa-method" });
            }
        }

        if (req.method === "POST" && url.pathname === "/api/v3/schedule/mfa/verify") {
            if (scheduleState.busy) return json(res, 409, { error: "Schedule Builder is already busy." });
            const body = await readJSON(req);
            patchScheduleState({ busy: true, phase: "mfa-verifying", message: "Verifying Schedule Builder code...", lastError: null });
            try {
                const terms = await scheduleScraper.verifyMfa(String(body.code || ""), Boolean(body.registerBrowser));
                if (terms.length) {
                    patchScheduleState(scheduleConnectedPatch(terms));
                    if (scheduleState.term) resumeV3Queue();
                } else {
                    patchScheduleState({ busy: false, connected: false, authStep: scheduleScraper.authStep, authPhone: scheduleScraper.authPhone || "", phase: scheduleScraper.authStep });
                }
                return json(res, 200, { ok: true, terms, authStep: scheduleScraper.authStep });
            } catch (error) {
                const phase = error.code === "MFA_CODE_ERROR" ? "mfa-code" : (scheduleScraper.authStep || "mfa-code");
                patchScheduleState({ busy: false, connected: false, authStep: phase, phase, lastError: error.message, message: error.message });
                return json(res, 400, { error: error.message, authStep: phase });
            }
        }

        if (req.method === "GET" && url.pathname === "/api/v3/schedule/auth-preview") {
            try {
                const png = await scheduleScraper.getAuthPreview();
                res.writeHead(200, { "Content-Type": "image/png", "Content-Length": png.length, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...SECURITY_HEADERS });
                res.end(png);
                return;
            } catch (error) {
                return json(res, 404, { error: error.message });
            }
        }

        if (req.method === "POST" && url.pathname === "/api/v3/schedule/reconnect") {
            if (scheduleState.busy) return json(res, 409, { error: "Schedule Builder is already busy." });
            patchScheduleState({ busy: true, connected: false, loginRequired: false, phase: "connecting", message: "Reconnecting to Schedule Builder...", lastError: null });
            try {
                await closeScheduleWorkerPool();
                scheduleWorkerPoolDisabledUntil = 0;
                await scheduleScraper.close();
                const terms = await scheduleScraper.connect();
                if (!terms.length && scheduleScraper.authStep !== "none") {
                    patchScheduleState({ busy: false, connected: false, loginRequired: scheduleScraper.authStep === "login-required", authStep: scheduleScraper.authStep, authPhone: scheduleScraper.authPhone || "", phase: scheduleScraper.authStep });
                    return json(res, 200, { terms: [], loginRequired: scheduleScraper.authStep === "login-required", authStep: scheduleScraper.authStep, authPhone: scheduleScraper.authPhone || "" });
                }
                patchScheduleState(scheduleConnectedPatch(terms));
                if (scheduleState.term) resumeV3Queue();
                return json(res, 200, { terms, term: scheduleState.term });
            } catch (error) {
                patchScheduleState({ busy: false, phase: "error", lastError: error.message, message: error.message });
                return json(res, 500, { error: error.message });
            }
        }

        if (req.method === "POST" && url.pathname === "/api/v3/term") {
            const body = await readJSON(req);
            const term = normalizeText(String(body.term || ""));
            lastScheduleInteractiveAt = Date.now();
            if (!term || !scheduleState.terms.includes(term)) return json(res, 400, { error: "Choose a valid Schedule Builder term." });
            if (!scheduleState.connected) return json(res, 401, { error: "Connect to Schedule Builder first." });
            if (scheduleState.busy && scheduleState.phase === "background-verification") {
                v3VerificationPauseRequested = true;
                const deadline = Date.now() + 3500;
                while (scheduleState.busy && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 80));
            }
            if (scheduleState.busy || v3WorkerRunning) return json(res, 409, { error: "Wait for the current foreground Schedule Builder task to finish before changing terms." });

            const changed = term !== scheduleState.term;
            patchScheduleState({ busy: true, phase: "selecting-term", message: `Opening ${term} in Schedule Builder...`, lastError: null });
            try {
                await scheduleScraper.setTerm(term);
                patchScheduleState({ busy: false, connected: true, loginRequired: false, authStep: "none", phase: "ready", term, message: `Planning ${term}. Start typing a course below.` });
            } catch (error) {
                if (error.code === "LOGIN_REQUIRED") {
                    patchScheduleState({ busy: false, connected: false, loginRequired: true, phase: "login-required", message: "Schedule Builder sign-in expired.", lastError: error.message });
                    return json(res, 401, { error: error.message, loginRequired: true });
                }
                patchScheduleState({ busy: false, phase: "error", message: error.message, lastError: error.message });
                return json(res, 400, { error: error.message });
            }

            if (changed) {
                lastCourseChangeAt = Date.now();
                v3Queue = [];
                v3VerificationPauseRequested = true;
                v3VerificationQueue = [];
                v3GradeTerms = [];
                v3GradeTermsForPlanningTerm = "";
                ensureDefaultGradeTerms();
                const codes = Array.from(v3Courses.keys());
                for (const code of codes) {
                    const previous = v3Courses.get(code);
                    v3Courses.set(code, {
                        courseCode: code,
                        term,
                        status: "queued",
                        message: `Reloading ${code} for ${term}...`,
                        options: [],
                        gradeHistory: null,
                        gradeTermsKey: "",
                        requestedGradeTerms: [...v3GradeTerms],
                        preferences: normalizeCoursePreferences(previous?.preferences || defaultCoursePreferences()),
                        cached: false,
                        verification: verificationState({ status: "pending", percent: 0, message: "Waiting for timetable scan." }),
                        error: ""
                    });
                    enqueueV3Course(code);
                }
            } else {
                ensureDefaultGradeTerms();
            }
            return json(res, 200, publicV3State());
        }

        if (req.method === "POST" && url.pathname === "/api/v3/grade-terms") {
            const body = await readJSON(req);
            if (!scheduleState.term) return json(res, 400, { error: "Choose a planning term first." });
            const eligible = eligibleGradeTerms(scheduleState.term);
            if (!eligible.length) return json(res, 400, { error: "Connect to Grade Distribution / Cognos to load historical terms first." });
            const requested = Array.isArray(body.terms) ? body.terms.map(value => normalizeText(String(value || ""))).filter(Boolean) : [];
            const requestedSet = new Set(requested);
            const selected = eligible.filter(termName => requestedSet.has(termName));
            if (!selected.length) return json(res, 400, { error: "Select at least one historical grade-distribution term." });
            if (selected.length > 30) return json(res, 400, { error: "Select at most 30 grade-history terms at a time." });

            const nextKey = currentGradeTermsKey(selected);
            const currentKey = currentGradeTermsKey();
            v3GradeTerms = selected;
            v3GradeTermsForPlanningTerm = scheduleState.term;
            if (nextKey !== currentKey) {
                lastCourseChangeAt = Date.now();
                v3Queue = v3Queue.filter(job => job.term !== scheduleState.term);
                for (const [code, record] of v3Courses.entries()) {
                    if (record.term !== scheduleState.term) continue;
                    record.gradeHistory = null;
                    record.gradeTermsKey = "";
                    record.requestedGradeTerms = [...selected];
                    record.status = "queued";
                    record.message = `Grade terms changed. Updating ${code} without reloading sections...`;
                    record.error = "";
                    v3Courses.set(code, record);
                    enqueueV3Course(code);
                }
            }
            return json(res, 202, { ok: true, state: publicV3State() });
        }

        if (req.method === "GET" && url.pathname === "/api/v3/schedule/course-search") {
            const term = normalizeText(String(url.searchParams.get("term") || scheduleState.term || ""));
            const query = normalizeText(String(url.searchParams.get("q") || ""));
            if (!scheduleState.connected) return json(res, 200, { suggestions: [], connected: false, message: "Connect to Schedule Builder first." });
            if (!term || !scheduleState.terms.includes(term)) return json(res, 200, { suggestions: [], message: "Choose a planning term first." });
            if (query.length < 2) return json(res, 200, { suggestions: [] });
            lastScheduleInteractiveAt = Date.now();

            const cached = getCourseSearchCache(term, query);
            if (cached) return json(res, 200, { suggestions: cached, cached: true, term });
            if (scheduleState.busy) {
                if (scheduleState.phase === "background-verification") v3VerificationPauseRequested = true;
                return json(res, 200, { suggestions: [], busy: true, term, message: scheduleState.phase === "background-verification"
                    ? "Pausing background semester verification for course search..."
                    : "Schedule Builder is loading section data. Search will resume automatically." });
            }

            patchScheduleState({ busy: true, phase: "course-search", message: `Searching ${term} courses...`, lastError: null });
            try {
                const suggestions = await scheduleScraper.searchCourseSuggestions(query, term, 10);
                setCourseSearchCache(term, query, suggestions);
                patchScheduleState({ busy: false, phase: "ready", term, message: `Planning ${term}.` });
                return json(res, 200, { suggestions, term });
            } catch (error) {
                if (error.code === "LOGIN_REQUIRED") {
                    patchScheduleState({ busy: false, connected: false, loginRequired: true, phase: "login-required", message: "Schedule Builder sign-in expired.", lastError: error.message });
                    return json(res, 401, { error: error.message, loginRequired: true });
                }
                patchScheduleState({ busy: false, phase: "ready", message: `Planning ${term}.`, lastError: error.message });
                return json(res, 200, { suggestions: [], term, warning: error.message });
            }
        }

        if (req.method === "POST" && url.pathname === "/api/v3/courses/add") {
            const body = await readJSON(req);
            const parsed = parseCourseList(Array.isArray(body.courses) ? body.courses : String(body.input || ""));
            if (!parsed.courses.length) return json(res, 400, { error: "Enter at least one course such as ECE 3303 or MATH 1451.", invalid: parsed.invalid });
            if (!scheduleState.term) return json(res, 400, { error: "Choose a Schedule Builder term first." });
            const existing = new Set(v3Courses.keys());
            const totalAfter = new Set([...existing, ...parsed.courses]);
            if (totalAfter.size > 12) return json(res, 400, { error: "Schedule Analyzer supports up to 12 active courses at a time." });
            lastCourseChangeAt = Date.now();
            lastScheduleInteractiveAt = Date.now();
            if (scheduleState.phase === "background-verification") v3VerificationPauseRequested = true;
            for (const code of parsed.courses) enqueueV3Course(code, Boolean(body.force));
            return json(res, 202, { ok: true, courses: parsed.courses, invalid: parsed.invalid, state: publicV3State() });
        }

        if (req.method === "POST" && url.pathname === "/api/v3/courses/delete") {
            const body = await readJSON(req);
            const code = normalizeCourseCode(String(body.courseCode || ""));
            if (!code) return json(res, 400, { error: "Invalid course code." });
            v3Courses.delete(code);
            v3Queue = v3Queue.filter(job => job.courseCode !== code);
            v3VerificationQueue = v3VerificationQueue.filter(job => job.courseCode !== code);
            if (scheduleState.verificationCourse === code) v3VerificationPauseRequested = true;
            lastCourseChangeAt = Date.now();
            return json(res, 200, { ok: true, state: publicV3State() });
        }

        if (req.method === "POST" && url.pathname === "/api/v3/courses/retry") {
            const body = await readJSON(req);
            const code = normalizeCourseCode(String(body.courseCode || ""));
            if (!code || !v3Courses.has(code)) return json(res, 404, { error: "Course is not active." });
            const record = v3Courses.get(code);
            record.status = "queued";
            record.error = "";
            record.message = "Retrying...";
            record.verification = verificationState({ status: "pending", percent: 0, message: "Timetable verification will restart after section loading." });
            v3VerificationQueue = v3VerificationQueue.filter(job => job.courseCode !== code);
            if (scheduleState.verificationCourse === code) v3VerificationPauseRequested = true;
            enqueueV3Course(code, { forceAll: Boolean(body.force) });
            return json(res, 202, { ok: true });
        }

        if (req.method === "POST" && url.pathname === "/api/v3/courses/verify") {
            const body = await readJSON(req);
            const code = normalizeCourseCode(String(body.courseCode || ""));
            if (!code || !v3Courses.has(code)) return json(res, 404, { error: "Course is not active." });
            const record = v3Courses.get(code);
            if (!Array.isArray(record.options) || !record.options.length) return json(res, 409, { error: "Load the course timetable first." });
            record.verification = verificationState({ status: "pending", percent: 2, message: "Full semester timetable verification queued again." });
            v3Courses.set(code, record);
            v3VerificationQueue = v3VerificationQueue.filter(job => job.courseCode !== code);
            if (scheduleState.verificationCourse === code) v3VerificationPauseRequested = true;
            enqueueV3Verification(code);
            return json(res, 202, { ok: true, course: publicV3Course(record) });
        }

        if (req.method === "POST" && url.pathname === "/api/v3/courses/preferences") {
            const body = await readJSON(req);
            const code = normalizeCourseCode(String(body.courseCode || ""));
            if (!code || !v3Courses.has(code)) return json(res, 404, { error: "Course is not active." });
            const record = v3Courses.get(code);
            const currentPrefs = normalizeCoursePreferences(record.preferences || defaultCoursePreferences());
            const professorPrefs = { ...currentPrefs.professors };
            if (body.professorName !== undefined) {
                const key = instructorKey(String(body.professorName || ""));
                const pref = String(body.professorPreference || "neutral").toLowerCase();
                if (!key) return json(res, 400, { error: "Professor name was not valid." });
                if (pref === "neutral") delete professorPrefs[key];
                else if (["prefer", "avoid"].includes(pref)) professorPrefs[key] = pref;
                else return json(res, 400, { error: "Professor preference must be prefer, neutral, or avoid." });
            }
            record.preferences = normalizeCoursePreferences({
                professorPriority: body.professorPriority ?? currentPrefs.professorPriority,
                delivery: body.delivery ?? currentPrefs.delivery,
                professors: body.professors ?? professorPrefs
            });
            v3Courses.set(code, record);
            lastCourseChangeAt = Date.now();
            return json(res, 200, { ok: true, course: publicV3Course(record) });
        }

        if (req.method === "POST" && url.pathname === "/api/v3/analyze/start") {
            const body = await readJSON(req);
            const requestedCodes = Array.isArray(body.courseCodes)
                ? [...new Set(body.courseCodes.map(normalizeCourseCode).filter(Boolean))]
                : [];
            const requestedSet = requestedCodes.length ? new Set(requestedCodes) : null;
            const allRecords = Array.from(v3Courses.values())
                .filter(record => !requestedSet || requestedSet.has(record.courseCode));
            // Schedule generation can begin as soon as every checked course has its
            // preliminary VSB timetable. Cognos professor history may still be loading;
            // when it arrives, the client automatically re-runs ranking with the richer data.
            const records = allRecords.filter(record => Array.isArray(record.options) && record.options.length);
            const missing = allRecords.filter(record => !Array.isArray(record.options) || !record.options.length).map(publicV3Course);
            if (missing.length) {
                return json(res, 409, {
                    error: "Wait until every checked course has a fast timetable before updating schedules.",
                    activeCourses: allRecords.length,
                    readyCourses: records.length,
                    missing
                });
            }
            const activeCodes = records.map(record => record.courseCode).sort();
            const job = startV3Analysis(records, body.prefs || {}, activeCodes);
            return json(res, 202, publicV3AnalysisJob(job));
        }

        if (req.method === "GET" && url.pathname === "/api/v3/analyze/status") {
            cleanupV3AnalysisJobs();
            const id = String(url.searchParams.get("id") || "");
            const job = v3AnalysisJobs.get(id);
            if (!job) return json(res, 404, { error: "Schedule analysis job was not found." });
            return json(res, 200, publicV3AnalysisJob(job));
        }

        if (req.method === "POST" && url.pathname === "/api/v3/analyze") {
            const body = await readJSON(req);
            const requestedCodes = Array.isArray(body.courseCodes)
                ? new Set(body.courseCodes.map(normalizeCourseCode).filter(Boolean))
                : null;
            const allRecords = Array.from(v3Courses.values())
                .filter(record => !requestedCodes || requestedCodes.has(record.courseCode));
            const records = allRecords.filter(record => Array.isArray(record.options) && record.options.length);
            const missing = allRecords.filter(record => !Array.isArray(record.options) || !record.options.length).map(publicV3Course);
            if (missing.length) {
                return json(res, 409, {
                    error: "Wait until every checked course has a fast timetable before updating schedules.",
                    activeCourses: allRecords.length,
                    readyCourses: records.length,
                    missing
                });
            }
            const result = analyzeSchedules(analysisRecordsWithRmp(records), body.prefs || {});
            return json(res, 200, { ...result, activeCourses: allRecords.length, readyCourses: records.length, missing: [] });
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

                if (!terms.length && scraper.authStep && scraper.authStep !== "none") {
                    patchState({
                        busy: false,
                        connected: false,
                        loginRequired: scraper.authStep === "login-required",
                        authStep: scraper.authStep,
                        authPhone: scraper.authPhone || "",
                        phase: scraper.authStep
                    });
                    return json(res, 200, {
                        ok: true,
                        terms: [],
                        authStep: scraper.authStep,
                        authPhone: scraper.authPhone || ""
                    });
                }

                patchState({
                    busy: false,
                    connected: true,
                    loginRequired: false,
                    authStep: "none",
                    authPhone: "",
                    phase: "ready",
                    message: `Connected to Cognos. Found ${terms.length} terms.`
                });
                resumeV3Queue();
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

        if (req.method === "POST" && url.pathname === "/api/mfa/send") {
            if (state.busy) return json(res, 409, { error: "The scraper is already busy." });
            const body = await readJSON(req);
            const method = String(body.method || "sms").toLowerCase() === "voice" ? "voice" : "sms";

            patchState({
                busy: true,
                connected: false,
                loginRequired: false,
                phase: "mfa-sending",
                authStep: "mfa-sending",
                message: method === "voice" ? "Requesting a Texas Tech verification call..." : "Requesting a Texas Tech verification text message...",
                lastError: null
            });

            try {
                const terms = await scraper.sendMfa(method);
                if (terms.length) {
                    patchState({ busy: false, connected: true, loginRequired: false, authStep: "none", authPhone: "", phase: "ready", message: `Connected to Cognos. Found ${terms.length} terms.` });
                    resumeV3Queue();
                } else {
                    patchState({ busy: false, connected: false, loginRequired: false, authStep: scraper.authStep, authPhone: scraper.authPhone || state.authPhone || "", phase: scraper.authStep });
                }
                return json(res, 200, { ok: true, terms, authStep: scraper.authStep, authPhone: scraper.authPhone || "" });
            } catch (error) {
                patchState({ busy: false, connected: false, authStep: scraper.authStep || "mfa-method", phase: scraper.authStep || "mfa-method", lastError: error.message, message: error.message });
                return json(res, 400, { error: error.message, authStep: scraper.authStep || "mfa-method" });
            }
        }

        if (req.method === "POST" && url.pathname === "/api/mfa/verify") {
            if (state.busy) return json(res, 409, { error: "The scraper is already busy." });
            const body = await readJSON(req);
            const code = String(body.code || "");
            const registerBrowser = Boolean(body.registerBrowser);

            patchState({
                busy: true,
                connected: false,
                loginRequired: false,
                phase: "mfa-verifying",
                authStep: "mfa-verifying",
                message: "Verifying the Texas Tech code...",
                lastError: null
            });

            try {
                const terms = await scraper.verifyMfa(code, registerBrowser);
                if (terms.length) {
                    patchState({ busy: false, connected: true, loginRequired: false, authStep: "none", authPhone: "", phase: "ready", message: `Connected to Cognos. Found ${terms.length} terms.` });
                    resumeV3Queue();
                } else {
                    patchState({ busy: false, connected: false, loginRequired: false, authStep: scraper.authStep, authPhone: scraper.authPhone || "", phase: scraper.authStep });
                }
                return json(res, 200, { ok: true, terms, authStep: scraper.authStep });
            } catch (error) {
                const phase = error.code === "MFA_CODE_ERROR" ? "mfa-code" : (scraper.authStep || "mfa-code");
                patchState({ busy: false, connected: false, loginRequired: false, authStep: phase, phase, lastError: error.message, message: error.message });
                return json(res, 400, { error: error.message, authStep: phase });
            }
        }

        if (req.method === "GET" && url.pathname === "/api/auth-preview") {
            try {
                const png = await scraper.getAuthPreview();
                res.writeHead(200, {
                    "Content-Type": "image/png",
                    "Content-Length": png.length,
                    "Cache-Control": "no-store, no-cache, must-revalidate",
                    "X-Content-Type-Options": "nosniff",
                    ...SECURITY_HEADERS
                });
                res.end(png);
                return;
            } catch (error) {
                return json(res, 404, { error: error.message });
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
                if (!terms.length && scraper.authStep && scraper.authStep !== "none") {
                    const phase = scraper.authStep;
                    patchState({
                        busy: false,
                        connected: false,
                        loginRequired: phase === "login-required",
                        authStep: phase,
                        authPhone: scraper.authPhone || "",
                        phase,
                        message: phase === "login-required" ? "Texas Tech sign-in required." : state.message
                    });
                    return json(res, 200, { terms: [], loginRequired: phase === "login-required", authStep: phase, authPhone: scraper.authPhone || "" });
                }
                patchState({ busy: false, connected: true, loginRequired: false, authStep: "none", authPhone: "", phase: "ready" });
                resumeV3Queue();
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
    if (!localRequestAllowed(req)) {
        return text(res, 403, "Forbidden local request.");
    }

    let url;
    try {
        url = new URL(req.url, `http://${HOST}:${PORT}`);
    } catch {
        return text(res, 400, "Malformed request URL.");
    }

    if (url.pathname.startsWith("/api/")) return await handleAPI(req, res, url);

    if (url.pathname === "/" || url.pathname === "/index.html") {
        try {
            return text(res, 200, fs.readFileSync(INDEX_FILE, "utf8"), "text/html; charset=utf-8");
        } catch (error) {
            return text(res, 500, `Could not load index.html: ${error.message}`);
        }
    }

    if (url.pathname === "/schedule-analyzer.html") {
        try {
            return text(res, 200, fs.readFileSync(SCHEDULE_FILE, "utf8"), "text/html; charset=utf-8");
        } catch (error) {
            return text(res, 500, `Could not load schedule-analyzer.html: ${error.message}`);
        }
    }

    if (url.pathname.startsWith("/output/")) {
        let fileName = "";
        try {
            fileName = path.basename(decodeURIComponent(url.pathname.slice("/output/".length)));
        } catch {
            return text(res, 400, "Malformed output file name.");
        }
        const filePath = path.join(OUTPUT_DIR, fileName);
        if (!fileName || !fs.existsSync(filePath)) return text(res, 404, "Result file not found.");
        const body = fs.readFileSync(filePath);
        res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Length": body.length,
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            ...SECURITY_HEADERS
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
    console.log(" TTU GRADE SCRAPER V3.1.1");
    console.log("======================================");
    console.log(`GUI: ${url}`);
    console.log("Playwright runs headless unless a future fallback is needed.\n");

    patchState({ phase: "connecting", message: "GUI ready. Connecting to Texas Tech in the background..." });
    openDefaultBrowser(url);

    scraper.connect()
        .then(terms => {
            if (!terms.length && scraper.authStep && scraper.authStep !== "none") {
                const phase = scraper.authStep;
                patchState({
                    connected: false,
                    loginRequired: phase === "login-required",
                    authStep: phase,
                    authPhone: scraper.authPhone || "",
                    busy: false,
                    phase,
                    message: phase === "login-required" ? "Texas Tech sign-in required." : state.message
                });
                return;
            }
            patchState({
                connected: true,
                loginRequired: false,
                authStep: "none",
                authPhone: "",
                busy: false,
                phase: "ready",
                message: `Connected to Cognos. Found ${terms.length} terms.`
            });
            resumeV3Queue();
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

    scheduleScraper.connect()
        .then(terms => {
            if (!terms.length && scheduleScraper.authStep !== "none") {
                patchScheduleState({
                    connected: false,
                    loginRequired: scheduleScraper.authStep === "login-required",
                    authStep: scheduleScraper.authStep,
                    authPhone: scheduleScraper.authPhone || "",
                    busy: false,
                    phase: scheduleScraper.authStep,
                    message: scheduleScraper.authStep === "login-required" ? "Schedule Builder sign-in required." : scheduleState.message
                });
                return;
            }
            patchScheduleState(scheduleConnectedPatch(terms));
            if (scheduleState.term) resumeV3Queue();
        })
        .catch(error => {
            console.error(error);
            patchScheduleState({ connected: false, busy: false, phase: "error", lastError: error.message, message: error.message });
        });
});

const keepAliveTimer = setInterval(async () => {
    const now = Date.now();
    const idleEnough = now - lastCourseChangeAt >= 4 * 60 * 1000;
    const due = now - lastKeepAliveAt >= 5 * 60 * 1000;
    if (!idleEnough || !due) return;
    lastKeepAliveAt = now;
    if (state.connected && !state.busy) {
        const ok = await scraper.keepAlive().catch(() => false);
        if (!ok) console.log("[keepalive] Cognos touch did not confirm success.");
    }
    if (scheduleState.connected && !scheduleState.busy) {
        const ok = await scheduleScraper.keepAlive().catch(() => false);
        if (!ok) console.log("[keepalive] Schedule Builder touch did not confirm success.");
    }
}, 60 * 1000);
keepAliveTimer.unref();

let shuttingDown = false;
async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("Closing scraper...");
    clearInterval(keepAliveTimer);

    // Stop accepting new localhost connections immediately. Browser-context cleanup can
    // take a few seconds; keeping the port bound until after that cleanup created a
    // restart race where a fresh launcher could hit EADDRINUSE even after /api/shutdown
    // had already returned success.
    let serverClosed = Promise.resolve();
    if (server.listening) {
        serverClosed = new Promise(resolve => server.close(() => resolve()));
        try { server.closeIdleConnections?.(); } catch {}
    }

    await Promise.allSettled([closeScheduleWorkerPool(), scraper.close(), scheduleScraper.close()]);
    try { fs.rmSync(PID_FILE, { force: true }); } catch {}
    await Promise.race([
        serverClosed,
        new Promise(resolve => setTimeout(resolve, 1500))
    ]);
    process.exit(0);
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
