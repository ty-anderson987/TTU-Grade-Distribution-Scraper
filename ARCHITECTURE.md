# V3.1.1 Architecture

## Runtime

The application runs entirely on the user's computer:

```text
Local browser UI (127.0.0.1:3847)
        |
        v
server.js
   |---------------------------|
   v                           v
scraper.js                schedule-scraper.js
Cognos / grade history    Visual Schedule Builder
   |                           |
   |--------- local data ------|
               |
               v
        schedule-engine.js
               |
               v
       analysis-worker.js
      indexed conflict graph
               |
               v
      Ranked schedule results
```

## Authentication

Cognos and Schedule Builder use separate persistent Playwright browser profiles. Credentials and verification codes are accepted by the local UI, filled into the appropriate TTU page, and discarded. They are not written to `data/`, generated HTML, or source files.

The primary Schedule Builder browser remains persistent for normal SSO reuse. Parallel VSB workers are different: each launches in its own non-persistent Chromium context, copies reusable TTU/identity-provider SSO state, and removes every cookie that would be sent to `schedulebuilder.ttu.edu`, including parent-domain `.ttu.edu` cookies and Schedule Builder origin storage. The worker then navigates into VSB and lets TTU create a fresh application/server session. For debugging, the app adds its own non-authentication cookie `ttu_grade_vsb_worker` containing a UUID marker and logs a short SHA-256-derived fingerprint of the real applicable VSB cookies; raw TTU cookie values are never logged.

## Course lifecycle

When a course is added:

1. Normalize the course code.
2. Check the local term/course cache.
3. If uncached, use Schedule Builder to load the course and capture its unique timetable options.
4. Use Cognos to collect the exact historical terms selected by the user (six most recent eligible terms by default).
5. Save the schedule options and grade history selection to the local cache.
6. Rebuild and rank schedules locally.

When a course is deleted, only the active local course set changes. No new TTU scrape is triggered. The cached record remains available if the course is re-added.

## Schedule generation

Each captured Schedule Builder result for one requested course is treated as an atomic option. This allows linked lecture/lab components that appear together in one result to remain together.

The engine uses backtracking to choose one option per active course and rejects time conflicts as soon as they occur. It then applies hard user constraints and ranks the remaining schedules using schedule convenience plus course-specific professor grade history.

For responsiveness, schedule ranking runs in a Node `worker_threads` worker rather than on the HTTP event loop. Before backtracking, each timetable option receives one normalized meeting profile and all cross-course option conflicts are indexed once. Candidate generation therefore uses set lookups instead of reparsing semester occurrences for every pair. Professor-grade contributions are also precomputed once per option. The worker streams real progress back to the UI.

The worker returns a compact result format: each unique option (including linked CRNs, occurrences, labs/discussions, and grade metadata) is serialized once in a shared option catalog, while ranked schedules contain only lightweight option references plus score summaries. The browser hydrates those references using shared objects. This avoids multiplying full semester data by hundreds of ranked schedules.

Course checkbox changes are optimistic. Hiding a course updates the current calendar immediately; a debounced worker recomputes the exact checked-course subset from cached data in the background. Recently visited course subsets are held in a small in-memory analysis cache so switching back to a previous combination is immediate. Rapid toggles invalidate stale worker results before they can repaint the page.

During the same conflict-free enumeration, the worker records a compact histogram of schedule statistics (earliest meeting, latest meeting, maximum same-day gap, and Friday presence) and expands it into a small constraint grid. The browser uses this grid to preview the exact remaining schedule count for every selectable start/end/gap/Friday combination without recomputation. This makes time-filter buttons responsive and lets the UI reject a proven-zero combination before Update schedules. If the global combination safety limit truncates enumeration, the grid is marked incomplete and is treated only as a lower bound.

### Adaptive Schedule Builder concurrency

Schedule Builder concurrency is separate from Cognos concurrency. Cognos remains fixed at two history workers. VSB uses one authenticated primary session plus up to four isolated Chromium sessions, for a five-session ceiling. Isolated workers preserve reusable SSO state but strip all cookies/origin state applicable to Schedule Builder before first navigation, forcing a fresh VSB application/server session rather than cloning the primary worker's plan state. Session UUID markers and short server-cookie fingerprints make accidental session reuse visible in the console.

