// Copyright 2026 Ty Anderson
// SPDX-License-Identifier: Apache-2.0

const fs = require("fs");
const path = require("path");

const RMP_GRAPHQL_URL = "https://www.ratemyprofessors.com/graphql";
const RMP_SCHOOL_LEGACY_ID = 1011; // Texas Tech University
const RMP_SCHOOL_RELAY_ID = Buffer.from(`School-${RMP_SCHOOL_LEGACY_ID}`).toString("base64");
const RMP_AUTH = "Basic dGVzdDp0ZXN0"; // test:test, used by RMP's public frontend GraphQL client
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_VERSION = 2;

const SEARCH_QUERY = `
query NewSearchTeachersQuery($query: TeacherSearchQuery!) {
  newSearch {
    teachers(query: $query) {
      resultCount
      edges {
        node {
          id
          legacyId
          firstName
          lastName
          department
          avgRating
          avgDifficulty
          numRatings
          wouldTakeAgainPercent
        }
      }
    }
  }
}`;

const DETAIL_QUERY = `
query GetTeacher($id: ID!) {
  node(id: $id) {
    __typename
    ... on Teacher {
      id
      legacyId
      firstName
      lastName
      department
      avgRating
      avgDifficulty
      numRatings
      wouldTakeAgainPercent
      ratingsDistribution { r1 r2 r3 r4 r5 total }
      teacherRatingTags { tagName tagCount }
      courseCodes { courseName courseCount }
    }
  }
}`;

function cleanName(value) {
    return String(value || "")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-zA-Z0-9,.' -]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function displayName(value) {
    const cleaned = cleanName(value);
    if (!cleaned.includes(",")) return cleaned;
    const [last, ...rest] = cleaned.split(",");
    const first = rest.join(" ").trim();
    return [first, last.trim()].filter(Boolean).join(" ");
}

