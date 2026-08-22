# V3.1.1 Audit Notes

This document records the cumulative correctness, reliability, UI, and live-acceptance findings carried into V3.1.1.

## What was reviewed

The original v3.0.7 audit covered the Node HTTP server, Cognos grade-history scraper, Visual Schedule Builder scraper, 3-session parallel verification/merge path, schedule-ranking engine and worker thread, persistent cache, launch/setup scripts, and the four browser HTML surfaces. V3.0.8 extends the same validated range/merge machinery to an adaptive 1–5 VSB ceiling. V3.0.9 adds conservative RMP aggregate enrichment and extends the proven 2-page Cognos model to the standalone Grade Scraper as well as Schedule Analyzer history.

The highest-risk areas were treated conservatively: missing Cognos data is not accepted after one suspicious empty response, partial VSB merges are rejected, and failed/incomplete parallel timetable verification preserves completed ranges and repairs only missing ranges before considering a complete primary fallback.

## Important fixes

- Cognos waits for a requested course option to actually appear or for the dropdown to settle before deciding the course is not offered.
- Cognos waits for report rows to stabilize after the report header appears and retries suspicious empty/missing terms from a fresh prompt.
- Unverified/ambiguous negative history results are not persisted as authoritative no-history cache entries.
- Parallel VSB verification records the exact result indexes visited; complete index coverage and option-key recovery are required before merged data is accepted.
- Isolated VSB workers now strip every cookie applicable to `schedulebuilder.ttu.edu`, including parent `.ttu.edu` cookies, before startup so cloned SSO state cannot silently clone the same Schedule Builder application session.
- Each VSB session exposes a generated UUID marker plus a short fingerprint of applicable server cookies for diagnostics without logging the underlying TTU cookie values.
- Schedule gaps/end-times correctly merge overlapping and nested occupied intervals.
- Malformed analysis limits/time preferences are normalized instead of disabling safety bounds or leaking invalid time values.
- Courses with cached grade data but missing timetable options are re-queued for Schedule Builder rather than marked ready.
- Analysis-worker exits without a result become explicit errors.
- Frontend status polling is serialized to avoid stale-response races.
- Localhost state-changing API calls reject cross-site requests; request bodies are bounded and local response framing/resource protections are set.
- Local cache/profile permissions and launcher restart/PID/log handling were tightened.

## Validation completed

The release passed:

- `node --check` for every JavaScript file.
- Inline JavaScript syntax validation for `index.html`, `schedule-analyzer.html`, `analytics-template.html`, and `compare-template.html`.
- Duplicate HTML ID and missing `<label for>` target checks for all four HTML surfaces.
- `npm test`, including schedule-engine, parallel utility, Schedule Builder reliability, and Cognos reliability tests.
- Bash syntax checks for `setup.sh`, `start.sh`, and `start.command`.
- Package/package-lock version consistency checks.
- A deterministic randomized comparison of the schedule engine against a brute-force conflict enumerator across 600 generated course sets.

`npm audit` could not be completed in the audit environment because the npm registry was unreachable (`EAI_AGAIN`). A live server smoke test also could not be launched in the audit environment because `node_modules/playwright` was not installed there. The source-level checks and project tests above do not require that dependency.

## Live TTU acceptance status

Texas Tech controls the authentication, Cognos, and Visual Schedule Builder pages, so offline tests cannot prove future markup stability. A live V3.1.1 run after the session-isolation hotfix did validate the highest-risk concurrency path: the primary and isolated VSB workers reported distinct server-cookie fingerprints, MATH 3350/MATH 1451 split work across two sessions, PHYS 2401 advanced on multiple disjoint ranges concurrently, and PHYS 1408 advanced on four simultaneous lanes while new-course fast loads continued to receive priority. Cognos grade-history logs also showed both `(worker 1/2)` and `(worker 2/2)` active on different terms.

Remaining release smoke tests should still include:

1. A normal small course and linked lecture/lab/no-credit bundle checked against official CRNs/times.
2. A course with 12 historical grade terms, including a sparse/missing term.
3. A clean 100+ result run when all five VSB sessions are simultaneously available; fewer lanes are valid when higher-priority fast timetable work or worker startup availability temporarily consumes capacity.
4. A forced worker failure to confirm completed VSB ranges remain cached and only the missing range is repaired.

If TTU changes its markup, the safe behavior should be failure/fallback rather than silently accepting partial data, but selectors/parsers may still need maintenance.

## V3.0.9 additions

