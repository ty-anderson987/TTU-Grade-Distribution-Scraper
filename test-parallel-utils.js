// Copyright 2026 Ty Anderson
// SPDX-License-Identifier: Apache-2.0

const assert = require('assert');
const { planParallelRanges, mergeParallelVerifiedOptions, partCoversRange } = require('./parallel-utils');

function assertCoverage(total, sessions) {
    const ranges = planParallelRanges(total, sessions);
    assert.strictEqual(ranges.length, Math.min(total, Math.max(1, sessions)));
    const seen = [];
    for (const range of ranges) {
        assert.ok(range.start >= 1 && range.end >= range.start && range.end <= total);
        for (let i = range.start; i <= range.end; i++) seen.push(i);
    }
    assert.deepStrictEqual(seen, Array.from({ length: total }, (_, i) => i + 1));
    if (ranges.length > 1) assert.strictEqual(ranges.at(-1).direction, 'backward');
}

for (let total = 1; total <= 250; total++) {
    for (let sessions = 1; sessions <= 5; sessions++) assertCoverage(total, sessions);
}

assert.deepStrictEqual(planParallelRanges(107, 3), [
    { start: 1, end: 36, direction: 'forward' },
    { start: 37, end: 72, direction: 'forward' },
    { start: 73, end: 107, direction: 'backward' }
]);

assert.deepStrictEqual(planParallelRanges(107, 5), [
    { start: 1, end: 22, direction: 'forward' },
    { start: 23, end: 44, direction: 'forward' },
    { start: 45, end: 65, direction: 'forward' },
    { start: 66, end: 86, direction: 'forward' },
    { start: 87, end: 107, direction: 'backward' }
]);

// Duplicate VSB result pages can intentionally collapse to the same optionKey. Coverage
// must be proven by visited result indexes, not by counting emitted unique options.
const base = [
    { optionKey: 'A', value: 'old-a' },
    { optionKey: 'B', value: 'old-b' }
];
const parts = [
    {
        visitedResultIndexes: [1, 2],
        options: [{ optionKey: 'A', value: 'new-a', vsbResultIndex: 1 }]
    },
    {
        visitedResultIndexes: [4, 3],
        options: [{ optionKey: 'B', value: 'new-b', vsbResultIndex: 4 }]
    }
];
const merged = mergeParallelVerifiedOptions(base, parts);
assert.deepStrictEqual([...merged.resultIndexes].sort((a, b) => a - b), [1, 2, 3, 4]);
assert.strictEqual(merged.merged.find(x => x.optionKey === 'A').value, 'new-a');
assert.strictEqual(merged.merged.find(x => x.optionKey === 'B').value, 'new-b');

// A parallel result is trusted only when it reports the expected global VSB count and
// explicitly visited every result index in its assigned range.
assert.strictEqual(partCoversRange({ totalReported: 107, visitedResultIndexes: [87, 88, 89] }, { start: 87, end: 89 }, 107), true);
assert.strictEqual(partCoversRange({ totalReported: 38, visitedResultIndexes: [38] }, { start: 87, end: 107 }, 107), false);
assert.strictEqual(partCoversRange({ totalReported: 107, visitedResultIndexes: [87, 89] }, { start: 87, end: 89 }, 107), false);

console.log('parallel utility tests passed');
