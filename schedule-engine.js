// Copyright 2026 Ty Anderson
// SPDX-License-Identifier: Apache-2.0

function normalizeSpace(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeCourseCode(value) {
    const raw = String(value || "").toUpperCase();
    const match = raw.match(/([A-Z]{2,8})\s*[-_.:/]?\s*(\d{3,5})/);
    if (!match) return null;
    return `${match[1]} ${match[2]}`;
}

function parseCourseList(value) {
    const raw = Array.isArray(value) ? value.join("\n") : String(value || "");
    const chunks = raw.split(/[\n,;]+/).map(item => item.trim()).filter(Boolean);
    const found = [];
    const invalid = [];
    const seen = new Set();

    for (const chunk of chunks) {
        const matches = [...chunk.toUpperCase().matchAll(/([A-Z]{2,8})\s*[-_.:/]?\s*(\d{3,5})/g)];
        if (!matches.length) {
            invalid.push(chunk);
            continue;
        }
        for (const match of matches) {
            const code = `${match[1]} ${match[2]}`;
            if (!seen.has(code)) {
                seen.add(code);
                found.push(code);
            }
        }
    }

    return { courses: found, invalid };
}

function instructorKey(value) {
    return normalizeSpace(value)
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\b(dr|prof|professor)\.?\b/g, "")
        .replace(/[^a-z0-9, ]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function timeToMinutes(value) {
    if (value === null || value === undefined || value === "") return null;
    if (Number.isFinite(value)) {
        const numeric = Number(value);
        return numeric >= 0 && numeric <= 24 * 60 ? numeric : null;
    }
    const text = String(value).trim().toUpperCase();
    let match = text.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/);
    if (match) {
        const rawHour = Number(match[1]);
        const minute = Number(match[2]);
        if (rawHour < 1 || rawHour > 12 || minute < 0 || minute > 59) return null;
        let hour = rawHour % 12;
        if (match[3] === "PM") hour += 12;
        return hour * 60 + minute;
    }
    match = text.match(/^(\d{1,2}):(\d{2})$/);
    if (match) {
        const hour = Number(match[1]);
        const minute = Number(match[2]);
        if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
        return hour * 60 + minute;
    }
    return null;
}

function minutesToTime(value) {
    if (!Number.isFinite(value)) return "Any";
    const hour24 = Math.floor(value / 60);
    const min = value % 60;
    const suffix = hour24 >= 12 ? "PM" : "AM";
    const hour = hour24 % 12 || 12;
    return `${hour}:${String(min).padStart(2, "0")} ${suffix}`;
}

function termValue(term) {
    const text = normalizeSpace(term);
    const year = Number((text.match(/\b(20\d{2})\b/) || [])[1] || 0);
    let season = 0;
    if (/spring/i.test(text)) season = 1;
    else if (/summer\s*i\b/i.test(text)) season = 2;
    else if (/summer\s*ii\b/i.test(text)) season = 2.5;
    else if (/summer/i.test(text)) season = 2.25;
    else if (/early\s+fall/i.test(text)) season = 3.5;
    else if (/fall/i.test(text)) season = 4;
    else if (/late\s+fall/i.test(text)) season = 4.5;
    return year * 10 + season;
}

function gradeMetrics(rows) {
    const total = rows.reduce((acc, row) => {
        for (const key of ["A", "B", "C", "D", "F", "W"]) acc[key] += Number(row[key] || 0);
        return acc;
    }, { A: 0, B: 0, C: 0, D: 0, F: 0, W: 0 });

    const graded = total.A + total.B + total.C + total.D + total.F;
    const dfwDenom = graded + total.W;
    const gpa = graded ? (4 * total.A + 3 * total.B + 2 * total.C + total.D) / graded : null;
    return {
        ...total,
        students: graded,
        gpa,
        aRate: graded ? total.A / graded : null,
        abcRate: graded ? (total.A + total.B + total.C) / graded : null,
        dfwRate: dfwDenom ? (total.D + total.F + total.W) / dfwDenom : null
    };
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function forecastTermIndex(term) {
    const text = normalizeSpace(term);
    const year = Number((text.match(/\b(20\d{2})\b/) || [])[1] || 0);
    if (!year) return 0;

    // Keep common academic terms roughly one step apart. termValue() intentionally
    // preserves the app's historical sort semantics; regression needs a more
    // uniform time axis so Fall -> Spring is not treated as seven times farther
    // apart than Spring -> Summer.
    let season = 0;
    if (/winter/i.test(text)) season = -0.35;
    else if (/spring/i.test(text)) season = 0;
    else if (/summer\s*i\b/i.test(text)) season = 0.85;
    else if (/summer\s*ii\b/i.test(text)) season = 1.15;
    else if (/summer/i.test(text)) season = 1;
    else if (/early\s+fall/i.test(text)) season = 1.8;
    else if (/late\s+fall/i.test(text)) season = 2.2;
    else if (/fall/i.test(text)) season = 2;
    return year * 3 + season;
}

function forecastProfessorGpa(terms, planningTerm, adjustedGpa = null) {
    const observations = (Array.isArray(terms) ? terms : [])
        .map(term => ({
            x: forecastTermIndex(term.term),
            y: Number(term.gpa),
            students: Math.max(0, Number(term.students || 0))
        }))
        .filter(item => item.x > 0 && Number.isFinite(item.y));

    if (observations.length < 3) {
        return { predictedGpa: null, predictionLow: null, predictionHigh: null, predictionConfidence: "insufficient", regressionSlope: null, regressionTerms: observations.length };
    }

    const target = forecastTermIndex(planningTerm);
    if (!(target > 0)) {
        return { predictedGpa: null, predictionLow: null, predictionHigh: null, predictionConfidence: "insufficient", regressionSlope: null, regressionTerms: observations.length };
    }

    // Weighted least squares. sqrt(enrollment) gives larger sections more influence
    // without allowing one unusually large section to dominate the trend line.
    const weighted = observations.map(item => ({ ...item, w: Math.sqrt(Math.max(1, item.students)) }));
    const wsum = weighted.reduce((sum, item) => sum + item.w, 0);
    const xbar = weighted.reduce((sum, item) => sum + item.x * item.w, 0) / wsum;
    const ybar = weighted.reduce((sum, item) => sum + item.y * item.w, 0) / wsum;
    const denom = weighted.reduce((sum, item) => sum + item.w * (item.x - xbar) ** 2, 0);
    if (!(denom > 0)) {
        return { predictedGpa: null, predictionLow: null, predictionHigh: null, predictionConfidence: "insufficient", regressionSlope: null, regressionTerms: observations.length };
    }

    const rawSlope = weighted.reduce((sum, item) => sum + item.w * (item.x - xbar) * (item.y - ybar), 0) / denom;
    const totalStudents = observations.reduce((sum, item) => sum + item.students, 0);
    const reliability = Math.min(1, (observations.length - 1) / 4) * Math.min(1, totalStudents / 160);
    // GPA is bounded and term-to-term noise can be large. Keep the requested
    // linear-regression model, but shrink and cap the slope before extrapolation.
    const slope = clamp(rawSlope * reliability, -0.25, 0.25);
    const rawPrediction = ybar + slope * (target - xbar);

    // Blend the extrapolated line with the shrinkage-adjusted historical GPA so
    // short/noisy histories cannot create implausibly aggressive forecasts.
    const baseline = Number.isFinite(adjustedGpa) ? Number(adjustedGpa) : ybar;
    const predictedGpa = clamp(baseline * 0.35 + rawPrediction * 0.65, 0, 4);
    const rmse = Math.sqrt(weighted.reduce((sum, item) => {
        const fitted = ybar + slope * (item.x - xbar);
        return sum + item.w * (item.y - fitted) ** 2;
    }, 0) / wsum);
    const lastX = Math.max(...observations.map(item => item.x));
    const extrapolation = Math.max(0, target - lastX);
    const margin = clamp(Math.max(0.10, rmse * 1.25 + (1 - reliability) * 0.18 + extrapolation * 0.08), 0.10, 0.75);
    const confidence = extrapolation > 2.25
        ? "low"
        : observations.length >= 5 && totalStudents >= 180 && rmse <= 0.28
            ? "high"
            : observations.length >= 3 && totalStudents >= 70 && rmse <= 0.45
                ? "medium"
                : "low";

    return {
        predictedGpa,
        predictionLow: clamp(predictedGpa - margin, 0, 4),
        predictionHigh: clamp(predictedGpa + margin, 0, 4),
        predictionConfidence: confidence,
        regressionSlope: slope,
        regressionTerms: observations.length
    };
}

function buildGradeSummary(history, planningTerm = "") {
    const rows = Array.isArray(history?.rows) ? history.rows.filter(row => row.rowType === "data") : [];
    const courseMetrics = gradeMetrics(rows);
    const byProfessor = new Map();

    for (const row of rows) {
        const key = instructorKey(row.instructor);
        if (!key) continue;
        if (!byProfessor.has(key)) byProfessor.set(key, []);
        byProfessor.get(key).push(row);
    }

    const professors = {};
    const priorWeight = 25;
    const courseMean = Number.isFinite(courseMetrics.gpa) ? courseMetrics.gpa : 2.75;

    for (const [key, professorRows] of byProfessor) {
        const metrics = gradeMetrics(professorRows);
        const termGroups = new Map();
        for (const row of professorRows) {
            if (!termGroups.has(row.term)) termGroups.set(row.term, []);
            termGroups.get(row.term).push(row);
        }
        const terms = [...termGroups.entries()]
            .map(([term, termRows]) => ({ term, ...gradeMetrics(termRows) }))
            .sort((a, b) => termValue(a.term) - termValue(b.term));

        let trend = null;
        if (terms.length >= 2 && Number.isFinite(terms[0].gpa) && Number.isFinite(terms[terms.length - 1].gpa)) {
            trend = terms[terms.length - 1].gpa - terms[0].gpa;
        }
        const adjustedGpa = Number.isFinite(metrics.gpa)
            ? ((metrics.gpa * metrics.students) + (courseMean * priorWeight)) / (metrics.students + priorWeight)
            : null;
        const forecast = forecastProfessorGpa(terms, planningTerm, adjustedGpa);

        professors[key] = {
            name: professorRows[0].instructor,
            ...metrics,
            adjustedGpa,
            trend,
            ...forecast,
            terms
        };
    }

    const courseTermGroups = new Map();
    for (const row of rows) {
        if (!courseTermGroups.has(row.term)) courseTermGroups.set(row.term, []);
        courseTermGroups.get(row.term).push(row);
    }
    const courseTerms = [...courseTermGroups.entries()]
        .map(([term, termRows]) => ({ term, ...gradeMetrics(termRows) }))
        .sort((a, b) => termValue(a.term) - termValue(b.term));

    return {
        course: courseMetrics,
        courseTerms,
        professors,
        terms: Array.isArray(history?.terms) ? history.terms : []
    };
}

function recurringMeetingPatterns(option) {
    const meetings = [];
    const seen = new Set();
    for (const component of option.components || []) {
        for (const meeting of component.meetings || []) {
            const start = timeToMinutes(meeting.start);
            const end = timeToMinutes(meeting.end);
            for (const day of meeting.days || []) {
                if (start === null || end === null) continue;
                const key = `${day}:${start}:${end}`;
                if (seen.has(key)) continue;
                seen.add(key);
                meetings.push({ day, start, end, courseCode: option.courseCode, online: Boolean(component.online) });
            }
        }
    }
    return meetings;
}

function datedMeetingList(option) {
    const out = [];
    for (const occurrence of option.occurrences || []) {
        const start = timeToMinutes(occurrence.start);
        const end = timeToMinutes(occurrence.end);
        if (!occurrence.date || start === null || end === null) continue;
        out.push({
            date: occurrence.date,
            day: occurrence.day || "",
            start,
            end,
            courseCode: option.courseCode,
            kind: occurrence.kind || "",
            special: Boolean(occurrence.special),
            online: Boolean(occurrence.online)
        });
    }
    return out;
}

function meetingList(option) {
    // Convenience scoring should reflect every kind of meeting the student may see,
    // including a one-off discussion/test period. When the full-term week capture is
    // verified, prefer those dated occurrences because they can map Lecture/Lab/
    // Discussion blocks back to the correct delivery mode. Collapse repeated dates to
    // unique weekday/time patterns so a 16-week lecture is not counted 16 times.
    if (option?.occurrenceCoverageComplete === true) {
        const byPattern = new Map();
        for (const occurrence of datedMeetingList(option)) {
            const key = `${occurrence.day}:${occurrence.start}:${occurrence.end}`;
            const current = byPattern.get(key);
            const candidate = {
                day: occurrence.day,
                start: occurrence.start,
                end: occurrence.end,
                courseCode: option.courseCode,
                online: Boolean(occurrence.online)
            };
            // If the same time pattern is represented by both an online and an
            // in-person component, count it as a campus meeting (in-person wins).
            if (!current || (current.online && !candidate.online)) byPattern.set(key, candidate);
        }
        if (byPattern.size) return [...byPattern.values()];
    }

    const recurring = recurringMeetingPatterns(option);
    const seen = new Set(recurring.map(m => `${m.day}:${m.start}:${m.end}`));
    const meetings = [...recurring];
    for (const occurrence of datedMeetingList(option)) {
        const key = `${occurrence.day}:${occurrence.start}:${occurrence.end}`;
        if (seen.has(key)) continue;
        seen.add(key);
        meetings.push({ day: occurrence.day, start: occurrence.start, end: occurrence.end, courseCode: option.courseCode, online: Boolean(occurrence.online) });
    }
    return meetings;
}

function optionsConflict(a, b) {
    const ad = datedMeetingList(a);
    const bd = datedMeetingList(b);
    const aExact = a?.occurrenceCoverageComplete === true;
    const bExact = b?.occurrenceCoverageComplete === true;

    // Only trust exact-date conflict logic when BOTH timetable options were captured
    // from the first VSB week through the last VSB week.  A partial weekly capture is
    // never allowed to create a false "no conflict" result.
    if (aExact && bExact) {
        for (const x of ad) {
            for (const y of bd) {
                if (x.date !== y.date) continue;
                if (x.start < y.end && y.start < x.end) return true;
            }
        }
        return false;
    }

    // Conservative fallback for an older/incomplete detailed capture.  This can reject
    // an alternating-week combination that might technically work, but it will never
    // knowingly recommend two classes that may overlap.
    const am = meetingList(a);
    const bm = meetingList(b);
    for (const x of am) {
        for (const y of bm) {
            if (x.day !== y.day) continue;
            if (x.start < y.end && y.start < x.end) return true;
        }
    }
    return false;
}

function buildMeetingProfile(option) {
    return {
        exact: option?.occurrenceCoverageComplete === true,
        dated: datedMeetingList(option),
        meetings: meetingList(option)
    };
}

function meetingProfilesConflict(a, b) {
    if (a.exact && b.exact) {
        for (const x of a.dated) {
            for (const y of b.dated) {
                if (x.date === y.date && x.start < y.end && y.start < x.end) return true;
            }
        }
        return false;
    }
    for (const x of a.meetings) {
        for (const y of b.meetings) {
            if (x.day === y.day && x.start < y.end && y.start < x.end) return true;
        }
    }
    return false;
}

function scheduleMeetings(schedule, meetingProfiles = null) {
    return schedule.flatMap(option => meetingProfiles?.get(option)?.meetings || meetingList(option));
}

function dailyStats(schedule, meetingProfiles = null) {
    const byDay = new Map();
    for (const meeting of scheduleMeetings(schedule, meetingProfiles)) {
        if (!byDay.has(meeting.day)) byDay.set(meeting.day, []);
        byDay.get(meeting.day).push(meeting);
    }
    let totalGap = 0;
    let maxGap = 0;
    let gapCount = 0;
    let earliest = null;
    let latest = null;
    const campusDays = new Set();
    for (const [day, meetings] of byDay.entries()) {
        if (meetings.some(meeting => !meeting.online)) campusDays.add(day);
        meetings.sort((a, b) => a.start - b.start || b.end - a.end);
        if (meetings.length) {
            const dayEarliest = Math.min(...meetings.map(meeting => meeting.start));
            const dayLatest = Math.max(...meetings.map(meeting => meeting.end));
            earliest = earliest === null ? dayEarliest : Math.min(earliest, dayEarliest);
            latest = latest === null ? dayLatest : Math.max(latest, dayLatest);

            // Treat overlapping/nested meetings as one occupied block. Comparing each
            // meeting only with the immediately previous meeting can invent a large gap
            // after a short nested component (for example 9-12 lecture + 10-11 lab +
            // 12:30 class would incorrectly look like a 90-minute gap instead of 30).
            let occupiedUntil = meetings[0].end;
            for (let i = 1; i < meetings.length; i++) {
                // A meeting that begins before the current occupied block ends is nested/
                // overlapping and does not create another break. A meeting beginning
                // exactly when the block ends is a real zero-minute back-to-back gap.
                if (meetings[i].start >= occupiedUntil) {
                    const gap = meetings[i].start - occupiedUntil;
                    totalGap += gap;
                    maxGap = Math.max(maxGap, gap);
                    gapCount++;
                }
                occupiedUntil = Math.max(occupiedUntil, meetings[i].end);
            }
        }
    }

    return {
        daysOnCampus: campusDays.size,
        totalGap,
        maxGap,
        averageGap: gapCount ? totalGap / gapCount : 0,
        earliest,
        latest,
        byDay
    };
}

function professorPreferenceForOption(option, coursePreference = {}) {
    const map = coursePreference.professors && typeof coursePreference.professors === "object"
        ? coursePreference.professors
        : {};
    let preferred = false;
    let avoided = false;
    // Preferences apply to the instructor(s) of record, not a required 0-credit
    // lab/discussion assistant. Same-time VSB alternatives are separate options, so
    // choosing/avoiding a professor still selects the correct lecture+companion CRNs.
    for (const component of primaryOptionComponents(option)) {
        const key = instructorKey(component.instructor);
        if (!key) continue;
        if (map[key] === "avoid") avoided = true;
        if (map[key] === "prefer") preferred = true;
    }
    return { preferred, avoided };
}

function optionDeliveryMode(option) {
    const components = primaryOptionComponents(option);
    if (!components.length) return "in-person";
    return components.every(component => Boolean(component.online)) ? "online" : "in-person";
}

function optionIsHonors(option) {
    // TTU VSB marks honors lecture sections as "Lec H###" (for example Lec H01).
    // Determine honors from the primary/instructor-of-record component so a linked
    // No Credit D## lab does not accidentally redefine the lecture type.
    return primaryOptionComponents(option).some(component =>
        /^(?:lec|lecture)\s+h\d{1,4}\b/i.test(normalizeSpace(component?.section))
    );
}

function optionAllowed(option, prefs, coursePreference = {}) {
    const components = option.components || [];
    if (prefs.allowFull === false && components.some(c => c.status === "full")) return false;
    if (prefs.allowWaitlist === false && components.some(c => c.status === "waitlist")) return false;
    if (prefs.allowOnline === false && optionDeliveryMode(option) === "online") return false;

    const honorsMode = String(prefs.honorsMode || "either").toLowerCase();
    const honors = optionIsHonors(option);
    if (honorsMode === "only" && !honors) return false;
    if (honorsMode === "exclude" && honors) return false;

    const delivery = String(coursePreference.delivery || "either").toLowerCase();
    const mode = optionDeliveryMode(option);
    if (delivery === "in-person" && mode !== "in-person") return false;
    if (delivery === "online" && mode !== "online") return false;

    if (professorPreferenceForOption(option, coursePreference).avoided) return false;
    return true;
}

function schedulePasses(schedule, prefs = {}) {
    const stats = dailyStats(schedule);
    const earliest = prefs.earliestStart === null || prefs.earliestStart === undefined ? null : Number(prefs.earliestStart);
    const latest = prefs.latestEnd === null || prefs.latestEnd === undefined ? null : Number(prefs.latestEnd);
    const maxGap = prefs.maxGap === null || prefs.maxGap === undefined || prefs.maxGap === "" ? null : Number(prefs.maxGap);

    if (earliest !== null && Number.isFinite(stats.earliest) && stats.earliest < earliest) return false;
    if (latest !== null && Number.isFinite(stats.latest) && stats.latest > latest) return false;
    if (maxGap !== null && stats.maxGap > maxGap) return false;
    if (prefs.noFriday && stats.byDay.has("F")) return false;
    return true;
}

function componentRolePriority(component) {
    const section = normalizeSpace(component?.section).toLowerCase();
    if (/^(lec|lecture)\b/.test(section)) return 0;
    if (/^(sem|seminar)\b/.test(section)) return 1;
    if (/^(rec|recitation|dis|disc|dsc|discussion)\b/.test(section)) return 2;
    if (/^(lab|laboratory)\b/.test(section)) return 3;
    if (/^no\s+credit\b/.test(section)) return 3;
    return 4;
}

function primaryOptionComponents(option) {
    const components = option?.components || [];
    if (!components.length) return [];
    // Prefer credit-bearing rows. Required "No Credit Dxx" companions still remain
    // in the atomic option for conflicts/CRNs, but they do not redefine professor or
    // delivery preference. If no row carries credit, fall back to the best role.
    const credited = components.filter(component => Number(component.credits) > 0);
    const pool = credited.length ? credited : components;
    const best = Math.min(...pool.map(componentRolePriority));
    return pool.filter(component => componentRolePriority(component) === best);
}

function orderedInstructorNames(option) {
    const components = [...primaryOptionComponents(option)].sort((a, b) => componentRolePriority(a) - componentRolePriority(b));
    const names = [];
    const seen = new Set();
    for (const component of components) {
        const name = normalizeSpace(component.instructor);
        const key = instructorKey(name);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        names.push(name);
    }
    return names;
}

function professorForOption(option) {
    const names = orderedInstructorNames(option);
    if (!names.length) return "TBA";
    return names.join(" / ");
}

function professorGradeForOption(option, gradeSummary) {
    // Grade Distribution normally reflects the instructor of record for the course.
    // For a linked bundle, use only the highest-priority named component role
    // (Lecture > Seminar > Discussion/Recitation > Lab > Other).  If that primary
    // instructor has no history, return neutral/no-history instead of accidentally
    // scoring the course from a lab/discussion assistant's unrelated grade record.
    const named = primaryOptionComponents(option)
        .map(component => ({
            component,
            name: normalizeSpace(component?.instructor),
            priority: componentRolePriority(component)
        }))
        .filter(item => instructorKey(item.name));
    if (!named.length) return null;

    const primaryPriority = Math.min(...named.map(item => item.priority));
    const seen = new Set();
    for (const item of named) {
        if (item.priority !== primaryPriority) continue;
        const key = instructorKey(item.name);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const exact = gradeSummary?.professors?.[key];
        if (exact) return exact;
    }
    return null;
}

function professorRmpForOption(option, rmpByProfessor = {}) {
    const named = primaryOptionComponents(option)
        .map(component => ({
            name: normalizeSpace(component?.instructor),
            priority: componentRolePriority(component)
        }))
        .filter(item => instructorKey(item.name));
    if (!named.length) return null;

    const primaryPriority = Math.min(...named.map(item => item.priority));
    const seen = new Set();
    for (const item of named) {
        if (item.priority !== primaryPriority) continue;
        const key = instructorKey(item.name);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const rmp = rmpByProfessor?.[key];
        const rating = Number(rmp?.avgRating);
        if (rmp?.status === "success" && Number.isFinite(rating) && rating >= 1 && rating <= 5 && Number(rmp.numRatings || 0) > 0) return rmp;
    }
    return null;
}

function rmpFallbackScore(rmp) {
    const rating = Number(rmp?.avgRating);
    const ratings = Math.max(0, Number(rmp?.numRatings || 0));
    if (!Number.isFinite(rating) || rating < 1 || rating > 5 || ratings < 1) return null;

    // RMP is deliberately only a fallback when TTU grade history is unavailable.
    // Shrink tiny samples toward a neutral 3.0/5 so one or two reviews cannot dominate
    // the schedule ranking. Around 10 ratings carries half the weight of the raw score.
    const priorRatings = 10;
    const neutralRating = 3;
    const adjustedRating = ((rating * ratings) + (neutralRating * priorRatings)) / (ratings + priorRatings);
    return clamp(((adjustedRating - 1) / 4) * 100, 0, 100);
}

function professorRankingPartForOption(option, gradeSummary, rmpByProfessor = {}, coursePreference = {}) {
    const grade = professorGradeForOption(option, gradeSummary);
    let score = null;
    let source = "none";
    let rmp = null;

    if (grade && Number.isFinite(grade.adjustedGpa)) {
        const forecastGpa = Number.isFinite(grade.predictedGpa)
            ? (grade.adjustedGpa * 0.65 + grade.predictedGpa * 0.35)
            : grade.adjustedGpa;
        score = (forecastGpa / 4) * 100;
        if (!Number.isFinite(grade.predictedGpa) && Number.isFinite(grade.trend)) score += Math.max(-6, Math.min(6, grade.trend * 12));
        source = "ttu-grade";
    } else {
        rmp = professorRmpForOption(option, rmpByProfessor);
        const fallback = rmpFallbackScore(rmp);
        if (Number.isFinite(fallback)) {
            score = fallback;
            source = "rmp";
        }
    }

    const preferred = professorPreferenceForOption(option, coursePreference).preferred;
    if (preferred) {
        // Explicit user preference remains meaningful even when neither external data
        // source has information for the professor. Otherwise no-data neutral options
        // are left entirely to schedule convenience, as requested.
        if (!Number.isFinite(score)) {
            score = 55;
            source = "preference";
        }
        score += 12;
    }

    return {
        score: Number.isFinite(score) ? clamp(score, 0, 100) : null,
        source,
        grade,
        rmp,
        preferred
    };
}

function scoreSchedule(schedule, gradeSummaries, prefs, coursePreferences = {}, rmpByCourse = {}, precomputedStats = null, precomputedGradeParts = null) {
    const stats = precomputedStats || dailyStats(schedule);
    const gradeParts = [];
    for (const option of schedule) {
        const cached = precomputedGradeParts?.get(option);
        if (cached) {
            if (Number.isFinite(cached.score)) gradeParts.push(cached);
            continue;
        }
        const summary = gradeSummaries[option.courseCode];
        const coursePreference = coursePreferences[option.courseCode] || {};
        const part = professorRankingPartForOption(option, summary, rmpByCourse[option.courseCode] || {}, coursePreference);
        if (!Number.isFinite(part.score)) continue;

        const requestedPriority = Number(coursePreference.professorPriority ?? 3);
        const weight = Math.max(1, Math.min(5, Number.isFinite(requestedPriority) ? requestedPriority : 3));
        gradeParts.push({ score: part.score, weight, source: part.source });
    }
    const gradeWeightTotal = gradeParts.reduce((sum, item) => sum + item.weight, 0);
    const hasProfessorData = gradeWeightTotal > 0;
    const gradeScore = hasProfessorData
        ? gradeParts.reduce((sum, item) => sum + item.score * item.weight, 0) / gradeWeightTotal
        : null;

    const gapScore = Math.max(0, 100 - Math.min(100, (stats.averageGap / 180) * 100));
    const daysScore = Math.max(0, 100 - Math.max(0, stats.daysOnCampus - 2) * 18);
    let patternScore = 70;
    if (prefs.dayPreference === "mwf") {
        const mwf = ["M", "W", "F"].reduce((n, d) => n + (stats.byDay.has(d) ? 1 : 0), 0);
        const tr = ["T", "R"].reduce((n, d) => n + (stats.byDay.has(d) ? 1 : 0), 0);
        patternScore = Math.max(0, Math.min(100, 65 + (mwf - tr) * 12));
    } else if (prefs.dayPreference === "tr") {
        const mwf = ["M", "W", "F"].reduce((n, d) => n + (stats.byDay.has(d) ? 1 : 0), 0);
        const tr = ["T", "R"].reduce((n, d) => n + (stats.byDay.has(d) ? 1 : 0), 0);
        patternScore = Math.max(0, Math.min(100, 65 + (tr - mwf) * 14));
    } else if (prefs.dayPreference === "few-days") {
        patternScore = daysScore;
    } else if (prefs.dayPreference === "compact") {
        patternScore = gapScore;
    }

    const convenienceScore = gapScore * 0.45 + daysScore * 0.25 + patternScore * 0.30;
    const gradeWeight = Math.max(0, Math.min(100, Number(prefs.gradeWeight ?? 50))) / 100;
    // If none of the chosen professors has TTU grade history, RMP data, or an explicit
    // Prefer choice, professor quality contributes nothing: the best schedule wins.
    const totalScore = hasProfessorData
        ? gradeScore * gradeWeight + convenienceScore * (1 - gradeWeight)
        : convenienceScore;

    return {
        totalScore,
        gradeScore: hasProfessorData ? gradeScore : 0,
        professorScoreAvailable: hasProfessorData,
        professorDataCourses: gradeParts.length,
        convenienceScore,
        gapScore,
        daysScore,
        stats
    };
}

function schedulePassesStats(stats, prefs = {}) {
    const earliest = prefs.earliestStart === null || prefs.earliestStart === undefined ? null : Number(prefs.earliestStart);
    const latest = prefs.latestEnd === null || prefs.latestEnd === undefined ? null : Number(prefs.latestEnd);
    const maxGap = prefs.maxGap === null || prefs.maxGap === undefined || prefs.maxGap === "" ? null : Number(prefs.maxGap);
    if (earliest !== null && Number.isFinite(stats.earliest) && stats.earliest < earliest) return false;
    if (latest !== null && Number.isFinite(stats.latest) && stats.latest > latest) return false;
    if (maxGap !== null && stats.maxGap > maxGap) return false;
    if (prefs.noFriday && stats.byDay.has("F")) return false;
    return true;
}

function buildUsableCourses(courses, prefs, coursePreferences = {}) {
    const usable = courses.map(course => ({
        ...course,
        options: (course.options || []).filter(option => optionAllowed(
            option,
            prefs,
            coursePreferences[course.courseCode] || course.preferences || {}
        ))
    }));
    usable.sort((a, b) => a.options.length - b.options.length || a.courseCode.localeCompare(b.courseCode));
    return usable;
}

function scoreRankValue(item) {
    return Number(item?.score?.totalScore ?? -Infinity);
}

function heapSwap(heap, a, b) {
    const tmp = heap[a]; heap[a] = heap[b]; heap[b] = tmp;
}

function heapPushTop(heap, item, limit) {
    if (limit <= 0) return;
    const less = (a, b) => scoreRankValue(a) < scoreRankValue(b) || (scoreRankValue(a) === scoreRankValue(b) && a.sequence > b.sequence);
    if (heap.length < limit) {
        heap.push(item);
        let i = heap.length - 1;
        while (i > 0) {
            const parent = Math.floor((i - 1) / 2);
            if (!less(heap[i], heap[parent])) break;
            heapSwap(heap, i, parent); i = parent;
        }
        return;
    }
    const root = heap[0];
    const better = scoreRankValue(item) > scoreRankValue(root) || (scoreRankValue(item) === scoreRankValue(root) && item.sequence < root.sequence);
    if (!better) return;
    heap[0] = item;
    let i = 0;
    while (true) {
        const left = i * 2 + 1, right = left + 1;
        let smallest = i;
        if (left < heap.length && less(heap[left], heap[smallest])) smallest = left;
        if (right < heap.length && less(heap[right], heap[smallest])) smallest = right;
        if (smallest === i) break;
        heapSwap(heap, i, smallest); i = smallest;
    }
}

function courseCredits(option) {
    const credits = (option.components || [])
        .map(component => Number(component.credits))
        .filter(Number.isFinite);
    return credits.length ? Math.max(...credits) : null;
}


function optionHasLinkedBundle(option) {
    const components = option.components || [];
    if (components.length > 1) return true;
    const recurringPatterns = components.reduce((count, component) => count + (component.meetings || []).length, 0);
    if (recurringPatterns > 1) return true;
    const nonLectureKinds = (option.occurrences || []).some(occurrence =>
        /lab|laboratory|discussion|recitation|seminar|test|exam/i.test(String(occurrence.kind || ""))
    );
    return nonLectureKinds && components.some(component => /^(lec|lecture)\b/i.test(normalizeSpace(component.section)));
}

function rankingSignalForOutput(option, gradeSummaries, rmpByCourse, coursePreferences) {
    const preferences = coursePreferences[option.courseCode] || { professorPriority: 3, delivery: "either", professors: {} };
    const signal = professorRankingPartForOption(
        option,
        gradeSummaries[option.courseCode],
        rmpByCourse[option.courseCode] || {},
        preferences
    );
    return {
        source: signal.source,
        score: Number.isFinite(signal.score) ? Number(signal.score.toFixed(1)) : null,
        rmpRating: signal.rmp && Number.isFinite(Number(signal.rmp.avgRating)) ? Number(signal.rmp.avgRating) : null,
        rmpRatings: signal.rmp ? Math.max(0, Number(signal.rmp.numRatings || 0)) : 0,
        rmpDifficulty: signal.rmp && Number.isFinite(Number(signal.rmp.avgDifficulty)) ? Number(signal.rmp.avgDifficulty) : null,
        rmpWouldTakeAgain: signal.rmp && Number.isFinite(Number(signal.rmp.wouldTakeAgainPercent)) ? Number(signal.rmp.wouldTakeAgainPercent) : null
    };
}

function serializeSchedule(schedule, gradeSummaries, rmpByCourse, score, coursePreferences = {}) {
    const courses = schedule.map(option => {
        const grade = professorGradeForOption(option, gradeSummaries[option.courseCode]);
        const preferences = coursePreferences[option.courseCode] || { professorPriority: 3, delivery: "either", professors: {} };
        return {
            ...option,
            credits: courseCredits(option),
            preferences,
            professor: professorForOption(option),
            professorPreference: professorPreferenceForOption(option, preferences).preferred ? "prefer" : "neutral",
            linkedBundle: optionHasLinkedBundle(option),
            rankingSignal: rankingSignalForOutput(option, gradeSummaries, rmpByCourse, coursePreferences),
            grade: grade ? {
                gpa: grade.gpa,
                adjustedGpa: grade.adjustedGpa,
                aRate: grade.aRate,
                dfwRate: grade.dfwRate,
                students: grade.students,
                trend: grade.trend,
                predictedGpa: grade.predictedGpa,
                predictionLow: grade.predictionLow,
                predictionHigh: grade.predictionHigh,
                predictionConfidence: grade.predictionConfidence,
                regressionTerms: grade.regressionTerms,
                terms: grade.terms
            } : null
        };
    }).sort((a, b) => a.courseCode.localeCompare(b.courseCode));

    const totalCredits = courses.reduce((sum, course) => sum + (Number.isFinite(course.credits) ? course.credits : 0), 0);
    return {
        id: courses.map(c => `${c.courseCode}:${c.optionKey}`).join("|"),
        score: Number(score.totalScore.toFixed(1)),
        gradeScore: Number(score.gradeScore.toFixed(1)),
        professorScoreAvailable: Boolean(score.professorScoreAvailable),
        professorDataCourses: Number(score.professorDataCourses || 0),
        convenienceScore: Number(score.convenienceScore.toFixed(1)),
        daysOnCampus: score.stats.daysOnCampus,
        maxGap: score.stats.maxGap,
        averageGap: score.stats.averageGap,
        earliest: score.stats.earliest,
        latest: score.stats.latest,
        totalCredits: Number(totalCredits.toFixed(2)),
        courses
    };
}

function normalizeProfessorPreferenceMap(value) {
    const out = {};
    if (!value || typeof value !== "object") return out;
    for (const [key, state] of Object.entries(value)) {
        if (!["prefer", "avoid"].includes(String(state))) continue;
        const normalized = instructorKey(key);
        if (normalized) out[normalized] = String(state);
    }
    return out;
}

function serializeOption(option, gradeSummaries, rmpByCourse, coursePreferences = {}) {
    const grade = professorGradeForOption(option, gradeSummaries[option.courseCode]);
    const preferences = coursePreferences[option.courseCode] || { professorPriority: 3, delivery: "either", professors: {} };
    return {
        ...option,
        credits: courseCredits(option),
        preferences,
        professor: professorForOption(option),
        professorPreference: professorPreferenceForOption(option, preferences).preferred ? "prefer" : "neutral",
        linkedBundle: optionHasLinkedBundle(option),
        rankingSignal: rankingSignalForOutput(option, gradeSummaries, rmpByCourse, coursePreferences),
        grade: grade ? {
            gpa: grade.gpa,
            adjustedGpa: grade.adjustedGpa,
            aRate: grade.aRate,
            dfwRate: grade.dfwRate,
            students: grade.students,
            trend: grade.trend,
            predictedGpa: grade.predictedGpa,
            predictionLow: grade.predictionLow,
            predictionHigh: grade.predictionHigh,
            predictionConfidence: grade.predictionConfidence,
            regressionTerms: grade.regressionTerms,
            terms: grade.terms
        } : null
    };
}

function compactSchedule(schedule, score) {
    const sorted = [...schedule].sort((a, b) => a.courseCode.localeCompare(b.courseCode));
    const totalCredits = sorted.reduce((sum, option) => {
        const credits = courseCredits(option);
        return sum + (Number.isFinite(credits) ? credits : 0);
    }, 0);
    return {
        id: sorted.map(c => `${c.courseCode}:${c.optionKey}`).join("|"),
        score: Number(score.totalScore.toFixed(1)),
        gradeScore: Number(score.gradeScore.toFixed(1)),
        professorScoreAvailable: Boolean(score.professorScoreAvailable),
        professorDataCourses: Number(score.professorDataCourses || 0),
        convenienceScore: Number(score.convenienceScore.toFixed(1)),
        daysOnCampus: score.stats.daysOnCampus,
        maxGap: score.stats.maxGap,
        averageGap: score.stats.averageGap,
        earliest: score.stats.earliest,
        latest: score.stats.latest,
        totalCredits: Number(totalCredits.toFixed(2)),
        courseRefs: sorted.map(option => ({ courseCode: option.courseCode, optionKey: option.optionKey }))
    };
}

function analyzeSchedules(courseRecords, prefs = {}, options = {}) {
    const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
    const compact = Boolean(options.compact);
    const requestedMaxSchedules = Number(options.maxSchedules ?? 100000);
    const requestedTopLimit = Number(options.topLimit ?? (compact ? 250 : 500));
    // Treat analysis options as untrusted input. A NaN maxSchedules used to disable
    // the safety cap entirely because every comparison against NaN is false. Keep the
    // normal 100k ceiling/default and bound explicit overrides to a sane local limit.
    const maxSchedules = Number.isFinite(requestedMaxSchedules)
        ? Math.max(1000, Math.min(1000000, Math.floor(requestedMaxSchedules)))
        : 100000;
    const topLimit = Number.isFinite(requestedTopLimit)
        ? Math.max(25, Math.min(5000, Math.floor(requestedTopLimit)))
        : (compact ? 250 : 500);
    const readyCourses = courseRecords.filter(c => Array.isArray(c.options) && c.options.length);
    if (!readyCourses.length) {
        onProgress({ percent: 100, stage: "complete", message: "No ready courses to analyze.", processed: 0 });
        return { totalBase: 0, totalMatching: 0, schedules: [], counts: {}, truncated: false, compact };
    }

    const boundedNumberOrNull = (value, min, max) => {
        if (value === null || value === undefined || value === "") return null;
        const number = Number(value);
        return Number.isFinite(number) && number >= min && number <= max ? number : null;
    };
    const dayPreference = String(prefs.dayPreference || "none").toLowerCase();
    const gradeWeightInput = Number(prefs.gradeWeight);
    const normalizedPrefs = {
        earliestStart: boundedNumberOrNull(prefs.earliestStart, 0, 1440),
        latestEnd: boundedNumberOrNull(prefs.latestEnd, 0, 1440),
        maxGap: boundedNumberOrNull(prefs.maxGap, 0, 1440),
        noFriday: Boolean(prefs.noFriday),
        allowFull: prefs.allowFull !== false,
        allowWaitlist: prefs.allowWaitlist !== false,
        allowOnline: prefs.allowOnline !== false,
        honorsMode: ["either", "only", "exclude"].includes(String(prefs.honorsMode || "either").toLowerCase()) ? String(prefs.honorsMode || "either").toLowerCase() : "either",
        dayPreference: ["none", "mwf", "tr", "few-days", "compact"].includes(dayPreference) ? dayPreference : "none",
        gradeWeight: Number.isFinite(gradeWeightInput) ? Math.max(0, Math.min(100, gradeWeightInput)) : 50
    };

    const coursePreferences = {};
    for (const course of readyCourses) {
        const priority = Number(course.preferences?.professorPriority ?? 3);
        const delivery = ["either", "in-person", "online"].includes(String(course.preferences?.delivery || "either"))
            ? String(course.preferences?.delivery || "either")
            : "either";
        coursePreferences[course.courseCode] = {
            professorPriority: Math.max(1, Math.min(5, Number.isFinite(priority) ? priority : 3)),
            delivery,
            professors: normalizeProfessorPreferenceMap(course.preferences?.professors || {})
        };
    }

    const usable = buildUsableCourses(readyCourses, normalizedPrefs, coursePreferences);
    const impossibleCourse = usable.find(course => !course.options.length)?.courseCode || "";
    if (impossibleCourse) {
        onProgress({ percent: 100, stage: "complete", message: `${impossibleCourse} has no usable sections.`, processed: 0 });
        return { totalBase: 0, totalMatching: 0, schedules: [], counts: {}, truncated: false, impossibleCourse, compact, gradeSummaries: {}, coursePreferences };
    }

    const gradeSummaries = {};
    const rmpByCourse = {};
    for (const course of readyCourses) {
        gradeSummaries[course.courseCode] = buildGradeSummary(course.gradeHistory || {}, course.term || "");
        rmpByCourse[course.courseCode] = course.rmpByProfessor && typeof course.rmpByProfessor === "object"
            ? course.rmpByProfessor
            : {};
    }

    // Normalize timetable geometry once. The previous implementation repeatedly
    // rebuilt dated/recurring meeting arrays for every candidate pair and every
    // completed schedule. A small conflict graph turns those hot loops into Set lookups.
    const meetingProfiles = new WeakMap();
    const optionIds = new WeakMap();
    let optionId = 0;
    for (const course of usable) {
        for (const option of course.options) {
            meetingProfiles.set(option, buildMeetingProfile(option));
            optionIds.set(option, ++optionId);
        }
    }
    const conflictPairs = new Set();
    const pairKey = (a, b) => {
        const x = optionIds.get(a), y = optionIds.get(b);
        return x < y ? `${x}:${y}` : `${y}:${x}`;
    };
    let pairTotal = 0;
    for (let i = 0; i < usable.length; i++) for (let j = i + 1; j < usable.length; j++) pairTotal += usable[i].options.length * usable[j].options.length;
    let pairDone = 0;
    for (let i = 0; i < usable.length; i++) {
        for (let j = i + 1; j < usable.length; j++) {
            for (const a of usable[i].options) {
                const ap = meetingProfiles.get(a);
                for (const b of usable[j].options) {
                    if (meetingProfilesConflict(ap, meetingProfiles.get(b))) conflictPairs.add(pairKey(a, b));
                    pairDone++;
                }
            }
        }
    }
    onProgress({ percent: 12, stage: "prepare", message: `Indexed ${optionId} timetable options and ${pairTotal.toLocaleString()} compatibility pairs.`, processed: 0 });

    const optionGradeParts = new WeakMap();
    for (const course of usable) {
        const coursePreference = coursePreferences[course.courseCode] || {};
        const requestedPriority = Number(coursePreference.professorPriority ?? 3);
        const weight = Math.max(1, Math.min(5, Number.isFinite(requestedPriority) ? requestedPriority : 3));
        for (const option of course.options) {
            const part = professorRankingPartForOption(
                option,
                gradeSummaries[option.courseCode],
                rmpByCourse[option.courseCode] || {},
                coursePreference
            );
            optionGradeParts.set(option, { score: part.score, weight, source: part.source });
        }
    }

    const earliestThresholds = [];
    for (let m = 7 * 60; m <= 12 * 60; m += 30) earliestThresholds.push(m);
    const latestThresholds = [];
    for (let m = 14 * 60; m <= 22 * 60; m += 30) latestThresholds.push(m);
    const gapThresholds = [30, 60, 90, 120, 180];
    const earliestOptions = [null, ...earliestThresholds];
    const latestOptions = [null, ...latestThresholds];
    const gapOptions = [null, ...gapThresholds];

    // A compact histogram of schedule statistics powers live, exact pre-update
    // availability counts in the browser without another TTU request or worker run.
    const constraintBuckets = new Map();
    const earliestPassCount = value => !Number.isFinite(value)
        ? earliestThresholds.length
        : earliestThresholds.filter(threshold => value >= threshold).length;
    const minPassingIndex = (value, thresholds) => {
        if (!Number.isFinite(value)) return 0;
        const index = thresholds.findIndex(threshold => value <= threshold);
        return index < 0 ? thresholds.length : index;
    };

    const theoretical = usable.reduce((product, course) => Math.min(maxSchedules, product * Math.max(1, course.options.length)), 1);
    onProgress({ percent: 8, stage: "prepare", message: `Indexed ${usable.length} cached courses.`, processed: 0, theoretical });

    let totalBase = 0;
    let totalMatching = 0;
    const professorAvailability = {};
    let sequence = 0;
    let truncated = false;
    const topHeap = [];
    const chosen = [];
    let lastProgressAt = 0;

    const reportSearchProgress = () => {
        const now = Date.now();
        if (now - lastProgressAt < 90) return;
        lastProgressAt = now;
        const ratio = theoretical > 0 ? Math.min(1, totalBase / theoretical) : 0;
        // Conflict pruning means theoretical combinations are only an upper bound.
        // Keep the bar moving but reserve the final third for finishing/ranking.
        const percent = Math.min(68, 12 + Math.round(ratio * 56));
        onProgress({ percent, stage: "conflicts", message: `Checked ${totalBase.toLocaleString()} conflict-free combinations…`, processed: totalBase, theoretical });
    };

    function processSchedule(schedule) {
        totalBase++;
        const stats = dailyStats(schedule, meetingProfiles);

        const bucketKey = [
            earliestPassCount(stats.earliest),
            minPassingIndex(stats.latest, latestThresholds),
            minPassingIndex(stats.maxGap, gapThresholds),
            stats.byDay.has("F") ? 1 : 0
        ].join(":");
        constraintBuckets.set(bucketKey, (constraintBuckets.get(bucketKey) || 0) + 1);

        if (schedulePassesStats(stats, normalizedPrefs)) {
            totalMatching++;
            // Count professor availability across every matching combination, not only
            // the top-ranked schedules retained for transport. This lets the browser
            // accurately dim a professor only when no compatible schedule can use them.
            for (const option of schedule) {
                if (!professorAvailability[option.courseCode]) professorAvailability[option.courseCode] = {};
                const seenProfessorKeys = new Set();
                for (const name of orderedInstructorNames(option)) {
                    const key = instructorKey(name);
                    if (!key || seenProfessorKeys.has(key)) continue;
                    seenProfessorKeys.add(key);
                    professorAvailability[option.courseCode][key] = (professorAvailability[option.courseCode][key] || 0) + 1;
                }
            }
            const score = scoreSchedule(schedule, gradeSummaries, normalizedPrefs, coursePreferences, rmpByCourse, stats, optionGradeParts);
            heapPushTop(topHeap, { schedule: [...schedule], score, sequence: sequence++ }, topLimit);
        }
        reportSearchProgress();
    }

    function walk(index) {
        if (totalBase >= maxSchedules) { truncated = true; return; }
        if (index >= usable.length) { processSchedule(chosen); return; }
        const course = usable[index];
        for (const option of course.options) {
            let conflict = false;
            for (const existing of chosen) {
                if (conflictPairs.has(pairKey(existing, option))) { conflict = true; break; }
            }
            if (conflict) continue;
            chosen.push(option);
            walk(index + 1);
            chosen.pop();
            if (truncated) return;
        }
    }

    walk(0);

    const bucketRows = [...constraintBuckets.entries()].map(([key, count]) => {
        const [earliestPass, latestMin, gapMin, friday] = key.split(":").map(Number);
        return { earliestPass, latestMin, gapMin, friday: Boolean(friday), count };
    });
    const constraintCounts = [];
    for (let ei = 0; ei < earliestOptions.length; ei++) {
        for (let li = 0; li < latestOptions.length; li++) {
            for (let gi = 0; gi < gapOptions.length; gi++) {
                for (let fi = 0; fi < 2; fi++) {
                    let count = 0;
                    const earliestThresholdIndex = ei - 1;
                    const latestThresholdIndex = li - 1;
                    const gapThresholdIndex = gi - 1;
                    for (const bucket of bucketRows) {
                        if (ei > 0 && earliestThresholdIndex >= bucket.earliestPass) continue;
                        if (li > 0 && latestThresholdIndex < bucket.latestMin) continue;
                        if (gi > 0 && gapThresholdIndex < bucket.gapMin) continue;
                        if (fi === 1 && bucket.friday) continue;
                        count += bucket.count;
                    }
                    constraintCounts.push(count);
                }
            }
        }
    }
    const constraintGrid = {
        earliest: earliestOptions,
        latest: latestOptions,
        maxGap: gapOptions,
        noFriday: [false, true],
        counts: constraintCounts,
        complete: !truncated
    };

    const gridCount = (earliest, latest, maxGap, noFriday) => {
        const ei = earliestOptions.findIndex(value => value === earliest);
        const li = latestOptions.findIndex(value => value === latest);
        const gi = gapOptions.findIndex(value => value === maxGap);
        const fi = noFriday ? 1 : 0;
        if (ei < 0 || li < 0 || gi < 0) return 0;
        const index = (((ei * latestOptions.length) + li) * gapOptions.length + gi) * 2 + fi;
        return constraintCounts[index] || 0;
    };
    const earliestCounts = earliestOptions.map(value => ({ value, count: gridCount(value, normalizedPrefs.latestEnd ?? null, normalizedPrefs.maxGap ?? null, normalizedPrefs.noFriday) }));
    const latestCounts = latestOptions.map(value => ({ value, count: gridCount(normalizedPrefs.earliestStart ?? null, value, normalizedPrefs.maxGap ?? null, normalizedPrefs.noFriday) }));
    const gapCounts = gapOptions.map(value => ({ value, count: gridCount(normalizedPrefs.earliestStart ?? null, normalizedPrefs.latestEnd ?? null, value, normalizedPrefs.noFriday) }));
    const fridayCounts = [false, true].map(value => ({ value, count: gridCount(normalizedPrefs.earliestStart ?? null, normalizedPrefs.latestEnd ?? null, normalizedPrefs.maxGap ?? null, value) }));

    onProgress({ percent: 74, stage: "filters", message: `Found ${totalMatching.toLocaleString()} schedules matching the current filters.`, processed: totalBase, theoretical });

    const scored = topHeap.sort((a, b) => b.score.totalScore - a.score.totalScore || a.sequence - b.sequence);
    onProgress({ percent: 86, stage: "ranking", message: `Ranking the best ${scored.length.toLocaleString()} schedules…`, processed: totalBase, theoretical });

    let schedules;
    let optionCatalog;
    if (compact) {
        optionCatalog = {};
        const used = new Map();
        for (const { schedule } of scored) {
            for (const option of schedule) {
                const key = `${option.courseCode}::${option.optionKey}`;
                if (!used.has(key)) used.set(key, option);
            }
        }
        for (const option of used.values()) {
            if (!optionCatalog[option.courseCode]) optionCatalog[option.courseCode] = {};
            optionCatalog[option.courseCode][option.optionKey] = serializeOption(option, gradeSummaries, rmpByCourse, coursePreferences);
        }
        schedules = scored.map(({ schedule, score }) => compactSchedule(schedule, score));
    } else {
        schedules = scored.map(({ schedule, score }) => serializeSchedule(schedule, gradeSummaries, rmpByCourse, score, coursePreferences));
    }

    const result = {
        totalBase,
        totalMatching,
        truncated,
        impossibleCourse,
        counts: {
            earliest: earliestCounts,
            latest: latestCounts,
            maxGap: gapCounts,
            noFriday: fridayCounts
        },
        constraintGrid,
        professorAvailability,
        schedules,
        gradeSummaries,
        coursePreferences,
        compact,
        activeCourseCodes: readyCourses.map(course => course.courseCode).sort()
    };
    if (compact) result.optionCatalog = optionCatalog;
    onProgress({ percent: 100, stage: "complete", message: `Ready — ${totalMatching.toLocaleString()} schedules match the current filters.`, processed: totalBase, theoretical });
    return result;
}

module.exports = {
    normalizeCourseCode,
    parseCourseList,
    instructorKey,
    timeToMinutes,
    minutesToTime,
    termValue,
    buildGradeSummary,
    forecastProfessorGpa,
    analyzeSchedules,
    optionsConflict,
    optionAllowed,
    optionIsHonors,
    optionDeliveryMode,
    primaryOptionComponents,
    professorForOption,
    professorGradeForOption,
    professorRmpForOption,
    rmpFallbackScore
};