- Standalone `/api/scrape` was inspected and found to be serial in V3.0.8 even though Schedule Analyzer history already used `HISTORY_CONCURRENCY = 2`. It now owns two independent Cognos pages and uses page-scoped prompt/report detection to avoid cross-worker report capture.
- RMP integration is isolated from TTU automation. It uses a separate HTTP client, 24-hour local cache, exact normalized-name matching, and optional course-code confirmation. RMP outages return an enrichment error only; they cannot fail schedule generation or grade scraping.
- Live RMP GraphQL requests could not be executed from the offline test container. Endpoint/field shape was cross-checked against current public RMP pages and current public documentation; the mock-backed client tests validate parsing, matching, caching, and fallback logic.

## V3.0.10 responsive-format audit

The browser UI was rendered and checked across 320, 360, 375, 390, 430, 480, 600, 768, 820, 1024, 1280, 1440, 1920, and 2560 pixel widths. The audit targeted page-level overflow, mobile card density, modal containment, RMP presentation, table usability, navigation wrapping, and professor-comparison scaling. V3.0.10 adds sticky comparison labels, mobile-safe modals and professor history scrolling, stronger touch/focus states, and a structured RMP summary.
## V3.0.11 flow/reliability audit

The live PHYS 1408 log exposed a five-session edge case: one isolated VSB session stabilized on only 38 results while the preliminary course pass had reported 107. The older merge protection correctly rejected the inconsistent data, but it then discarded all valid parallel work and restarted the complete course on the primary session. V3.0.11 makes result-count agreement a precondition for a worker range and retries only the affected range on a healthy session. It also explicitly gates deep verification until every active course has its fast timetable, preserves the visible calendar across automatic re-ranking, and removes vertical wheel trapping from the calendar container.

## V3.0.12 scan/ranking audit

A live V3.0.11 run then exposed a preliminary-scan regression: course resets used VSB's `criteria.jsp?src=clear` navigation, after which stale `No schedule combination(s)` text could be accepted before the newly added course finished generating results. V3.0.12 no longer navigates to that clear endpoint. It stays on the authenticated criteria page, removes only the course rows actually present one at a time, waits for the search control to recover, and requires a sustained no-results state before accepting a true zero-result course.

Professor ranking was also audited around source precedence. A usable TTU adjusted-GPA record always wins over RMP for that professor; RMP is consulted only when TTU grade history is unavailable; and a professor with neither source contributes no professor-quality score, leaving schedule convenience to decide. RMP fallback uses sample-aware shrinkage toward neutral so tiny review counts cannot dominate. Explicit Prefer/Avoid remains a user-controlled override.


## V3.0.14 enrolled-course reset audit

The live V3.0.13 run showed that registered Fall 2026 courses can be present as enrolled VSB rows without a usable `.cnf_trash_button`. The reset path now treats the enrollment dropdown as authoritative: if a `Plan to drop` option exists, it is selected and the course is considered inactive only after VSB confirms the row no longer participates in results. Manually added rows still use remove controls, and the include checkbox is a final functional fallback. VSB images are no longer blocked because TTU uses image-backed controls. Tests cover 0–12 starting rows plus the five-enrolled-course layout shown in the live preview.

### V3.0.14 distribution/UI consistency follow-up

A packaging mismatch was found during the final consistency pass: the V3.0.13 generated Grade Analytics preview contained the intended inline RMP professor cards, but the distributable `analytics-template.html` had not retained all of those preview changes. V3.0.14 rebuilds the shipped template from the validated preview structure and then re-runs generated-page syntax and browser rendering checks. Standalone Grade Analytics and Schedule Analyzer now both expose RMP aggregate context directly in professor-selection/ranking surfaces, while Professor Comparison separates RMP student feedback from TTU grade-history metrics.

The professor-detail RMP panel was browser-measured at a 14 px vertical gap from the TTU metric row across tested phone, tablet, desktop, and wide-screen sizes. Checkbox controls were normalized to 17 px with non-overlapping label spacing across all four interfaces. The full browser UI audit covered 320, 360, 390, 430, 480, 600, 650, 768, 820, 900, 1024, 1227, 1440, 1680, 1920, and 2560 px widths with no page-level horizontal overflow.

### V3.0.14 final validation result

Final source validation passed the complete `npm test` suite (schedule engine, parallel utilities, Schedule Builder reliability, Cognos reliability, and RMP client), the 0–12 VSB reset matrix including the exact five-enrolled-course fixture, the 1/2/5/8/12 standalone Cognos concurrency matrix, exact neighboring-course Cognos selection, and a 1,200-case randomized schedule-engine comparison against an independent brute-force enumerator. JavaScript source and inline-script syntax, duplicate IDs, label targets, shell syntax, package-version consistency, and responsive browser checks were also validated.

The browser audit passed across 320–2560 px before packaging. Because live TTU authentication is not available in the build environment, the only remaining acceptance item is the first real TTU run against the current VSB/Cognos pages. The reset path is deliberately fail-safe: it confirms that each pre-existing course stops participating before loading the requested course and asserts that exactly the requested course is active before accepting timetable results.


## V3.0.15 dropdown interaction audit

