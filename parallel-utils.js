// Copyright 2026 Ty Anderson
// SPDX-License-Identifier: Apache-2.0

function planParallelRanges(totalResults, requestedSessions) {
    const total = Math.max(0, Math.floor(Number(totalResults) || 0));
    const sessions = Math.max(1, Math.min(total || 1, Math.floor(Number(requestedSessions) || 1)));
    if (!total) return [];

    const baseSize = Math.floor(total / sessions);
    const remainder = total % sessions;
    const ranges = [];
    let nextStart = 1;
    for (let index = 0; index < sessions; index++) {
        const size = baseSize + (index < remainder ? 1 : 0);
        const start = nextStart;
        const end = start + size - 1;
        ranges.push({ start, end, direction: index === sessions - 1 && sessions > 1 ? "backward" : "forward" });
        nextStart = end + 1;
    }
    return ranges;
}

function planRemainingRanges(totalResults, completedIndexes, requestedSessions) {
    const total = Math.max(0, Math.floor(Number(totalResults) || 0));
    if (!total) return [];
    const completed = new Set((completedIndexes instanceof Set ? [...completedIndexes] : (Array.isArray(completedIndexes) ? completedIndexes : []))
        .map(value => Number(value || 0))
        .filter(value => Number.isInteger(value) && value >= 1 && value <= total));
    const missing = [];
    for (let index = 1; index <= total; index++) {
        if (!completed.has(index)) missing.push(index);
    }
    if (!missing.length) return [];

    const sessions = Math.max(1, Math.min(missing.length, Math.floor(Number(requestedSessions) || 1)));
    let runs = [];
    let start = missing[0];
    let previous = missing[0];
    for (let i = 1; i < missing.length; i++) {
        const current = missing[i];
        if (current === previous + 1) {
            previous = current;
            continue;
        }
        runs.push({ start, end: previous });
        start = previous = current;
    }
    runs.push({ start, end: previous });

    // Repeated foreground pauses can leave several completed islands. If there are
    // more missing runs than available VSB sessions, merge across the smallest
    // already-completed gap. That may re-check a tiny completed island, but avoids
    // serializing the whole remaining scan and minimizes duplicate work.
    while (runs.length > sessions) {
        let mergeAt = 0;
        let smallestGap = Infinity;
        for (let i = 0; i < runs.length - 1; i++) {
            const gap = runs[i + 1].start - runs[i].end - 1;
            if (gap < smallestGap) {
                smallestGap = gap;
                mergeAt = i;
            }
        }
        const merged = { start: runs[mergeAt].start, end: runs[mergeAt + 1].end };
        runs.splice(mergeAt, 2, merged);
    }

    // Split the largest remaining runs until idle sessions can be put to work.
    while (runs.length < sessions) {
        let splitAt = -1;
        let largest = 1;
        for (let i = 0; i < runs.length; i++) {
            const size = runs[i].end - runs[i].start + 1;
            if (size > largest) {
                largest = size;
                splitAt = i;
            }
        }
        if (splitAt < 0) break;
        const range = runs[splitAt];
        const midpoint = Math.floor((range.start + range.end) / 2);
        runs.splice(splitAt, 1,
            { start: range.start, end: midpoint },
            { start: midpoint + 1, end: range.end });
    }

    runs.sort((a, b) => a.start - b.start);
    return runs.map((range, index) => ({
        ...range,
        direction: index === runs.length - 1 && runs.length > 1 ? 'backward' : 'forward'
    }));
}

function mergeParallelVerifiedOptions(baseOptions, parts) {
    const verifiedByKey = new Map();
    const resultIndexes = new Set();

    for (const part of Array.isArray(parts) ? parts : []) {
        const visited = Array.isArray(part?.visitedResultIndexes) ? part.visitedResultIndexes : [];
        for (const rawIndex of visited) {
            const index = Number(rawIndex || 0);
            if (Number.isInteger(index) && index > 0) resultIndexes.add(index);
        }
        for (const option of Array.isArray(part?.options) ? part.options : []) {
            if (option?.optionKey) verifiedByKey.set(option.optionKey, option);
            // Compatibility with result objects captured before v3.0.7. New range scans
            // report every visited VSB result explicitly, including duplicate result pages
            // that intentionally collapse to one option key.
            if (!visited.length) {
                const index = Number(option?.vsbResultIndex || 0);
                if (Number.isInteger(index) && index > 0) resultIndexes.add(index);
            }
        }
    }

    const merged = [];
    const used = new Set();
    for (const option of Array.isArray(baseOptions) ? baseOptions : []) {
        const replacement = option?.optionKey ? verifiedByKey.get(option.optionKey) : null;
        const value = replacement || option;
        merged.push(value);
        if (value?.optionKey) used.add(value.optionKey);
    }
    for (const option of verifiedByKey.values()) {
        if (!option?.optionKey || used.has(option.optionKey)) continue;
        merged.push(option);
        used.add(option.optionKey);
    }

    return { merged, verifiedByKey, resultIndexes };
}

function partCoversRange(part, range, expectedTotal) {
    const expected = Math.max(1, Math.floor(Number(expectedTotal) || 0));
    if (!part || !range || Number(part.totalReported || 0) !== expected) return false;
    const visited = new Set((Array.isArray(part.visitedResultIndexes) ? part.visitedResultIndexes : [])
        .map(value => Number(value || 0))
        .filter(value => Number.isInteger(value) && value > 0));
    for (let index = Number(range.start); index <= Number(range.end); index++) {
        if (!visited.has(index)) return false;
    }
    return true;
}

module.exports = { planParallelRanges, planRemainingRanges, mergeParallelVerifiedOptions, partCoversRange };