function normalizeName(value) {
    return displayName(value)
        .toLowerCase()
        .replace(/\b(dr|prof|professor)\.?\b/g, " ")
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function normalizeCourseCode(value) {
    return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function finiteOrNull(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function intOrZero(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

function publicTeacher(node, courseCode = "", matchConfidence = "exact-name") {
    const legacyId = Number(node?.legacyId);
    const numRatings = intOrZero(node?.numRatings);
    const rawRating = finiteOrNull(node?.avgRating);
    const rawDifficulty = finiteOrNull(node?.avgDifficulty);
    const wouldTakeAgain = finiteOrNull(node?.wouldTakeAgainPercent);
    // RMP uses 0/5-style numeric placeholders for unrated profiles. Treat those as
    // missing data rather than real scores so the UI shows an em dash and ranking
    // never interprets an unrated professor as a zero-rated professor.
    const hasRatings = numRatings > 0;
    const avgRating = hasRatings && rawRating !== null && rawRating >= 1 && rawRating <= 5 ? rawRating : null;
    const avgDifficulty = hasRatings && rawDifficulty !== null && rawDifficulty > 0 && rawDifficulty <= 5 ? rawDifficulty : null;
    const tags = Array.isArray(node?.teacherRatingTags)
        ? node.teacherRatingTags
            .map(item => ({ name: String(item?.tagName || "").trim(), count: intOrZero(item?.tagCount) }))
            .filter(item => item.name)
            .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
        : [];
    const courseCodes = Array.isArray(node?.courseCodes)
        ? node.courseCodes
            .map(item => ({ name: String(item?.courseName || "").trim(), count: intOrZero(item?.courseCount) }))
            .filter(item => item.name)
            .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
        : [];
    const normalizedCourse = normalizeCourseCode(courseCode);
    const matchedCourse = normalizedCourse
        ? courseCodes.some(item => normalizeCourseCode(item.name) === normalizedCourse)
        : false;
    const dist = node?.ratingsDistribution || {};

    return {
        status: "success",
        name: [node?.firstName, node?.lastName].filter(Boolean).join(" ").trim(),
        firstName: String(node?.firstName || "").trim(),
        lastName: String(node?.lastName || "").trim(),
        department: String(node?.department || "").trim(),
        avgRating,
        avgDifficulty,
        numRatings,
        wouldTakeAgainPercent: hasRatings && wouldTakeAgain !== null && wouldTakeAgain >= 0 ? wouldTakeAgain : null,
        ratingDistribution: {
            r1: intOrZero(dist.r1), r2: intOrZero(dist.r2), r3: intOrZero(dist.r3),
            r4: intOrZero(dist.r4), r5: intOrZero(dist.r5), total: intOrZero(dist.total)
        },
        tags,
        courseCodes,
        courseMatched: matchedCourse,
        matchConfidence,
        profileUrl: Number.isFinite(legacyId) && legacyId > 0
            ? `https://www.ratemyprofessors.com/professor/${legacyId}`
            : `https://www.ratemyprofessors.com/search/professors/${RMP_SCHOOL_LEGACY_ID}?q=${encodeURIComponent(displayName(node ? `${node.firstName || ""} ${node.lastName || ""}` : ""))}`
    };
}

class RmpClient {
    constructor(options = {}) {
        this.fetchImpl = options.fetchImpl || global.fetch;
        this.cachePath = options.cachePath || "";
        this.ttlMs = Math.max(60_000, Number(options.ttlMs) || DEFAULT_TTL_MS);
        this.onStatus = options.onStatus || (() => {});
        this.cache = new Map();
        this.inflight = new Map();
        this.load();
    }

    cacheKey(name, courseCode) {
        return `${normalizeName(name)}::${normalizeCourseCode(courseCode)}`;
    }

    load() {
        if (!this.cachePath) return;
        try {
            if (!fs.existsSync(this.cachePath)) return;
            const parsed = JSON.parse(fs.readFileSync(this.cachePath, "utf8"));
            if (!parsed || parsed.version !== CACHE_VERSION || typeof parsed.entries !== "object") return;
            for (const [key, entry] of Object.entries(parsed.entries)) {
                if (!entry || typeof entry !== "object") continue;
                this.cache.set(key, entry);
            }
        } catch (error) {
            console.warn(`[rmp] Ignoring unreadable cache: ${error.message}`);
        }
    }

    save() {
        if (!this.cachePath) return;
        try {
            fs.mkdirSync(path.dirname(this.cachePath), { recursive: true, mode: 0o700 });
            const entries = {};
            for (const [key, value] of this.cache) entries[key] = value;
            const temp = `${this.cachePath}.tmp`;
            fs.writeFileSync(temp, JSON.stringify({ version: CACHE_VERSION, entries }, null, 2), { encoding: "utf8", mode: 0o600 });
            if (process.platform !== "win32") {
                try { fs.chmodSync(temp, 0o600); } catch {}
            }
            fs.renameSync(temp, this.cachePath);
        } catch (error) {
            console.warn(`[rmp] Could not save cache: ${error.message}`);
        }
    }

    getCached(name, courseCode) {
        const key = this.cacheKey(name, courseCode);
        const entry = this.cache.get(key);
        if (!entry) return null;
        const age = Date.now() - Number(entry.fetchedAt || 0);
        if (age > this.ttlMs) return null;
        return entry.result || null;
    }

    async graphql(query, variables, timeoutMs = 12000) {
        if (typeof this.fetchImpl !== "function") throw new Error("This Node.js version does not provide fetch().");
        let lastError = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), timeoutMs);
            timeout.unref?.();
            try {
                const response = await this.fetchImpl(RMP_GRAPHQL_URL, {
                    method: "POST",
                    headers: {
                        "Authorization": RMP_AUTH,
                        "Content-Type": "application/json",
                        "Accept": "application/json",
                        "User-Agent": "Mozilla/5.0 TTU-Grade-Scraper/3.1.1"
                    },
                    body: JSON.stringify({ query, variables }),
                    signal: controller.signal
                });
                if (!response.ok) throw new Error(`Rate My Professors returned HTTP ${response.status}.`);
                const payload = await response.json();
                if (Array.isArray(payload?.errors) && payload.errors.length) {
                    throw new Error(payload.errors.map(item => item?.message || "GraphQL error").join("; "));
                }
                return payload?.data || {};
            } catch (error) {
                lastError = error;
                if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 350));
            } finally {
                clearTimeout(timeout);
            }
        }
        throw lastError || new Error("Rate My Professors request failed.");
    }

    async search(name) {
        const queryName = displayName(name);
        const data = await this.graphql(SEARCH_QUERY, {
            query: { text: queryName, schoolID: RMP_SCHOOL_RELAY_ID }
        });
        const teacherSearch = data?.newSearch?.teachers || {};
        return Array.isArray(teacherSearch.edges)
            ? teacherSearch.edges.map(edge => edge?.node).filter(Boolean)
            : [];
    }

    async detail(id) {
        const data = await this.graphql(DETAIL_QUERY, { id });
        const node = data?.node;
        if (!node || node.__typename !== "Teacher") return null;
        return node;
    }

    async lookup(name, courseCode = "") {
        const key = this.cacheKey(name, courseCode);
        const cached = this.getCached(name, courseCode);
        if (cached) return { ...cached, cached: true };
        if (this.inflight.has(key)) return await this.inflight.get(key);

        const task = this._lookupFresh(name, courseCode)
            .then(result => {
                // Cache successful matches and real not-found results. Do not persist network
                // failures, because a temporary RMP outage should recover on the next request.
                if (result.status === "success" || result.status === "not-found" || result.status === "ambiguous") {
                    this.cache.set(key, { fetchedAt: Date.now(), result });
                    if (this.cache.size > 500) {
                        const oldest = [...this.cache.entries()]
                            .sort((a, b) => Number(a[1]?.fetchedAt || 0) - Number(b[1]?.fetchedAt || 0))
                            .slice(0, 100);
                        for (const [oldKey] of oldest) this.cache.delete(oldKey);
                    }
                    this.save();
                }
                return result;
            })
            .finally(() => this.inflight.delete(key));
        this.inflight.set(key, task);
        return await task;
    }

    async _lookupFresh(name, courseCode) {
        const requestedName = displayName(name);
        const normalizedRequested = normalizeName(requestedName);
        if (!normalizedRequested) return { status: "not-found", name: requestedName, courseCode, message: "No professor name supplied." };

        this.onStatus(`Looking up ${requestedName} on Rate My Professors...`);
        const candidates = await this.search(requestedName);
        if (!candidates.length) {
            return {
                status: "not-found",
                name: requestedName,
                courseCode,
                profileUrl: `https://www.ratemyprofessors.com/search/professors/${RMP_SCHOOL_LEGACY_ID}?q=${encodeURIComponent(requestedName)}`
            };
        }

        const exact = candidates.filter(candidate => normalizeName(`${candidate.firstName || ""} ${candidate.lastName || ""}`) === normalizedRequested);
        const pool = (exact.length ? exact : candidates).slice(0, 5);
        const detailed = [];
        for (const candidate of pool) {
            try {
                const node = await this.detail(candidate.id);
                if (node) detailed.push(node);
            } catch {}
        }
        if (!detailed.length) {
            // Search results already contain the core score fields. Use an exact unique
            // search hit rather than discarding useful data if the detail hop alone fails.
            if (exact.length === 1) return publicTeacher(exact[0], courseCode, "exact-name-search");
            throw new Error("Rate My Professors search worked, but professor details could not be loaded.");
        }

        const normalizedCourse = normalizeCourseCode(courseCode);
        const exactDetailed = detailed.filter(candidate => normalizeName(`${candidate.firstName || ""} ${candidate.lastName || ""}`) === normalizedRequested);
        const courseMatches = normalizedCourse
            ? exactDetailed.filter(candidate => (candidate.courseCodes || []).some(item => normalizeCourseCode(item?.courseName) === normalizedCourse))
            : [];

        if (courseMatches.length === 1) return publicTeacher(courseMatches[0], courseCode, "exact-name-course");
        if (exactDetailed.length === 1) return publicTeacher(exactDetailed[0], courseCode, normalizedCourse ? "exact-name" : "exact-name");

        if (exactDetailed.length > 1) {
            return {
                status: "ambiguous",
                name: requestedName,
                courseCode,
                matches: exactDetailed.length,
                profileUrl: `https://www.ratemyprofessors.com/search/professors/${RMP_SCHOOL_LEGACY_ID}?q=${encodeURIComponent(requestedName)}`
            };
        }

        // Avoid silently attaching a same-school, similar-name profile to the wrong
        // instructor. Leave the UI on a search link when no exact normalized name exists.
        return {
            status: "not-found",
            name: requestedName,
            courseCode,
            profileUrl: `https://www.ratemyprofessors.com/search/professors/${RMP_SCHOOL_LEGACY_ID}?q=${encodeURIComponent(requestedName)}`
        };
    }

    async lookupBatch(items, concurrency = 3) {
        const list = Array.isArray(items) ? items.slice(0, 40) : [];
        const results = new Array(list.length);
        let next = 0;
        const workerCount = Math.max(1, Math.min(Number(concurrency) || 3, list.length || 1));
        const worker = async () => {
            while (true) {
                const index = next++;
                if (index >= list.length) return;
                const item = list[index] || {};
                try {
                    results[index] = await this.lookup(item.name, item.courseCode);
                } catch (error) {
                    results[index] = {
                        status: "error",
                        name: displayName(item.name),
                        courseCode: String(item.courseCode || ""),
                        error: error.message,
                        profileUrl: `https://www.ratemyprofessors.com/search/professors/${RMP_SCHOOL_LEGACY_ID}?q=${encodeURIComponent(displayName(item.name))}`
                    };
                }
            }
        };
        await Promise.all(Array.from({ length: workerCount }, () => worker()));
        return results;
    }
}

module.exports = {
    RmpClient,
    RMP_SCHOOL_LEGACY_ID,
    RMP_SCHOOL_RELAY_ID,
    displayName,
    normalizeName,
    normalizeCourseCode,
    publicTeacher
};