The PHYS 1408 live screenshot exposed a UI-only race: full-semester verification changes the per-course verification progress every status poll, and the course-list renderer rebuilt the entire row with `innerHTML`. Replacing a focused native `<select>` destroys its open popup, which made Professor priority and Delivery appear to close before the user could choose an option. V3.0.15 defers course-row replacement while either course-setting select is focused or while its preference save is in flight, then flushes the newest state after the interaction completes. The V3.0.14 VSB reset/course-loading path and Cognos scraping path are byte-for-byte unchanged.

## Live V3.0.14 acceptance evidence carried forward

The live Fall 2026 run confirmed the enrolled-course reset path successfully cleared five pre-existing registered courses using five **plan-to-drop** actions, then loaded requested timetable options and two-way Cognos history. A 107-option PHYS 1408 deep scan also exercised the five-session repair path: two isolated workers dropped out of exact-course initialization, completed ranges were retained, only missing ranges were retried on the primary session, and the final log reported **107 VSB results covered across up to 5 sessions**. This provides real TTU evidence for the reset/repair architecture; V3.0.15–3.0.17 intentionally leave that backend path unchanged.

## V3.0.16 schedule-result UI audit

Recommended schedule cards previously used an unlabeled arrow for professor details and could place RMP below it on cards without a Compare action, while cards with Compare produced a different visual hierarchy. V3.0.16 makes the action semantics explicit and consistent: **Profile ↗** and **RMP ↗** are always the first/top actions, and optional **Compare** occupies a separate second row. This is a presentation-only change.

## V3.0.17 unrated-RMP audit

A live RMP profile with no reviews exposed a semantic presentation bug: RMP returns numeric zero placeholders even though its own page displays **N/A** and **0 Student Ratings**. Showing `0.0/5` in the app falsely implies a real negative rating. The client now treats `numRatings === 0` as authoritative evidence that the profile is unrated and normalizes rating/difficulty/take-again values to unavailable. The RMP cache schema version was incremented so previously cached zero placeholders are not reused indefinitely.

The ranking path was separately checked. `professorRmpForOption()` already requires a successful profile, a finite rating, and a positive rating count, while `rmpFallbackScore()` rejects ratings outside 1–5 and rating counts below 1. V3.0.17 adds explicit regression assertions for zero-valued/unrated payloads, ensuring an unrated professor contributes **no RMP quality score** and therefore cannot be pushed down by a fake 0/5.

All three RMP presentation surfaces now use the same `rmpHasRatings` rule: Schedule Analyzer professor cards/details, standalone Grade Analytics ranking/details, and Professor Comparison. Unrated metrics display `—`, while the direct RMP profile link remains available.

## V3.0.17 progress-state audit

The UI could show a completed green full-semester scan in the course area and then immediately show a generic warning-colored **Updating schedules from cached timetable data…** panel near the ranked calendar. Both states were technically correct but visually contradictory. V3.0.17 tags the automatic analysis triggered specifically by final verification completion as a `verifiedRefresh`. The schedule analysis still executes independently, but its panel stays green at the verified-data level and reports whether the ranked calendar is currently refreshing or has finished refreshing from verified timetable data. The flag is cleared after that refresh, so later ordinary preference changes retain normal analysis progress semantics.

## V3.0.17 scope discipline

This release does **not** change the live-sensitive TTU automation paths: no changes to VSB enrolled-course clearing, exact-course search/isolation, timetable parsing, week-by-week verification, parallel range partitioning/repair, Cognos selectors/retries, or the two-Cognos/five-VSB ceilings. Changes are limited to RMP normalization/presentation/ranking guards, schedule-result action layout carried from V3.0.16, progress-state presentation, documentation, version metadata, and release tests.
## V3.1.0 live-log fast-load finding

The supplied V3.0.17 live log explained why adding several courses could still *look* sequential even though parallel VSB prefetch existed. ENGR 1330 entered its six-term Cognos history immediately after its preliminary VSB pass, and only after that grade-history job completed did the next queue-wide VSB prefetch start. When the additional courses were finally prefetched, CS 1412 loaded on an isolated worker while CHEM 1307 and CHEM 1107 initially missed exact matches on isolated sessions and were later recovered. The bottleneck was therefore queue orchestration, not a lack of VSB worker capacity.

V3.1.0 separates fast timetable prefetch scheduling from the foreground Cognos job. New course additions can request VSB prefetch while Cognos is busy, and isolated exact-match misses are repaired immediately on the primary VSB after the parallel batch. Schedule-analysis readiness now keys off the presence of VSB options rather than waiting for each course to reach the final grade-history `ready` state, so the calendar can appear from fast timetables while Cognos continues. When grade history arrives, the existing course fingerprint invalidation automatically re-ranks the calendar. The primary authoritative course-processing path is retained as the final fallback, so this optimization does not relax exact-course validation.