Deep verification scales by remaining result count: 1 session below 8 results, 2 for 8–23, 3 for 24–59, 4 for 60–99, and 5 for 100+. The actual lane count is the number of healthy sessions available at that moment; five is a capacity ceiling rather than a requirement. Fast timetable prefetch has higher scheduling priority than deep verification. A deep worker finishes its current VSB result, checkpoints the completed result indexes, yields, and returns to `READY`; foreground course loads then lease the next available sessions. When foreground work drains, only missing result indexes are repartitioned across the current healthy pool.

The VSB pool uses explicit `READY`, `BUSY`, `FAILED`, and `CLOSED` states. A new isolated worker is not admitted to `READY` until it has cleared every active pre-existing/enrolled VSB row and verified that zero active rows remain. This reset is count-agnostic; enrolled rows use VSB's temporary `Plan to drop` state, while manually added rows use their remove control. Each isolated worker is revalidated before reuse so TTU inactivity/logout cannot leave a stale browser silently occupying capacity. Failed startup attempts are closed by the scraper and the pool requests a newly isolated VSB session with a new monotonic worker ID. A worker that later expires or returns to authentication is retired immediately; its completed deep-scan checkpoints remain attached to the course and replacement workers resume only unfinished work. Worker creation remains serialized at the pool level so prefetch/verification requests cannot exceed the configured five-session cap.

Parallel data is accepted only when workers report the expected total result count, every preliminary option key reappears, and every VSB result index is covered. Completed checkpoint parts are merged by option key and explicit result index. Repeated pauses can create completed islands; the remaining-range planner minimizes any bridge rechecks while keeping work within the available session count. A complete primary rescan is reserved for a final integrity/merge failure, not normal priority preemption.

## Grade matching

Course abbreviations are the canonical subject key. Schedule Builder may show `MATH 1451`, while Cognos displays `Mathematics`; Cognos's underlying subject value is still `MATH`, so the abbreviation is used for cross-system matching.

Professor matching is normalized by case/punctuation. Ranking uses a strict source hierarchy: course-specific Cognos grade history first; cached RMP aggregate rating only when that professor has no usable Cognos history; and no professor-quality contribution when neither exists. RMP fallback uses a neutral 3.0/5 prior with 10 pseudo-ratings to reduce tiny-sample volatility. Per-course professor priority (1–5) weights only courses that have a professor signal (or an explicit Prefer choice).

When at least three course-specific historical terms are available, the engine computes a planning-semester aggregate GPA forecast. It uses enrollment-weighted least-squares regression on a normalized academic-term axis, shrinks and caps the slope to reduce noisy extrapolation, blends the result with the 25-student adjusted-GPA baseline, and returns a bounded 0–4 prediction with an uncertainty interval and confidence label. This value is a historical section-level estimate only and is never presented as a prediction of an individual student's grade.

Per-course delivery preferences are hard filters. Delivery is determined from the primary/instructor-of-record section: an in-person credit-bearing lecture with a required synchronous online zero-credit companion is still considered an in-person course, while the companion meeting continues to block time. Online requires an online primary option.

Global section rules also include TTU Honors filtering. An option is Honors only when its primary lecture label follows the VSB `Lec H###` convention; a linked `No Credit D##`, lab, or discussion component cannot independently change the Honors classification.

Before any Schedule Builder worker is used for course work, V3 stays on the current authenticated page and clears every active pre-existing/enrolled course row individually. Enrolled rows use VSB's own `Plan to drop` planning state; manually added rows use a remove/trash control, with the native include checkbox as a final functional fallback. The loop has no fixed course count and verifies zero active rows before the worker is considered clean. It does not navigate to a blanket clear/reset URL. Course selection then requires an exact canonical course-code match, and parsed result components are rejected if their course code does not exactly match the request.

## Cache

`data/schedule-analyzer-cache.json` is a local persistent cache and is ignored by Git. It may contain authenticated-access schedule/grade data and should not be committed publicly.

## Linked class bundles and week-aware safety

Schedule Builder is the authority for valid section pairings. V3 does not independently mix a lecture from one VSB result with a lab/discussion/recitation from another result. Every selected class row that VSB places inside one timetable result is captured as a component of the same atomic option, including its CRN, instructor, delivery mode, and section type. Pinning that option therefore pins the whole linked bundle.

