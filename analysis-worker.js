// Copyright 2026 Ty Anderson
// SPDX-License-Identifier: Apache-2.0

const { parentPort, workerData } = require('worker_threads');
const { analyzeSchedules } = require('./schedule-engine');

function send(type, payload = {}) {
    if (parentPort) parentPort.postMessage({ type, ...payload });
}

try {
    const records = Array.isArray(workerData?.records) ? workerData.records : [];
    const prefs = workerData?.prefs || {};
    const result = analyzeSchedules(records, prefs, {
        compact: true,
        topLimit: 250,
        maxSchedules: 100000,
        onProgress(progress) {
            send('progress', { progress });
        }
    });
    send('result', { result });
} catch (error) {
    send('error', { error: error?.stack || error?.message || String(error) });
}
