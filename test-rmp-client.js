// Copyright 2026 Ty Anderson
// SPDX-License-Identifier: Apache-2.0

const assert = require('assert');
const { RmpClient, RMP_SCHOOL_RELAY_ID, publicTeacher } = require('./rmp-client');

(async () => {
    let calls = 0;
    const fetchImpl = async (_url, options) => {
        calls++;
        const body = JSON.parse(options.body);
        if (body.query.includes('NewSearchTeachersQuery')) {
            assert.strictEqual(body.variables.query.schoolID, RMP_SCHOOL_RELAY_ID);
            if (body.variables.query.text === 'Nobody Here') {
                return { ok: true, status: 200, json: async () => ({ data: { newSearch: { teachers: { resultCount: 0, edges: [] } } } }) };
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({ data: { newSearch: { teachers: { resultCount: 1, edges: [{ node: {
                    id: 'VGVhY2hlci0xMjM=', legacyId: 123, firstName: 'Jane', lastName: 'Doe', department: 'Engineering',
                    avgRating: 4.7, avgDifficulty: 2.8, numRatings: 42, wouldTakeAgainPercent: 91
                } }] } } } })
            };
        }
        return {
            ok: true,
            status: 200,
            json: async () => ({ data: { node: {
                __typename: 'Teacher', id: 'VGVhY2hlci0xMjM=', legacyId: 123, firstName: 'Jane', lastName: 'Doe', department: 'Engineering',
                avgRating: 4.7, avgDifficulty: 2.8, numRatings: 42, wouldTakeAgainPercent: 91,
                ratingsDistribution: { r1: 1, r2: 2, r3: 3, r4: 10, r5: 26, total: 42 },
                teacherRatingTags: [{ tagName: 'Caring', tagCount: 12 }, { tagName: 'Amazing lectures', tagCount: 8 }],
                courseCodes: [{ courseName: 'ECE3302', courseCount: 20 }]
            } } })
        };
    };

    const client = new RmpClient({ fetchImpl, ttlMs: 60_000 });
    const result = await client.lookup('Doe, Jane', 'ECE 3302');
    assert.strictEqual(result.status, 'success');
    assert.strictEqual(result.avgRating, 4.7);
    assert.strictEqual(result.avgDifficulty, 2.8);
    assert.strictEqual(result.numRatings, 42);
    assert.strictEqual(result.wouldTakeAgainPercent, 91);
    assert.strictEqual(result.courseMatched, true);
    assert.strictEqual(result.matchConfidence, 'exact-name-course');
    assert.deepStrictEqual(result.tags.map(t => t.name), ['Caring', 'Amazing lectures']);
    assert.ok(result.profileUrl.endsWith('/professor/123'));

    const callsAfterFirst = calls;
    const cached = await client.lookup('Doe, Jane', 'ECE 3302');
    assert.strictEqual(cached.cached, true);
    assert.strictEqual(calls, callsAfterFirst, 'cached RMP lookup should not hit the network again');


    const unrated = publicTeacher({
        legacyId: 999, firstName: 'Don', lastName: 'Bundock', department: 'Science',
        avgRating: 0, avgDifficulty: 0, numRatings: 0, wouldTakeAgainPercent: 0,
        ratingsDistribution: { r1: 0, r2: 0, r3: 0, r4: 0, r5: 0, total: 0 },
        teacherRatingTags: [], courseCodes: []
    }, 'CONE 2200', 'exact-name');
    assert.strictEqual(unrated.status, 'success');
    assert.strictEqual(unrated.numRatings, 0);
    assert.strictEqual(unrated.avgRating, null, 'an unrated RMP profile must not become 0/5');
    assert.strictEqual(unrated.avgDifficulty, null, 'unrated difficulty must display as unavailable');
    assert.strictEqual(unrated.wouldTakeAgainPercent, null, 'unrated take-again must display as unavailable');

    const missing = await client.lookup('Nobody Here', 'ECE 3302');
    assert.strictEqual(missing.status, 'not-found');
    assert.ok(missing.profileUrl.includes('/search/professors/1011'));

    console.log('RMP client tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
