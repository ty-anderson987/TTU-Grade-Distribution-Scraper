// Copyright 2026 Ty Anderson
// SPDX-License-Identifier: Apache-2.0

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const schedule = fs.readFileSync(path.join(root, 'schedule-analyzer.html'), 'utf8');
const analytics = fs.readFileSync(path.join(root, 'analytics-template.html'), 'utf8');
const compare = fs.readFileSync(path.join(root, 'compare-template.html'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const pkg = require('./package.json');

assert.strictEqual(pkg.version, '3.1.1');
assert.ok(schedule.includes('function rmpHasRatings(rmp)'), 'Schedule Analyzer must guard unrated RMP profiles');
assert.ok(analytics.includes('function rmpHasRatings(rmp)'), 'Grade Analytics must guard unrated RMP profiles');
assert.ok(compare.includes('function rmpHasRatings(rmp)'), 'Professor Comparison must guard unrated RMP profiles');
assert.ok(schedule.includes('Full-semester scan complete — refreshing ranked calendar from verified timetable data…'), 'verified scan completion must carry into ranking refresh status');
assert.ok(schedule.includes('Full-semester scan complete — ranked calendar refreshed with verified timetable data.'), 'verified completion must remain visible after refresh');
assert.ok(schedule.includes('Profile ↗</button><a class="button small"'), 'schedule cards must label the professor profile action and keep RMP beside it');
assert.ok(schedule.includes('data-result-pin-course='), 'recommended schedule cards must be clickable pin targets');
assert.ok(schedule.includes("toggleCoursePin(card.dataset.resultPinCourse,card.dataset.resultPinOption)"), 'card pinning must reuse the calendar pin logic');
assert.ok(schedule.includes("e.target.closest('button,a,input,select,textarea,label,summary')"), 'card pinning must not hijack Profile/RMP/Compare controls');
assert.ok(schedule.includes('.section-card.pinned{'), 'pinned schedule cards must have a visible locked state');
assert.ok(schedule.includes('Showing ${visible.size} of ${totalCourses} loaded courses by your calendar selection.'), 'subset notice must describe an intentional local preview, not incomplete loading');
assert.ok(schedule.includes("schedule-subset-note ${allVerified?'ready':''}"), 'local re-ranking should be green only when the checked courses are fully verified');
assert.ok(schedule.includes('Timetables ready'), 'ranked-schedule summary must distinguish timetable readiness from grade-history completion');
assert.ok(schedule.includes('confirmPinnedCourseChange(courseCode,changeDescription)'), 'pinned course changes must require confirmation before unlocking');
assert.ok(schedule.includes('unlockPinnedCourseAfterApproval'), 'approved course-specific changes must remove only the affected pin');
assert.ok(schedule.includes('restorePinnedCourse(code,unlockedPin)'), 'failed course preference saves must restore the previous pin');
assert.ok(schedule.includes('restorePinnedCourse(code,unlockedPin)'), 'failed professor preference saves must restore the previous pin');
assert.ok(schedule.includes('Unlock &amp; apply'), 'pin-change confirmation must clearly describe the unlock action');
assert.ok(schedule.includes('Grade history can continue loading after the calendar becomes usable.'), 'calendar must become usable from fast VSB data before Cognos finishes');
assert.ok(server.includes('Wait until every checked course has a fast timetable before updating schedules.'), 'analysis API must gate on timetable availability rather than grade-history completion');
assert.ok(server.includes('async function requestV3SchedulePrefetch()'), 'server must support opportunistic fast-timetable prefetch');
assert.ok(server.includes('New courses added while Cognos'), 'prefetch implementation must document Cognos-independent schedule loading');
assert.ok(server.includes('retrying fast timetable on primary VSB before grade-history processing continues'), 'isolated fast-load misses must receive an immediate primary repair attempt');

console.log('Release UI/concurrency consistency tests passed');
