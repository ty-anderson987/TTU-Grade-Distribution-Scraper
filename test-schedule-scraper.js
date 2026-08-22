// Copyright 2026 Ty Anderson
// SPDX-License-Identifier: Apache-2.0

const assert = require('assert');
const Module = require('module');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
    if (request === 'playwright') return { chromium: {} };
    return originalLoad.call(this, request, parent, isMain);
};
const { TTUScheduleScraper, cookieAppliesToHost, freshWorkerStorageState } = require('./schedule-scraper');
Module._load = originalLoad;

function isoAdd(iso, days) {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

function testFreshWorkerStorageState() {
    assert.strictEqual(cookieAppliesToHost({ domain: 'schedulebuilder.ttu.edu' }), true);
    assert.strictEqual(cookieAppliesToHost({ domain: '.schedulebuilder.ttu.edu' }), true);
    assert.strictEqual(cookieAppliesToHost({ domain: '.ttu.edu' }), true, 'parent-domain TTU cookies are also sent to Schedule Builder');
    assert.strictEqual(cookieAppliesToHost({ domain: 'login.ttu.edu' }), false, 'host-only login cookies do not apply to Schedule Builder');

    const source = {
        cookies: [
            { name: 'vsb-host', domain: 'schedulebuilder.ttu.edu', value: 'a' },
            { name: 'vsb-parent', domain: '.ttu.edu', value: 'b' },
            { name: 'ttu-login', domain: 'login.ttu.edu', value: 'c' },
            { name: 'idp', domain: '.microsoftonline.com', value: 'd' }
        ],
        origins: [
            { origin: 'https://schedulebuilder.ttu.edu', localStorage: [{ name: 'plan', value: 'shared' }] },
            { origin: 'https://login.ttu.edu', localStorage: [{ name: 'sso', value: 'keep' }] }
        ]
    };
    const fresh = freshWorkerStorageState(source);
    assert.deepStrictEqual(fresh.cookies.map(cookie => cookie.name), ['ttu-login', 'idp']);
    assert.deepStrictEqual(fresh.origins.map(origin => origin.origin), ['https://login.ttu.edu']);
}

async function testSnakeWeekScanning() {
    const scraper = new TTUScheduleScraper({ profileDir: '/tmp/ttu-test-schedule-profile' });
    let week = 2; // Start in the middle of a four-week slider.
    let moves = 0;
    const weekStarts = ['2026-08-23', '2026-08-30', '2026-09-06', '2026-09-13'];

    scraper.page = {
        locator() { return { count: async () => 1 }; },
        evaluate: async () => 4
    };
    scraper.weekMoveAvailable = async direction => direction < 0 ? week > 0 : week < 3;
    scraper.weekSliderPercent = async () => week / 3 * 100;
    scraper.moveWeek = async direction => {
        if (!(await scraper.weekMoveAvailable(direction))) return false;
        week += direction < 0 ? -1 : 1;
        moves++;
        return true;
    };
    scraper.atWeekBoundary = async direction => direction < 0 ? week === 0 : week === 3;
    scraper.captureCurrentWeekSnapshot = async () => ({
        weekStart: weekStarts[week],
        weekLabel: weekStarts[week],
        geometryValid: true,
        events: [{
            date: isoAdd(weekStarts[week], 1),
            day: 'M', start: '9:00 AM', end: '10:00 AM', kind: 'Lab'
        }]
    });

    const components = [{ section: 'Lab D01', online: false, meetings: [{ days: ['M'], start: '9:00 AM', end: '10:00 AM' }] }];
    const backward = await scraper.captureDetailedOccurrences('PHYS 1408', components);
    assert.strictEqual(backward.scanDirection, 'backward');
    assert.strictEqual(backward.occurrenceCoverageComplete, true);
    assert.deepStrictEqual(backward.weeks.map(x => x.weekStart), weekStarts);
    assert.strictEqual(week, 0, 'backward scan should finish at the first week');
    assert.strictEqual(moves, 4, 'middle-to-nearest-boundary plus one full scan should use four moves');

    const beforeForward = moves;
    const forward = await scraper.captureDetailedOccurrences('PHYS 1408', components);
    assert.strictEqual(forward.scanDirection, 'forward');
    assert.strictEqual(forward.occurrenceCoverageComplete, true);
    assert.strictEqual(week, 3, 'forward scan should finish at the last week');
    assert.strictEqual(moves - beforeForward, 3, 'preserved boundary should avoid rewinding before the next option');

    // If VSB resets a newly-selected result to week one, auto-direction must adapt
    // instead of blindly forcing the alternating direction and doubling navigation.
    week = 0;
    const beforeResetScan = moves;
    const afterReset = await scraper.captureDetailedOccurrences('PHYS 1408', components);
    assert.strictEqual(afterReset.scanDirection, 'forward');
    assert.strictEqual(moves - beforeResetScan, 3);
}

async function testVisitedResultCoverage() {
    const scraper = new TTUScheduleScraper({ profileDir: '/tmp/ttu-test-schedule-profile-2' });
    let current = 1;
    scraper.resetForCourse = async () => { current = 1; };
    scraper.addCourse = async () => {};
    scraper.isolateCourse = async () => {};
    scraper.assertOnlyCourseActive = async () => true;
    let expectedTotalSeen = 0;
    scraper.waitForResults = async (_timeout, _abort, expectedTotal) => { expectedTotalSeen = Number(expectedTotal || 0); return 3; };
    scraper.touch = () => {};
    scraper.status = () => {};
    scraper.parseCurrentResult = async courseCode => ({
        courseCode,
        optionKey: `key-${current}`,
        timetableSignature: `sig-${current}`,
        components: [{ courseCode, section: 'Lecture 001', crn: String(10000 + current), instructor: 'Test', meetings: [] }],
        variants: [],
        rawMeetingLines: [],
        legendOccurrences: [],
        sessionStart: '2026-08-24',
        sessionEnd: '2026-12-01',
        legendDataComplete: true,
        noScheduledMeeting: true,
        needsDeepScan: false
    });
    scraper.page = {
        locator(selector) {
            if (selector === '.results-current-schedule') {
                return { first: () => ({ textContent: async () => String(current) }) };
            }
            return { first: () => ({ click: async () => {} }), count: async () => 1 };
        },
        evaluate: async fn => {
            const source = String(fn);
            if (source.includes('caseNextResult')) { current++; return true; }
            if (source.includes('casePrevResult') || source.includes('casePreviousResult')) { current--; return true; }
            return false;
        }
    };

    const result = await scraper.scrapeCourseOptions('Fall 2026', 'PHYS 1408', {
        preliminaryOnly: true,
        resultStart: 2,
        resultEnd: 3,
        resultDirection: 'forward',
        expectedResultTotal: 3
    });
    assert.strictEqual(expectedTotalSeen, 3, 'parallel range scans must pass the expected global VSB result count into waitForResults');
    assert.deepStrictEqual(result.visitedResultIndexes, [2, 3]);
    assert.deepStrictEqual(result.options.map(x => x.vsbResultIndex), [2, 3]);
}


async function testInPlaceCourseReset() {
    const scraper = new TTUScheduleScraper({ profileDir: '/tmp/ttu-test-schedule-profile-reset' });
    let setTermSeen = '';
    let cleared = 0;
    let filled = null;
    let escaped = false;
    scraper.requireReady = async () => {};
    scraper.setTerm = async term => { setTermSeen = term; };
    scraper.clearExistingCourses = async () => { cleared = 3; return cleared; };
    scraper.touch = () => {};
    scraper.page = {
        goto: async () => { throw new Error('resetForCourse must not navigate/refresh VSB'); },
        locator(selector) {
            assert.strictEqual(selector, '#code_number');
            return {
                first() {
                    return {
                        waitFor: async () => {},
                        isEnabled: async () => true,
                        fill: async value => { filled = value; },
                        press: async key => { if (key === 'Escape') escaped = true; }
                    };
                }
            };
        }
    };
    await scraper.resetForCourse('Fall 2026');
    assert.strictEqual(setTermSeen, 'Fall 2026');
    assert.strictEqual(cleared, 3, 'reset should clear however many courses are actually present');
    assert.strictEqual(filled, '');
    assert.strictEqual(escaped, true);
}


function makeResetMockPage(initialRows) {
    const rows = initialRows.map((row, index) => ({
        code: row.code || `ECE ${1000 + index}`,
        dropped: Boolean(row.dropped),
        included: row.included !== false,
        enrolled: Boolean(row.enrolled),
        noDropOption: Boolean(row.noDropOption),
        noTrash: Boolean(row.noTrash),
        clickFailures: Number(row.clickFailures || 0),
        selectFailures: Number(row.selectFailures || 0),
        reorderAfterDrop: Boolean(row.reorderAfterDrop),
        clicks: 0,
        dropSelections: 0,
        ignoreClicks: 0
    }));

    const reorder = row => {
        if (!row.reorderAfterDrop) return;
        const oldIndex = rows.indexOf(row);
        if (oldIndex >= 0) {
            rows.splice(oldIndex, 1);
            rows.unshift(row);
        }
    };

    const rowLocator = row => ({
        locator(selector) {
            const exists = (() => {
                if (selector === '.cnf_trash_button') return !row.enrolled && !row.noTrash;
                return true;
            })();
            const item = {
                first() { return item; },
                async count() { return exists ? 1 : 0; },
                async textContent() { return selector === '.cbox-cn' ? row.code : ''; },
                async evaluate(fn, arg) {
                    if (selector === 'select.cbox-dropdown') {
                        const options = [{ value: 'al', textContent: 'Try all classes', label: 'Try all classes' }];
                        if (row.enrolled && !row.noDropOption) {
                            options.push({ value: 'dp_mock', textContent: 'Plan to drop', label: 'Plan to drop' });
                        }
                        return fn({ value: row.dropped ? 'dp_mock' : 'al', options }, arg);
                    }
                    if (selector === 'input.ignore_check') {
                        const node = { checked: row.included, click() { row.ignoreClicks++; row.included = !row.included; } };
                        return fn(node, arg);
                    }
                    return fn({}, arg);
                },
                async isVisible() {
                    if (!exists) return false;
                    if (selector === '.cbox-trash-icon-undo') return row.dropped;
                    if (selector === '.cnf_trash_button') return !row.dropped;
                    return true;
                },
                async isChecked() {
                    if (selector === 'input.ignore_check') return row.included;
                    return false;
                },
                async selectOption(value) {
                    if (selector !== 'select.cbox-dropdown') return [];
                    if (row.selectFailures > 0) {
                        row.selectFailures--;
                        throw new Error('mock select ignored');
                    }
                    if (/^dp_/i.test(String(value || ''))) {
                        row.dropSelections++;
                        row.dropped = true;
                        reorder(row);
                        return [String(value)];
                    }
                    row.dropped = false;
                    return [String(value)];
                },
                async click() {
                    if (selector === '.cnf_trash_button') {
                        row.clicks++;
                        if (row.clickFailures > 0) {
                            row.clickFailures--;
                            return;
                        }
                        row.dropped = true;
                        reorder(row);
                        return;
                    }
                    if (selector === 'input.ignore_check') {
                        row.ignoreClicks++;
                        row.included = !row.included;
                    }
                }
            };
            return item;
        },
        async evaluate(fn) {
            // Semantic remove-control fallback used by deactivateCourseRow().
            const fakeNode = {
                querySelector(selector) {
                    if (selector === '.cnf_trash_button' && !row.enrolled && !row.noTrash) {
                        return { isConnected: true, click() {
                            row.clicks++;
                            if (row.clickFailures > 0) { row.clickFailures--; return; }
                            row.dropped = true;
                            reorder(row);
                        } };
                    }
                    return null;
                },
                querySelectorAll() { return []; }
            };
            return fn(fakeNode);
        }
    });

    return {
        rows,
        locator(selector) {
            if (selector === '.requirementDiv2:not(#templateCourse2)') {
                return {
                    async count() { return rows.length; },
                    nth(index) { return rowLocator(rows[index]); }
                };
            }
            throw new Error(`unexpected selector ${selector}`);
        }
    };
}

async function testVariablePreexistingCourseClearing() {
    // Exercise every plausible starting size, with a mix of enrolled rows (no trash icon,
    // must use Plan to drop) and manually-added rows (trash/remove control).
    for (const count of Array.from({ length: 13 }, (_, index) => index)) {
        const scraper = new TTUScheduleScraper({ profileDir: `/tmp/ttu-test-clear-${count}` });
        const page = makeResetMockPage(Array.from({ length: count }, (_, index) => ({
            code: `ECE ${2000 + index}`,
            enrolled: index % 2 === 0
        })));
        const statuses = [];
        scraper.page = page;
        scraper.touch = () => {};
        scraper.status = (message, meta) => statuses.push({ message, meta });
        const cleared = await scraper.clearExistingCourses();
        assert.strictEqual(cleared, count, `must clear exactly ${count} active pre-existing courses`);
        assert.strictEqual((await scraper.activeCourseSnapshot()).count, 0, `must leave zero active courses after starting with ${count}`);
        const actions = page.rows.reduce((sum, row) => sum + row.clicks + row.dropSelections + row.ignoreClicks, 0);
        assert.strictEqual(actions, count, 'each active course should be cleared individually exactly once');
        if (count) {
            assert.ok(statuses.at(-1).message.includes(`cleared ${count} pre-existing course`));
            assert.strictEqual(statuses.at(-1).meta.clearedCourses, count);
        }
    }

    // Reproduce the user's real VSB shape: enrolled courses have a Stay enrolled / Plan to
    // drop dropdown and no removable trash control. All five must clear without an error.
    const enrolled = new TTUScheduleScraper({ profileDir: '/tmp/ttu-test-clear-enrolled' });
    const enrolledPage = makeResetMockPage([
        'ECE 5375', 'ECE 5364', 'ECE 3312', 'ECE 3332', 'ECE 3325'
    ].map(code => ({ code, enrolled: true })));
    enrolled.page = enrolledPage; enrolled.touch = () => {}; enrolled.status = () => {};
    assert.strictEqual(await enrolled.clearExistingCourses(), 5);
    assert.strictEqual((await enrolled.activeCourseSnapshot()).count, 0);
    assert.strictEqual(enrolledPage.rows.reduce((sum, row) => sum + row.dropSelections, 0), 5, 'enrolled rows must use Plan to drop');
    assert.strictEqual(enrolledPage.rows.reduce((sum, row) => sum + row.clicks, 0), 0, 'enrolled rows must not require a trash control');

    // Already-dropped/ignored rows remain in VSB's DOM but are not active and must not be clicked.
    const mixed = new TTUScheduleScraper({ profileDir: '/tmp/ttu-test-clear-mixed' });
    const mixedPage = makeResetMockPage([
        { code: 'ECE 3302', enrolled: true, dropped: true },
        { code: 'PHYS 1408', enrolled: true },
        { code: 'CS 2413', dropped: true },
        { code: 'ECE 3311' },
        { code: 'MATH 2450', enrolled: true, included: false }
    ]);
    mixed.page = mixedPage; mixed.touch = () => {}; mixed.status = () => {};
    assert.strictEqual(await mixed.clearExistingCourses(), 2);
    assert.strictEqual(mixedPage.rows.find(r => r.code === 'PHYS 1408').dropSelections, 1);
    assert.strictEqual(mixedPage.rows.find(r => r.code === 'ECE 3311').clicks, 1);
    assert.strictEqual(mixedPage.rows.find(r => r.code === 'MATH 2450').dropSelections, 0);

    // A transient ignored trash click should be retried, not silently counted as cleared.
    const retrying = new TTUScheduleScraper({ profileDir: '/tmp/ttu-test-clear-retry' });
    const retryPage = makeResetMockPage([{ code: 'MATH 2450', clickFailures: 1 }]);
    retrying.page = retryPage; retrying.touch = () => {}; retrying.status = () => {};
    assert.strictEqual(await retrying.clearExistingCourses(), 1);
    assert.strictEqual(retryPage.rows[0].clicks, 2, 'removal should be confirmed and retried when VSB ignores the first click');

    // If an enrolled row has neither a drop option nor a trash control in a future VSB
    // version, the native include checkbox is a safe functional fallback.
    const checkboxFallback = new TTUScheduleScraper({ profileDir: '/tmp/ttu-test-clear-checkbox' });
    const checkboxPage = makeResetMockPage([{ code: 'ECE 3325', enrolled: true, noDropOption: true, noTrash: true }]);
    checkboxFallback.page = checkboxPage; checkboxFallback.touch = () => {}; checkboxFallback.status = () => {};
    assert.strictEqual(await checkboxFallback.clearExistingCourses(), 1);
    assert.strictEqual((await checkboxFallback.activeCourseSnapshot()).count, 0);
    assert.strictEqual(checkboxPage.rows[0].ignoreClicks, 1);

    // VSB may reorder/rebuild requirement rows after each removal/drop. Clearing must
    // reacquire the target by exact course code rather than trusting an old index.
    const reordering = new TTUScheduleScraper({ profileDir: '/tmp/ttu-test-clear-reorder' });
    const reorderPage = makeResetMockPage([
        { code: 'ECE 3302', enrolled: true, reorderAfterDrop: true },
        { code: 'PHYS 1408', reorderAfterDrop: true },
        { code: 'CS 2413', enrolled: true, reorderAfterDrop: true },
        { code: 'ECE 3311', reorderAfterDrop: true }
    ]);
    reordering.page = reorderPage; reordering.touch = () => {}; reordering.status = () => {};
    assert.strictEqual(await reordering.clearExistingCourses(), 4);
    assert.strictEqual((await reordering.activeCourseSnapshot()).count, 0);
    assert.deepStrictEqual([...reorderPage.rows].map(row => [row.code, row.clicks + row.dropSelections]).sort(), [
        ['CS 2413', 1], ['ECE 3302', 1], ['ECE 3311', 1], ['PHYS 1408', 1]
    ]);
}

async function testCourseIsolationGuard() {
    const scraper = new TTUScheduleScraper({ profileDir: '/tmp/ttu-test-isolation-guard' });
    scraper.page = makeResetMockPage([
        { code: 'ECE 3302', dropped: true },
        { code: 'ECE 3311' },
        { code: 'PHYS 1408', dropped: true }
    ]);
    assert.strictEqual(await scraper.assertOnlyCourseActive('ECE 3311'), true);

    scraper.page = makeResetMockPage([{ code: 'ECE 3311' }, { code: 'PHYS 1408' }]);
    await assert.rejects(() => scraper.assertOnlyCourseActive('ECE 3311'), /course isolation failed/i);
}

async function testScrapePipelineValidatesExactCourse() {
    const scraper = new TTUScheduleScraper({ profileDir: '/tmp/ttu-test-pipeline-exact' });
    const calls = [];
    scraper.resetForCourse = async term => calls.push(`reset:${term}`);
    scraper.addCourse = async code => calls.push(`add:${code}`);
    scraper.isolateCourse = async code => calls.push(`isolate:${code}`);
    scraper.assertOnlyCourseActive = async code => calls.push(`assert:${code}`);
    scraper.waitForResults = async () => 1;
    scraper.touch = () => {};
    scraper.status = () => {};
    scraper.parseCurrentResult = async code => ({
        courseCode: code,
        optionKey: 'exact-one',
        timetableSignature: 'sig-one',
        components: [{ courseCode: code, section: 'Lec 001', crn: '12345', instructor: 'Professor', meetings: [] }],
        variants: [], rawMeetingLines: [], legendOccurrences: [],
        sessionStart: '2026-08-24', sessionEnd: '2026-12-01', legendDataComplete: true,
        noScheduledMeeting: true, needsDeepScan: false
    });
    scraper.page = {
        locator(selector) {
            if (selector === '.results-current-schedule') return { first: () => ({ textContent: async () => '1' }) };
            return { first: () => ({ click: async () => {} }), count: async () => 1 };
        },
        evaluate: async () => false
    };
    const result = await scraper.scrapeCourseOptions('Fall 2026', 'ECE 3311', { preliminaryOnly: true });
    assert.deepStrictEqual(calls, ['reset:Fall 2026', 'add:ECE 3311', 'isolate:ECE 3311', 'assert:ECE 3311']);
    assert.strictEqual(result.totalReported, 1);
    assert.strictEqual(result.options.length, 1);
    assert.ok(result.options.every(option => option.components.every(component => component.courseCode === 'ECE 3311')));
}

async function testStaleNoResultsDoesNotWinRace() {
    const scraper = new TTUScheduleScraper({ profileDir: '/tmp/ttu-test-schedule-profile-results' });
    let polls = 0;
    scraper.detectState = async () => ({ type: 'ready' });
    scraper.page = {
        locator(selector) {
            if (selector === '.results-total-schedules') {
                return { first: () => ({ textContent: async () => { polls++; return polls >= 4 ? '3' : ''; } }) };
            }
            if (selector === '#legend_box .course_box') {
                return { count: async () => polls >= 4 ? 1 : 0 };
            }
            if (selector === 'body') {
                // Simulate VSB leaving its old no-results text in the DOM while the new
                // result set is still being generated. The old implementation returned 0
                // immediately and falsely marked a real course as unavailable.
                return { textContent: async () => 'No schedule combination(s)' };
            }
            throw new Error(`unexpected selector ${selector}`);
        }
    };
    const total = await scraper.waitForResults(5000);
    assert.strictEqual(total, 3, 'a stale no-results message must not beat a real positive result set');
}

(async () => {
    testFreshWorkerStorageState();
    await testSnakeWeekScanning();
    await testVisitedResultCoverage();
    await testInPlaceCourseReset();
    await testVariablePreexistingCourseClearing();
    await testCourseIsolationGuard();
    await testScrapePipelineValidatesExactCourse();
    await testStaleNoResultsDoesNotWinRace();
    console.log('schedule scraper reliability tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