## V3.1.0 result-card UI audit

The recommended-card header previously shared horizontal space between a potentially long professor name and the action buttons. At four-column desktop widths this could force long names into many lines and move the first course-detail row substantially lower than neighboring cards. V3.1.0 gives the title full card width, reserves a consistent desktop title region, and places Profile/RMP/optional Compare in one stable action row. The fixed title region is removed on narrow layouts where cards stack vertically.

The course card itself now acts as a pin target, using the existing `toggleCoursePin()` implementation. Nested interactive controls are explicitly excluded from card click handling, and text-selection clicks are ignored. This extends the proven calendar pin model to online/no-fixed-time classes without creating a second pin state.

## V3.1.0 status-color audit

The earlier UI could use a warning-colored banner while merely recalculating schedules from already loaded cached timetable data. V3.1.0 separates data readiness from computation status: local recalculation is neutral when deep verification is still pending and green when all checked courses are fully verified. Subset text explicitly states that unchecked courses remain loaded/cached, preventing a `2 of 5` preview from being mistaken for incomplete loading.



## V3.1.1 pinned-course preference audit

A pinned option previously remained active after a user changed that course's Delivery, Professor priority, or professor preference. Because the pin is a hard course-option constraint, the old option could then make the refreshed schedule list appear empty even though the new preference itself was valid. V3.1.1 treats these course-specific changes as intentional invalidations of that course's lock. When a pin exists, the user is asked to confirm that the course can be unlocked before the change is applied. Only the affected course is unlocked. A successful change produces a temporary green notice explaining why the pin was removed; a failed save restores the original pin. This protects against both stale-lock dead ends and accidental preference clicks.


## V3.1.1 VSB session-isolation live audit

The original isolated-worker implementation launched separate Chromium contexts but copied storage state too literally. A parent-domain `.ttu.edu` cookie is valid for `schedulebuilder.ttu.edu`, so filtering only cookies whose domain string directly named Schedule Builder could preserve backend VSB plan/session state across workers. That explains the earlier failure mode where worker 1 advanced while workers 2–4 stayed at zero and then reported that the exact course could not be found.

The corrected implementation evaluates whether each cookie would actually be sent to the Schedule Builder host and removes every applicable cookie before worker startup while preserving SSO state on other TTU/identity-provider hosts. Each worker then receives its own diagnostic `ttu_grade_vsb_worker` UUID marker and a short hash of the applicable TTU VSB cookies after connection. The marker is not an authentication token and no real cookie value is printed.

A subsequent live run showed distinct fingerprints between the primary and isolated workers and genuine interleaved progress. PHYS 2401 split into disjoint ranges and multiple workers advanced simultaneously; PHYS 1408 later showed four lanes advancing concurrently across its 107 VSB results. One PHYS 2401 isolated lane eventually lost its exact-course state, but the targeted-repair path retained the completed ranges and retried only the missing range on the primary, reaching full 60-result coverage. This validates the architecture as real parallelism with fail-safe recovery rather than parallel-looking serialized work.

The same live run confirmed Cognos history concurrency: separate terms were assigned to worker 1/2 and worker 2/2 at the same time. The standalone and Schedule Analyzer Cognos paths remain capped at two independent page-scoped workers.

A later stress run exposed a scheduler/lifecycle inefficiency rather than a session-isolation failure. Isolated worker startups could time out or hit a transient VSB welcome-state race while newly added courses were consuming foreground capacity. The server would temporarily fall back to primary-only deep verification, and a later successful worker creation proved fresh sessions were still obtainable. More importantly, a PHYS 2401 deep scan that had already advanced into the result list could be interrupted by a newly added course and later restart from result 1. The current implementation fixes both cases: startup failures are disposable and retried as brand-new isolated sessions, idle workers are readiness-checked before reuse and retired if TTU logged them out, and deep scans checkpoint completed result indexes at safe result boundaries. Returning `READY` workers repartition only the remaining indexes after the higher-priority fast timetable queue drains.

### V3.1.1 worker lifecycle / availability follow-up

- Parallel VSB startup failures are disposable. Failed/timed-out contexts are closed and replacement capacity is requested with a fresh worker/session rather than leaving stale sessions in the pool.
- A parallel VSB session is not considered `READY` until all active pre-existing/enrolled courses have been cleared and a zero-active-course snapshot is confirmed. The cleanup loop is count-agnostic and covers fully enrolled five- and seven-course cases in regression tests.
- Deep verification checkpoints completed VSB result indexes before yielding to higher-priority fast timetable work, then repartitions only unfinished indexes when workers return to `READY`.
- Professor availability rendering no longer depends on the transient outer `analysisRunning` flag after a completed result has already been installed. Zero-compatible-schedule professors are again dimmed/labeled unavailable immediately after analysis completion.