Timetable capture is adaptive and progressive. The foreground pass reads VSB's authoritative accessibility Legend plus section/bundle metadata and immediately exposes a provisional calendar. The background verifier later replaces that provisional data with a full-semester verified capture. Raw legend meeting lines, CRNs, instructors, section types, credits, delivery mode, session range, and verification state are preserved.

Complex options still use deep verification: labs, discussions, recitations, no-credit companion meetings, multiple meeting patterns, explicit dated meetings, or any ambiguous/unparsed legend structure cause V3 to walk the VSB week calendar from the first available week through the last and record the dated blocks. Deep captures are cached by a timetable signature, so identical time patterns are verified once and reused across equivalent professor/CRN alternatives while each option keeps its own registration identity.

Exact-date conflict logic is enabled only when a complete first-to-last week capture is verified. If deep capture is incomplete, the engine falls back to official recurring weekday/time patterns and treats potential overlaps conservatively. Simple fast-read classes use the authoritative VSB recurring legend directly; their session range is used to build the same semester week browser in the local UI.

## Cache compatibility

Schedule Analyzer cache schema version 8 stores adaptive timetable-source metadata plus explicit provisional/full-scan state, session ranges, raw VSB legend meeting lines, timetable signatures, linked-bundle identities, and verified week coverage. Older cached timetable captures are ignored and rebuilt so stale data cannot bypass the newer no-data-loss parsing rules.

## Regression validation

`npm test` runs deterministic schedule-engine regressions for linked lecture/lab bundles, alternating-week labs, one-off test/discussion conflicts, professor hard filters, delivery filters, Honors `Lec H###` rules, credit totals, primary-instructor grade matching, synchronous-online campus-day handling, bounded professor GPA forecasting, exact hard-time availability counts, and truncated-search lower-bound behavior. These tests validate local scheduling behavior; live TTU markup/authentication still requires an authenticated smoke test because the university controls those pages.


## Rate My Professors enrichment (V3.0.9)

`rmp-client.js` is deliberately separate from both Playwright scrapers. `server.js` exposes `/api/rmp/batch`, which accepts a bounded list of professor/course pairs and resolves them with at most three concurrent public GraphQL requests. The client caches successful, not-found, and ambiguous resolutions for 24 hours in `data/rmp-cache.json`; transient request errors are not persisted. Professor name matching is exact after normalization, and `courseCodes` is used as additional disambiguation evidence when available.

The RMP data path is enrichment-only. Neither schedule analysis nor grade-history correctness depends on it, so an RMP outage degrades to the existing search link instead of changing a professor score or blocking the app.

## Standalone Cognos concurrency (V3.0.9)

The legacy Grade Analytics `/api/scrape` path uses two independent pages in the authenticated Cognos context. Schedule Analyzer grade-history retrieval uses the same two-worker model. Each page owns its term/subject/course prompt interactions and uses page-scoped report detection. Jobs are assigned from a shared queue and stored by original job index before output generation, so real overlap does not reorder exported data. Reliability tests assert that two Cognos jobs are simultaneously active rather than merely creating two tabs and processing them serially.

## Current professor-ranking source hierarchy

Professor quality is resolved per schedule option in this order:

1. **TTU Cognos grade history** — usable adjusted-GPA history is authoritative for ranking. RMP may still be shown as context but does not compete with TTU data.
2. **Rate My Professors fallback** — used only when TTU grade history is unavailable **and** the matched RMP profile has at least one real student rating with a valid 1–5 average. The raw rating is sample-shrunk toward a neutral 3.0/5 prior before scoring.
3. **Schedule convenience** — if neither TTU nor usable RMP data exists, no professor-quality score is added; time/day/gap/delivery compatibility determines the result unless the user explicitly chose Prefer/Avoid.

RMP's frontend can represent an unrated profile with numeric zero placeholders. `rmp-client.js` converts those placeholders to null/unavailable values when `numRatings === 0`. The schedule engine independently requires both a valid 1–5 rating and `numRatings > 0`, so stale or malformed zero-valued RMP data cannot lower a professor's ranking.

## Verification-to-ranking UI state

