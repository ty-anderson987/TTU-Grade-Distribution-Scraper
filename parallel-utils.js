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

module.exports = { planParallelRanges, mergeParallelVerifiedOptions, partCoversRange };
