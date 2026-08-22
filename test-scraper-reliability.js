// Copyright 2026 Ty Anderson
// SPDX-License-Identifier: Apache-2.0

const assert = require('assert');
const Module = require('module');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
    if (request === 'playwright') return { chromium: {} };
    return originalLoad.call(this, request, parent, isMain);
};
const { TTUGradeScraper } = require('./scraper');
Module._load = originalLoad;

function makeScraper(name) {
    return new TTUGradeScraper({
        profileDir: `/tmp/${name}-profile`,
        outputDir: `/tmp/${name}-output`
    });
}

async function runSequence(sequence) {
    const scraper = makeScraper(`ttu-grade-retry-${Math.random().toString(16).slice(2)}`);
    let calls = 0;
    scraper.scrapeHistoricalTermOnce = async () => {
        const item = sequence[calls++];
        if (item instanceof Error) throw item;
        return item;
    };
    const result = await scraper.scrapeHistoricalTermWithRetry(
        {}, { text: 'Spring 2026' }, 'ECE', '3302', 2
    );
    return { result, calls };
}

(async () => {
    let run = await runSequence([{ status: 'success', rows: [{ instructor: 'A' }] }]);
    assert.strictEqual(run.result.status, 'success');
    assert.strictEqual(run.calls, 1);

    run = await runSequence([
        { status: 'missing', reason: 'course-not-found', rows: [] },
        { status: 'missing', reason: 'course-not-found', rows: [] }
    ]);
    assert.strictEqual(run.result.status, 'missing');
    assert.strictEqual(run.result.negativeVerification, 'same-reason-v2');
    assert.strictEqual(run.result.attempts, 2);

    run = await runSequence([
        { status: 'missing', reason: 'course-not-found', rows: [] },
        { status: 'empty', reason: 'empty-grade-table', rows: [] },
        { status: 'success', rows: [{ instructor: 'Recovered' }] }
    ]);
    assert.strictEqual(run.result.status, 'success');
    assert.strictEqual(run.calls, 3);

    run = await runSequence([
        { status: 'missing', reason: 'course-not-found', rows: [] },
        { status: 'empty', reason: 'empty-grade-table', rows: [] },
        { status: 'missing', reason: 'subject-not-found', rows: [] }
    ]);
    assert.strictEqual(run.result.status, 'failed', 'three conflicting empty states must never become cached missing history');
    assert.strictEqual(run.calls, 3);

    const transient = new Error('temporary Cognos failure');
    run = await runSequence([
        { status: 'missing', reason: 'course-not-found', rows: [] },
        transient,
        { status: 'missing', reason: 'course-not-found', rows: [] }
    ]);
    assert.strictEqual(run.result.status, 'missing');
    assert.strictEqual(run.result.negativeVerification, 'same-reason-v2');
    assert.strictEqual(run.calls, 3);

    // A report header can appear before its rows. The stability guard should wait for
    // rows to arrive and require two identical non-empty reads before returning.
    const scraper = makeScraper('ttu-grade-stable-rows');
    const rows = [{ rowType: 'data', instructor: 'Professor', section: '001', A: 10 }];
    const readings = [[], [], rows, rows];
    let index = 0;
    scraper.extractGradeTable = async () => readings[Math.min(index++, readings.length - 1)];
    const stable = await scraper.waitForStableGradeRows({}, 1000);
    assert.deepStrictEqual(stable, rows);
    assert.ok(index >= 4);

    // Dependent Cognos dropdowns can become enabled before the final options arrive.
    // The historical path must keep waiting when its requested course is not in the
    // first partial list instead of falsely caching it as not offered.
    const dropdownScraper = makeScraper('ttu-grade-dropdown-settle');
    const fakeLocator = { isEnabled: async () => true };
    const fakeFrame = { locator: () => ({ nth: () => fakeLocator }) };
    dropdownScraper.findFormFrameOnPage = async () => fakeFrame;
    const optionReads = [
        [{ value: '1111', text: 'ECE 1111', disabled: false }],
        [{ value: '1111', text: 'ECE 1111', disabled: false }],
        [{ value: '1111', text: 'ECE 1111', disabled: false }, { value: '3302', text: 'ECE 3302', disabled: false }]
    ];
    let optionReadIndex = 0;
    dropdownScraper.getRealOptions = async () => optionReads[Math.min(optionReadIndex++, optionReads.length - 1)];
    const ready = await dropdownScraper.waitForSelectReadyOnPage({}, 2, 'course', 1000, option => option.value === '3302');
    assert.ok(ready.options.some(option => option.value === '3302'));
    assert.ok(optionReadIndex >= 3, 'must not accept the first partial dependent-dropdown list');

    // Exact course identity must survive both Cognos paths. A neighboring catalog
    // number such as ECE 33110 must never be accepted when ECE 3311 was requested.
    const exactStandalone = makeScraper('ttu-grade-exact-standalone');
    const standaloneSelections = [];
    const fakePage = { goto: async () => {} };
    const fakeFrameExact = {};
    exactStandalone.findFormFrameOnPage = async () => fakeFrameExact;
    exactStandalone.selectOption = async (_frame, _index, option) => standaloneSelections.push(option);
    exactStandalone.waitForSelectReadyOnPage = async (_page, index) => {
        if (index === 1) return { frame: fakeFrameExact, options: [
            { value: 'ECE', text: 'Electrical Computer Engr' },
            { value: 'EE', text: 'Electrical Engineering' }
        ] };
        if (index === 2) return { frame: fakeFrameExact, options: [
            { value: '33110', text: 'ECE 33110' },
            { value: '3311', text: 'ECE 3311' },
            { value: '3312', text: 'ECE 3312' }
        ] };
        throw new Error(`unexpected dropdown index ${index}`);
    };
    exactStandalone.waitForFinishReadyOnPage = async () => fakeFrameExact;
    exactStandalone.clickFinish = async () => {};
    let standaloneReportExpectation = null;
    exactStandalone.findReportFrameOnPage = async (_page, termText, courseText) => {
        standaloneReportExpectation = { termText, courseText };
        return {};
    };
    exactStandalone.waitForStableGradeRows = async () => [{ rowType: 'data', instructor: 'Exact Professor', section: '001', A: 10 }];
    const exactStandaloneRows = await exactStandalone.scrapeOneCourseOnPage(
        fakePage,
        { text: 'Fall 2026', value: '20272' },
        { text: 'Electrical Computer Engr', value: 'ECE' },
        { text: 'ECE 3311', value: '3311' }
    );
    assert.strictEqual(standaloneSelections.at(-1).value, '3311', 'standalone Cognos path must select the exact requested course value');
    assert.deepStrictEqual(standaloneReportExpectation, { termText: 'Fall 2026', courseText: 'ECE 3311' });
    assert.strictEqual(exactStandaloneRows[0].courseNumber, '3311');

    const exactHistorical = makeScraper('ttu-grade-exact-historical');
    const historicalSelections = [];
    exactHistorical.findFormFrameOnPage = async () => fakeFrameExact;
    exactHistorical.selectOption = async (_frame, _index, option) => historicalSelections.push(option);
    exactHistorical.waitForSelectReadyOnPage = exactStandalone.waitForSelectReadyOnPage;
    exactHistorical.waitForFinishReadyOnPage = async () => fakeFrameExact;
    exactHistorical.clickFinish = async () => {};
    let historicalReportExpectation = null;
    exactHistorical.findReportFrameOnPage = async (_page, termText, courseText) => {
        historicalReportExpectation = { termText, courseText };
        return {};
    };
    exactHistorical.waitForStableGradeRows = async () => [{ rowType: 'data', instructor: 'Exact Professor', section: '001', A: 10 }];
    const exactHistoricalResult = await exactHistorical.scrapeHistoricalTermOnce(
        fakePage,
        { text: 'Fall 2026', value: '20272' },
        'ECE',
        '3311'
    );
    assert.strictEqual(exactHistoricalResult.status, 'success');
    assert.strictEqual(historicalSelections.at(-1).value, '3311', 'Schedule Analyzer Cognos path must select the exact requested course value');
    assert.deepStrictEqual(historicalReportExpectation, { termText: 'Fall 2026', courseText: 'ECE 3311' });
    assert.strictEqual(exactHistoricalResult.rows[0].courseNumber, '3311');

    // The standalone Grade Scraper should use two independent Cognos pages when at
    // least two course jobs are selected, while preserving the selected-job order in
    // the generated output.
    const parallelScraper = makeScraper('ttu-grade-solo-parallel');
    parallelScraper.requireReady = async () => {};
    let nextPageId = 0;
    parallelScraper.context = { newPage: async () => ({ id: ++nextPageId, close: async () => {} }) };
    let active = 0, maxActive = 0;
    parallelScraper.scrapeOneCourseOnPageWithRetry = async (_page, term, _subject, course) => {
        active++; maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setTimeout(resolve, course.value === '1001' ? 35 : 15));
        active--;
        return [{ rowType: 'data', term: term.text, course: course.text, courseNumber: course.value, instructor: `P${course.value}` }];
    };
    parallelScraper.generateHTML = rows => { parallelScraper.__rows = rows; return '/tmp/fake.html'; };
    const group = {
        term: { text: 'Spring 2026', value: '20265' },
        subject: { text: 'Electrical Computer Engr', value: 'ECE' },
        courses: [
            { text: 'ECE 1001', value: '1001' },
            { text: 'ECE 1002', value: '1002' },
            { text: 'ECE 1003', value: '1003' }
        ]
    };
    const parallelResult = await parallelScraper.scrapeGroups([group]);
    assert.strictEqual(parallelResult.cognosWorkers, 2);
    assert.strictEqual(maxActive, 2, 'standalone scraper should run at most two Cognos course jobs concurrently');
    assert.deepStrictEqual(parallelScraper.__rows.map(row => row.courseNumber), ['1001', '1002', '1003'], 'parallel completion must not reorder output jobs');

    // Exercise the standalone queue at several sizes so the two-worker cap is not
    // accidentally tied to a particular number of selected courses.
    for (const count of [1, 2, 5, 8, 12]) {
        const matrixScraper = makeScraper(`ttu-grade-solo-matrix-${count}`);
        matrixScraper.requireReady = async () => {};
        let createdPages = 0, activeJobs = 0, peakJobs = 0;
        matrixScraper.context = { newPage: async () => ({ id: ++createdPages, close: async () => {} }) };
        matrixScraper.scrapeOneCourseOnPageWithRetry = async (_page, term, _subject, course) => {
            activeJobs++; peakJobs = Math.max(peakJobs, activeJobs);
            const n = Number(course.value);
            await new Promise(resolve => setTimeout(resolve, 3 + (n % 3) * 2));
            activeJobs--;
            return [{ rowType: 'data', term: term.text, course: course.text, courseNumber: course.value, instructor: `P${course.value}` }];
        };
        matrixScraper.generateHTML = rows => { matrixScraper.__rows = rows; return '/tmp/fake.html'; };
        const courses = Array.from({ length: count }, (_, index) => ({ text: `ECE ${2001 + index}`, value: String(2001 + index) }));
        const result = await matrixScraper.scrapeGroups([{
            term: { text: 'Spring 2026', value: '20265' },
            subject: { text: 'Electrical Computer Engr', value: 'ECE' },
            courses
        }]);
        const expectedWorkers = Math.min(2, count);
        assert.strictEqual(result.cognosWorkers, expectedWorkers, `expected ${expectedWorkers} Cognos worker(s) for ${count} course job(s)`);
        assert.strictEqual(createdPages, expectedWorkers);
        assert.ok(peakJobs <= 2, 'standalone grade scraping must never exceed two active Cognos jobs');
        if (count > 1) assert.strictEqual(peakJobs, 2, 'two Cognos workers should actually overlap when there is enough work');
        assert.deepStrictEqual(matrixScraper.__rows.map(row => row.courseNumber), courses.map(course => course.value), 'parallel output must preserve selected-course order');
    }

    console.log('grade scraper reliability tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