Full-semester VSB verification and schedule ranking are separate jobs. V3.0.17 links their UI state without coupling their backend execution: when the last selected course reaches `verification.status === "complete"`, the client marks the next automatic schedule analysis as a **verified refresh**. The analysis still runs normally against cached timetable data, but the progress panel remains green and communicates that the calendar is being rebuilt from fully verified timetable data. When analysis finishes, the same panel confirms the verified refresh. Later unrelated/manual re-ranking uses the normal analysis progress treatment.

## Stable TTU automation baseline

The live-working TTU automation path remains the V3.0.14 baseline plus the V3.0.15 dropdown-render guard. Enrolled VSB rows are cleared through **Plan to drop** inside the temporary planning session; manually added rows use their remove controls; exact-course isolation is checked before timetable data is accepted. Cognos remains capped at two workers. Schedule Builder remains adaptive up to five sessions with missing-range repair if an isolated worker drops out. V3.0.16–3.0.17 do not modify those backend paths.
## V3.1 fast-timetable priority

The VSB fast-load path is no longer coupled to completion of the foreground Cognos grade-history job. `requestV3SchedulePrefetch()` is a serialized opportunistic scheduler that can run while Cognos is reading another course because Cognos and VSB use independent browser automation. New course additions request another fast-prefetch pass immediately. The scheduler coalesces additions briefly, pauses/yields any background deep verification, waits for the primary VSB page to be idle, then distributes missing preliminary timetables across the primary session and available isolated workers.

Schedule analysis readiness is based on timetable availability, not Cognos completion. The analysis API accepts a checked course once it has VSB options even if its status is still `loading-grades`. That produces an immediately usable provisional calendar; when TTU professor history later changes the course fingerprint, the client invalidates the provisional ranking and automatically submits a new local analysis.

An isolated-worker exact-course miss is an optimization failure, not a course failure. The failed job is retained and receives one immediate primary-VSB preliminary retry after the parallel batch. If that repair still fails, the ordinary foreground `processV3Course()` path remains the final authoritative attempt. This prevents an isolated session from silently losing timetable data while also avoiding unnecessary delay behind unrelated Cognos terms.

## V3.1 result-card pin model

Recommended schedule cards and calendar events share the same `pinnedCourseOptions[courseCode] = optionKey` state and the same `toggleCoursePin()` function. A card click is accepted only from its non-interactive surface; nested buttons/links/forms are excluded. This gives online/no-fixed-time options a direct lock control even when they produce no calendar block.

The card header reserves a consistent title/action region on desktop so long instructor names do not move the rest of the card content. Narrow layouts remove the fixed title height and allow natural wrapping.

## V3.1 local-analysis status semantics

A schedule-analysis refresh from cached data is not treated as missing/loading TTU data. If the checked courses are fully verified, the subset/re-ranking notice uses the green ready treatment. If fast timetable data is loaded but deep verification is still running, the notice uses the neutral informational treatment. User-selected subsets explicitly say that all loaded courses remain cached.



## V3.1.1 VSB session-isolation hotfix

A live multi-worker run showed that separate Playwright contexts could still inherit the same Schedule Builder backend state when parent-domain `.ttu.edu` cookies were copied into every worker. The fix treats cookie applicability by host semantics rather than literal domain-string matching: anything the browser would send to `schedulebuilder.ttu.edu` is removed from the cloned worker storage state before VSB startup. TTU then establishes a fresh Schedule Builder session for that worker.

Live diagnostics after the fix showed distinct server-cookie fingerprints across the primary and isolated workers, simultaneous progress on disjoint PHYS 2401 ranges, and four concurrent lanes advancing on the 107-result PHYS 1408 deep scan. This confirms that the VSB pool now performs real session-isolated parallel work while preserving the existing fast-prefetch priority and targeted-repair safeguards.

## Pin invalidation for course-specific changes

A pinned timetable option is an explicit lock on one course option. Course-specific settings that can change the selected option must not leave that stale lock in place. The Schedule Analyzer therefore checks for an active pin before applying a delivery change, professor-priority change, or professor Prefer/Neutral/Avoid change. If pinned, the UI asks the user to confirm that the course may be unlocked. Approval removes only that course's pin, invalidates the local pinned-schedule view cache, and then applies the requested preference. If the server-side preference save fails, the previous pin is restored. Other courses' pins are unaffected.
