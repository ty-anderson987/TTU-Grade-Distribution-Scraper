# Changelog


## 3.1.1 — Pinned-course preference safety + isolated VSB sessions

- Prompt before a course-specific preference change unlocks an already pinned timetable option.
- Delivery, Professor priority, and professor Prefer/Neutral/Avoid changes now invalidate only the affected course pin after approval, preventing stale locks from blocking the calendar.
- Canceling the prompt keeps both the existing pin and current setting unchanged.
- If a preference save fails, restore the previous pin.
- Show a short green notice after an approved unlock so the user understands why the calendar may change.
- Fix VSB worker isolation by stripping every cookie applicable to `schedulebuilder.ttu.edu` from cloned worker storage state, including parent-domain `.ttu.edu` cookies, while preserving reusable SSO state on other TTU/identity-provider hosts.
- Give every VSB session a generated `ttu_grade_vsb_worker` UUID marker and log a short server-cookie fingerprint so accidental backend-session reuse is visible without exposing TTU cookie values.
- Keep the five-session VSB ceiling but use only currently healthy/available sessions; fast timetable prefetch continues to outrank background deep verification.
- Preserve successful parallel deep-scan ranges when a worker fails and retry only the missing range on a healthy/primary session before considering a full primary fallback.
- Add regression coverage for parent-domain cookie stripping/fresh worker storage state and explicit two-job Cognos overlap.
- Live verification confirmed distinct VSB cookie fingerprints, concurrent PHYS 2401/PHYS 1408 deep-scan lanes, targeted missing-range repair, and simultaneous two-worker Cognos history retrieval.
- Add explicit VSB worker lifecycle states: isolated sessions return `READY` after completed/yielded jobs, are readiness-checked before reuse, and are retired/closed if TTU inactivity returns them to authentication.
- Treat worker startup failures as disposable sessions. A timed-out/failed Chromium context is closed and the pool requests a fresh isolated VSB session with a new worker ID instead of globally disabling parallelism for a minute.
- Make background deep verification resumable across foreground priority interruptions: finish the current result, checkpoint completed VSB result indexes, yield workers to new-course fast scans, then repartition only the unfinished indexes when the fast queue drains.
- Avoid the observed PHYS-style restart from result 1 after a priority interruption; saved deep-scan results now survive pause/resume cycles until final full-index/option-key validation succeeds.
- Harden the transient VSB welcome screen by invoking its Continue action through page JavaScript when Playwright actionability changes between state detection and click.
- Require every newly bootstrapped isolated VSB worker to clear all active pre-existing/enrolled course rows before it reports `READY`; the cleanup is count-agnostic and explicitly regression-tested with both five- and seven-course enrolled schedules.
- Fix professor availability cards not repainting after analysis completion: the completed availability result is now allowed to render before the outer `analysisRunning` flag clears, so professors with zero compatible schedules are dimmed/labeled unavailable again.

## 3.1.0 — Click-to-pin cards, aligned result layout, and fast-timetable priority

- Make the non-interactive area of every recommended schedule course card clickable to pin/unpin that exact timetable option using the same pin state and filtering logic as calendar blocks.
- Protect Profile, RMP, Compare, and other interactive controls from accidental card pinning.
- Rework recommended-card headers so professor names use a consistent reserved title area and Profile/RMP/Compare actions stay aligned across cards; mobile layouts expand naturally.
- Replace warning-colored cached re-ranking notices with informational/green states that distinguish local recalculation from missing course data.
- Clarify subset previews as intentional calendar selections: unchecked courses remain loaded/cached and can be restored instantly.
- Decouple VSB fast timetable prefetch from Cognos grade-history timing. Courses added while Cognos is busy can fast-load immediately through the VSB pool instead of waiting behind the current grade-history job.
- Allow ranked calendar generation as soon as every checked course has a fast VSB timetable; TTU grade history can finish afterward and automatically trigger a richer re-rank.
- Immediately retry isolated-worker exact-course prefetch misses on the primary VSB before letting the normal course queue handle them.
- Preserve the existing 2-worker Cognos ceiling, adaptive 1–5 VSB deep-verification ceiling, in-place enrolled-course reset, exact-course validation, missing-range repair, and RMP/TTU ranking precedence.
- Update package/UI/RMP-client metadata and documentation to 3.1.0.

## 3.0.17 — Unrated RMP + verified scan-status continuity

- Treat RMP profiles with zero student ratings as unrated data rather than `0.0/5`.
- Normalize unrated RMP rating/difficulty/take-again fields to unavailable values and invalidate the old RMP cache format so stale `0/5` placeholders are refreshed.
- Display `—` for unrated RMP Rating, Difficulty, Take Again, and Ratings in Schedule Analyzer, standalone Grade Analytics, Professor Details, and Professor Comparison.
- Keep unrated/invalid RMP profiles completely out of professor ranking. Ranking still uses TTU grade history first, RMP only as a fallback when real ratings exist, and schedule convenience when neither source exists.
- Carry a completed full-semester VSB state into the schedule-analysis progress panel so the post-verification calendar refresh stays green and visibly confirmed instead of reverting to a generic warning-colored refresh.
- Update package/UI/RMP-client version metadata to 3.0.17 and add release-level regression checks for these behaviors.
- No changes to Cognos scraping, VSB enrolled-course clearing, exact-course matching, timetable extraction, or 1–5 VSB worker orchestration.

## 3.0.16 — Recommended-schedule action layout

- Replace the unlabeled professor arrow on recommended schedule cards with **Profile ↗**.
- Keep **Profile ↗** and **RMP ↗** together on the top row for every card.
- Keep **Compare** on a dedicated lower row only when same-time professor/section alternatives exist.
- UI-only change; TTU scraping, caching, ranking, and concurrency are unchanged.

## 3.0.15 — Dropdown interaction stability

- Prevent background verification polling from replacing course-setting `<select>` elements while they are open/focused.
- Keep selected values optimistic during the save so a blur cannot momentarily revert the dropdown before the server response arrives.
- Flush any deferred course-row render immediately after the interaction/save completes.
- No VSB reset, course discovery, timetable parsing, Cognos, or worker-concurrency logic changes from V3.0.14.


## 3.0.14 — VSB enrolled-course reset + UI spacing

- Fixed Schedule Builder startup clearing for **currently enrolled courses**. Enrolled rows are now cleared through VSB's own `Plan to drop` planning state when available instead of requiring a trash icon that enrolled rows may not expose.
- Restored Schedule Builder image resources because some VSB remove controls are image-backed; fonts/media remain blocked.
- Added semantic remove-control fallback plus the native course include checkbox as a last-resort non-constraining fallback.
- Active-course verification now respects VSB's include checkbox, so ignored rows cannot falsely fail exact-course isolation.
- Course clearing still stays in the existing authenticated page: **no refresh and no blanket clear URL**.
- Extended reset regression coverage to 0–12 starting courses, mixed enrolled/manual rows, a five-enrolled-course case matching the observed TTU layout, ignored clicks, row reordering, and a no-trash/no-drop fallback case.
- Added breathing room above/below the professor-detail Rate My Professors panel so it no longer visually collides with the TTU metric tiles.
- Restored the standalone Grade Analytics inline RMP professor-ranking cards to the actual shipped template (not only a generated preview), so Grade Analytics and Schedule Analyzer expose the same RMP context without requiring a professor-detail click.
- Standardized checkbox geometry and spacing across Grade Scraper, Schedule Analyzer, Grade Analytics, and Professor Comparison to prevent labels/RMP controls from crowding or overlapping.
- Added explicit `Rate My Professors · student feedback` and `TTU grade history` section separators to Professor Comparison for consistent source labeling.


## 3.0.12 — In-place VSB reset + source-aware professor ranking

- Fixed the false “no valid timetable options” regression by removing the `criteria.jsp?src=clear` page navigation. VSB course scans now stay on the current authenticated page and clear only the course cards actually present, one trash action at a time.
- Added a stale-no-results grace period so VSB’s old “No schedule combination(s)” DOM text cannot beat a newly generated positive result set during course changes.
- Preserved the fast-load-first workflow: full-semester verification waits until every active course that can load has its preliminary timetable.
- Professor ranking now follows an explicit source hierarchy: **TTU grade distribution first**, **RMP rating only when that professor has no usable TTU grade history**, and **schedule convenience only when neither source exists**. Prefer/Avoid remains an explicit user override.
- RMP fallback scores are sample-aware: tiny review counts are shrunk toward a neutral 3.0/5 so one or two reviews cannot dominate recommendations.
- Recommended schedule cards identify whether each professor was ranked from TTU grades, RMP fallback, explicit preference, or schedule-only data.
- Cleaned the failed-course layout so Retry is a normal responsive panel instead of an overlay covering disabled controls; courses with no timetable no longer show a misleading background-verification 0/1 card.

## 3.0.11 — Fast-load-first flow + resilient VSB repair + professor-card consistency

- Full-semester VSB verification now waits until every active course has a preliminary timetable, keeping all available VSB capacity focused on getting the calendar usable first.
- Parallel deep scans now require each worker to stabilize on the expected global VSB result count before scanning its assigned range.
- If one VSB session returns a stale/partial count or misses its range, completed ranges are retained and only the affected range is retried on a healthy session; a full primary rescan is now a last-resort integrity fallback.
- Parallel progress ignores out-of-range/mismatched worker updates so a bad session cannot appear falsely complete.
- Professor preference cards use a consistent vertical layout with structured TTU and Rate My Professors information; RMP is explicitly labeled as student feedback and remains outside the ranking score.
- The calendar no longer traps normal vertical wheel scrolling when the pointer is over it.
- Automatic grade/status refreshes preserve the current calendar schedule and week whenever the same schedule still exists after re-ranking.

## 3.0.10 — Responsive UI + RMP presentation polish

- Audited all four browser surfaces at desktop, tablet, and phone widths, including 320 px narrow layouts and 2560 px wide layouts.
- Improved mobile navigation sizing, focus-visible states, touch targets, modal sizing, dropdown containment, and text wrapping.
- Reworked professor RMP detail presentation into responsive metric tiles plus wrapped top-tag chips instead of one dense sentence.
- Improved analytics mobile density with two-column metric cards while keeping filters single-column.
- Hardened horizontally scrollable tables and the Schedule Analyzer professor history table so narrow screens do not silently clip data.
- Made professor-comparison row labels sticky during horizontal scrolling and removed unnecessary horizontal scrolling for one-professor comparisons.
- Kept the adaptive 1–5 VSB model and fixed 2-worker Cognos model unchanged.


## 3.0.9 — RMP data enrichment + two-worker standalone Cognos

- Added a local Rate My Professors client using RMP's public GraphQL endpoint, scoped to Texas Tech (school legacy ID 1011).
- Professor views can now show RMP overall rating, difficulty, would-take-again percentage, number of ratings, department, rating distribution, top tags, and course-code metadata. Exact matches deep-link directly to the professor profile; ambiguous/not-found matches keep the safe Texas Tech search link.
- RMP enrichment is asynchronous, cached for 24 hours, and never blocks TTU Schedule Builder or Cognos data. Temporary network failures are not persisted as permanent misses. Review/comment text is not mirrored.
- Added RMP summaries to Schedule Analyzer professor cards/detail/comparison views, standalone Grade Analytics professor detail, and the generated professor comparison page.
- Fixed the standalone Grade Scraper so `/api/scrape` now actually uses **two isolated Cognos pages in parallel**. V3.0.8's two-worker Cognos path was already used for Schedule Analyzer history, but the standalone multi-course scraper was still serial.
- Standalone parallel Cognos jobs preserve selected-course output order, retry a transient/empty report once on a fresh prompt, and propagate authentication expiry instead of mixing worker state.
- Added deterministic tests for standalone two-worker Cognos concurrency and RMP matching/caching.

## 3.0.8 — Five-way adaptive VSB + Rate My Professors links

- Raised the Visual Schedule Builder ceiling to **5 total sessions** (primary + up to four isolated SSO-cloned workers) while keeping Cognos fixed at **2 workers**.
- Deep timetable verification now scales adaptively: <8 results uses 1 VSB, 8–23 uses 2, 24–59 uses 3, 60–99 uses 4, and 100+ uses 5.
- Five-way verification divides VSB results into near-equal disjoint ranges. For PHYS 1408 with 107 results the split is 1→22, 23→44, 45→65, 66→86, and 107→87. Strict total-count, option-key, and result-index coverage checks remain mandatory before merged data is accepted.
- Fast multi-course prefetch can use all five VSB sessions when enough uncached courses are queued; workers are still created lazily and parallel-worker failures fall back to the primary path.
- Added rate-limited PowerShell/server-log summaries during parallel deep verification, showing each worker lane and combined progress at roughly 10% intervals.
- Added one-click **Rate My Professors** links throughout Schedule Analyzer professor preference rows, comparison/detail views, and selected schedule cards. Links search within Texas Tech University's Rate My Professors school page.

## 3.0.7 — Reliability, correctness, and hardening audit

- Hardened parallel deep-verification merging so duplicate VSB result pages cannot fake complete coverage. Range scans now report every visited result index and the server requires complete index coverage before accepting merged timetable data.
- Improved deep-scan traversal and progress reporting across all active VSB sessions, including forward/backward range scanning and worker-specific progress aggregation.
- Fixed a schedule-engine gap/end-time bug for nested or overlapping meetings and tightened clock-value validation.
- Hardened Cognos history collection against partially populated course dropdowns, early-rendered empty report tables, transient missing results, and stale negative cache entries. Suspicious empty/missing terms require a fresh matching retry before they can be cached as unavailable.
- Added conservative normalization and bounds for schedule-analysis inputs, including a fail-safe 100,000-combination default when `maxSchedules` is malformed.
- Fixed cached-course readiness so valid grade history cannot make a course appear ready when timetable options are missing or corrupt. Missing Schedule Builder data is re-queued instead.
- Fixed analysis-worker lifecycle handling so a worker that exits without a result becomes an explicit error rather than leaving the UI stuck in a running state.
- Serialized frontend status polling to prevent slow stale responses from overwriting newer UI state.
- Hardened localhost HTTP handling with Host/Origin checks for state-changing requests, bounded request bodies, framing/resource headers, safer malformed-URL/output handling, and safer shutdown/restart behavior.
- Tightened local data/profile permissions on macOS/Linux and improved launcher PID/log handling.
- Removed one dynamic comparison-summary HTML injection path and synchronized visible version/help text with the backend.
- Expanded deterministic regression coverage for parallel range planning/merging, Schedule Builder verification, Cognos reliability, nested meetings, invalid times, and safety caps.

## 3.0.6 — Three-way VSB verification

- Raised the Schedule Builder ceiling to **3 total isolated VSB sessions** (primary + two SSO-cloned workers). Cognos remains capped at 2 workers.
- Large deep-verification jobs (24+ VSB results) now split into three disjoint ranges: worker 1 scans the first third forward, worker 2 scans the middle third forward, and worker 3 starts at the last result and scans the final third backward. For 107 PHYS 1408 results this is 1→36, 37→72, and 107→73.
- Medium deep-verification jobs (8–23 results) still use 2 sessions to avoid paying extra browser/start-position overhead on small courses. Tiny jobs remain single-session.
- Preserved strict merge guards: all workers must agree on the total result count, every preliminary option key must be recovered, and every VSB result index must be covered before parallel data is accepted. Any worker failure or incomplete merge falls back to the proven primary full scan instead of caching partial timetable data.
- Fast multi-course prefetch can now use all 3 VSB sessions when three or more uncached courses are queued.

## 3.0.5 — Parallel deep timetable verification

- Extended the conservative two-VSB design into the expensive full-semester verification phase instead of using worker 2 only for preliminary course prefetching. Small courses stay single-session; parallel deep verification starts at 8 VSB results.
- For a course with many VSB results, the primary session verifies from the beginning toward the midpoint while the isolated session starts at the final result and verifies backward toward the midpoint (for example, PHYS 1408 with 107 results becomes 1→54 and 107→55).
- Added bounded result-range and backward navigation support to the Schedule Builder scraper so each session owns a disjoint half of the same course during deep verification.
- Added strict merge validation: both halves must report the same total, cover every VSB result index, and reproduce every preliminary option key before the combined result is cached. If any check fails, the app automatically reruns the proven primary-session full scan.
- Preserved foreground preemption and login fallback behavior. Interactive course search/add/change requests still pause background verification rather than racing it.
- Kept both Cognos and Schedule Builder concurrency capped at two sessions.

## 3.0.4

- Reduced Schedule Builder parallelism to a conservative **2 total VSB sessions**: the proven primary session plus one isolated worker.
- Fixed isolated-worker startup for Playwright persistent contexts by launching the second worker in its own Chromium browser and cloning only TTU SSO state.
- The second worker intentionally receives a fresh Schedule Builder server session, preventing one worker's course reset from altering the other worker.
- Added explicit `[schedule-workers]` startup/ready logging so parallel VSB operation is easy to verify from `logs/server.log` or a live terminal.
- Kept the existing safe fallback: if the isolated session cannot reuse TTU SSO, all course loading continues through the primary VSB instead of failing.

## 3.0.3 — Parallel TTU loading + grade-history recovery

- Reworked Schedule Analyzer grade-history collection so each historical term goes directly through one Cognos prompt/report flow instead of separately reopening Cognos to discover subjects, courses, and then the report.
- Added **2-way Cognos history concurrency**. Two isolated Cognos tabs can process selected historical terms at the same time while the main authenticated Cognos tab remains untouched.
- Added a fresh-prompt retry before a term is accepted as having no grade history. Missing subject/course results and empty grade tables are checked twice; transient/timeout failures are reported as unverified instead of being cached as genuine "no history".
- Added persistent **per-course/per-term grade caching**. Expanding history from Recent 6 to Recent 12 reuses already verified terms and loads only the newly requested terms. Confirmed missing terms are cached too; failed/unverified terms are deliberately not cached as missing.
- Added opportunistic **5-session Schedule Builder prefetching**: the existing authenticated VSB session begins immediately while up to four isolated SSO-cloned VSB sessions load other queued courses in parallel. Each clone receives a fresh VSB server session to prevent one worker's course reset from changing another worker.
- Parallel VSB startup is fail-safe: if TTU will not reuse SSO in an isolated session, the optimization times out quickly and the original primary Schedule Builder path continues instead of failing the course.
- Added clearer partial-history status so a Cognos retrieval failure is no longer presented as authoritative "No grade history available."

## 3.0.2 — Professor-first reactive planning

- Reordered the planning flow so **Choose professors** comes before **Schedule constraints and preferences**, matching the way students normally decide who they want before fine-tuning time rules.
- Professor Prefer/Neutral/Avoid choices and every schedule/time preference continue to re-rank automatically after the initial course data load; the manual **Update schedules** button remains only as a fallback.
- Added live professor availability feedback from the schedule engine. A professor is dimmed and labeled **Unavailable with current constraints** when none of that professor's current-term sections can appear in any compatible schedule under the active rules.
- Availability is computed across the full analyzed combination set rather than only the top ranked schedules, so a professor is not incorrectly hidden just because their valid schedule ranked below the visible shortlist.
- Saved professor preferences are never erased by temporary time constraints; moving the time rules back automatically restores the professor as available.

## 3.0.1 — Reactive schedule updates

- Step 5 now generates automatically the moment all currently checked courses become ready; users no longer have to scroll down and press **Update schedules** just to initialize the ranked calendar and time-filter availability counts.
- Step 4 time/gap/Friday, honors/seat-status, schedule-style, and grade-weight changes now debounce and re-rank automatically from the local timetable cache/worker.
- Per-course delivery/priority and professor Prefer/Neutral/Don't take changes also trigger an automatic re-rank after the preference is saved.
- Kept **Update schedules** as a manual refresh/fallback, and added an auto-failure guard so a failed background analysis does not retry every status poll.
- Updated status/help text so the UI clearly communicates that ranked schedules and availability counts refresh automatically.

## 3.0.0 — Schedule Builder Analyzer

### Proposal-ready filter and professor analytics polish
- Reworked earliest-start, latest-end, maximum-gap, and No-Friday filtering around a local multi-dimensional availability grid. Once the underlying course/section rules are analyzed, the browser can tell the student exactly how many conflict-free schedules remain for each time choice **before** Update schedules is pressed, without another TTU request or worker run.
- Added explicit `Any start`, `Any end`, and `Any gap` choices plus clearer labels such as `10:00 AM or later` and `By 5:00 PM`, removing ambiguity about what a time filter means. Proven-zero time choices are disabled; when the combination search reaches its safety cap, counts are shown only as lower bounds and zero is not treated as definitive.
- Added a global Honors section rule: Honors or regular, Honors only, or Regular only. Honors detection follows the TTU VSB lecture convention `Lec H###`; linked lab/discussion/no-credit components stay attached to the selected lecture.
- Added immediate Honors impossibility feedback when a checked course has no qualifying honors/regular option, before a schedule analysis is started.
- Added course-specific planning-semester professor GPA forecasts using enrollment-weighted linear regression over at least three historical terms. Forecasts shrink/cap noisy trends toward adjusted GPA and expose an uncertainty range and confidence label; the UI explicitly describes them as aggregate section estimates rather than individual-student grade predictions.
- Added forecast data to professor cards, comparison tables, individual professor detail views, and ranked schedule cards.
- Expanded schedule-engine regression coverage for honors filtering, professor forecasting, exact live hard-filter counts, latest-end/No-Friday behavior, and truncated-search lower-bound semantics.

- Added Visual Schedule Builder Playwright automation with its own persistent TTU session.
- Added live term-specific Schedule Builder autocomplete with flexible course-code normalization (`ECE3303`, `ECE-3303`, `ECE 3303`).
- Added automatic Welcome → term-selection onboarding so available Schedule Builder terms are shown directly in the local UI.
- Added dynamic add/delete/retry course workflow without restarting the app.
- Added per-term local caching so deleted/re-added courses do not need to be re-scraped.
- Added user-selectable professor grade-history terms for the active plan, including summer terms and quick presets; defaults to the six most recent eligible terms.
- Polished the professor-history term selector into the same floating multi-select style used by the analytics UI, with Recent 6, Recent 12, Clear, and Apply actions; removed the All Prior preset.
- Historical-term edits are staged and applied together instead of re-scraping Cognos after every checkbox change.
- Course preference controls are disabled and visually dimmed while that course is still loading, then become stable once data is ready.
- Stopped rebuilding ready course rows every status poll, preventing native dropdowns from collapsing while the user is editing them.
- Changed schedule generation to manual **Update schedules** mode so background course/grade loading does not constantly rebuild the calendar while the user is configuring preferences.
- Changed the global schedule-vs-grade weighting slider to a centered 50/50 default with explicit Schedule convenience and Grade history endpoints.
- Added outside-click dropdown closing behavior across the Schedule Analyzer.
- Added local conflict-free schedule combination engine.
- Rebuilt schedule recomputation for interactive VSB-like course toggling: checkbox changes paint optimistically, are debounced, stale calculations are cancelled, and recently visited checked-course sets are reused from a small in-memory analysis cache.
- Moved expensive schedule ranking into a Node worker thread so the local HTTP server, status polling, dropdowns, calendar controls, and checkboxes remain responsive during large combination searches.
- Added a precomputed option compatibility graph plus cached meeting/professor score profiles, eliminating repeated parsing/conflict calculations inside the backtracking hot loop.
- Added compact ranked-schedule transport: full timetable/CRN/week data is serialized once per unique option and schedules reference that shared catalog rather than duplicating semester data hundreds of times.
- Added a real Step 5 analysis progress bar with preparation, conflict, filter, ranking, and completion stages; it remains red while work is incomplete and turns green at completion.
- Added dynamic earliest/latest/max-gap constraints with impossible choices disabled.
- Added section filters for full, waitlist, and Friday classes plus per-course Either / In person / Online delivery requirements.
- Added M/W/F, T/Th, compact-schedule, and fewer-days ranking preferences.
- Added adjustable overall grade-history weighting and per-course 1–5 professor priority.
- Added per-course progress bars for Schedule Builder option scanning and Cognos term loading.
- Added progressive timetable loading with a separate red-to-green full-semester verification bar. Fast VSB legend/section data becomes usable immediately; the lower-priority verifier starts concurrently with Cognos grade-history loading, yields to user Schedule Builder actions, and safely replaces provisional data when complete.
- Added automatic cleanup of pre-enrolled Schedule Builder course cards before isolated scans.
- Hardened course selection and result parsing to accept only exact requested course codes; removed approximate keyboard fallback.
- Removed unreliable autocomplete subtitles so prerequisite text cannot be displayed as the wrong course title.
- Bumped the local Schedule Analyzer cache schema so older approximate-match captures are ignored and rebuilt with strict exact-course validation.
- Added calendar-style ranked schedule browsing.
- Added deterministic per-course calendar colors so every meeting for the same course keeps the same color across weekdays and schedules.
- Added Schedule Builder-style course pinning: click a calendar course block to pin/unpin that exact timetable option while browsing other ranked schedules.
- Reworked professor comparison into a compact mini popup with current/historical scope selection, course-specific grade metrics, and inline Prefer / Neutral / Don't take controls.
- Added exact per-week Schedule Builder meeting capture and date-aware conflict checking for alternating/bi-weekly labs and non-weekly meetings.
- Hardened linked-section handling: lecture/lab/discussion/recitation pieces returned in one VSB timetable result remain an atomic bundle and pin together.
- Exact-date conflict checking now requires verified full-term week coverage; incomplete weekly captures fall back conservatively instead of risking a false no-conflict result.
- Added validation that weekly calendar geometry captured every visible requested-course block before exact-date mode is trusted.
- Expanded recurring-meeting parsing to handle multiple meeting patterns in the same VSB result.
- Made timetable option keys include section identity as well as CRNs/times to prevent accidental option deduplication.
- Hardened the analyze API so it refuses to rank a partial course list while any selected course is still loading or errored.
- Corrected professor hard-filter normalization and primary-instructor grade matching for linked lecture/lab bundles.
- Corrected campus-day scoring so synchronous online meetings still block time but do not count as an on-campus day.
- Added an npm regression test suite covering linked bundles, alternating labs, special meetings, professor filters, delivery rules, credits, and online scheduling.
- Added week-by-week calendar navigation with date headers and special-meeting highlighting.
- Expanded the analyzer calendar and time filters to a stable 7:00 AM–10:00 PM range while preserving fixed time-label spacing.
- Made schedule Previous/Next navigation sticky and added a jump/preview selector for large result sets.
- Added selected-schedule CRN copy control and total credit-hour summary.
- Added per-professor Prefer / Neutral / Avoid controls, including hard professor exclusions and preferred-professor ranking boosts.
- Added course-specific professor grade-history comparison popups from professor preference rows and schedule result cards.
- Rebuilt the professor comparison popup with a stable scrollable card layout, current-term availability badges, per-term history, and a professor-pool selector for current instructors, current + historical instructors, or a specific selected historical term. Historical-only professors are clearly marked and cannot be chosen as current schedule preferences.
- Changed Schedule Builder idle keep-alive to briefly type/delete a harmless course-search character when possible.
- Bumped Schedule Analyzer cache schema to 4 so old captures are rebuilt with verified full-term dated meeting data and safer option keys.
- Added low-frequency Cognos and Schedule Builder session keep-alive while the course list is idle.
- Added Schedule Builder authentication/MFA handling and preview fallback.
- Added Apache-2.0 project metadata, NOTICE attribution, and SPDX headers.
- Retained V2.8 grade analytics and professor comparison functionality.
- Hardened VSB result parsing for courses whose one timetable option contains multiple selected class rows. Lecture/lab/discussion/recitation rows are now all retained inside the same atomic option rather than only reading the first legend row.

### Required zero-credit companion sections and same-time alternatives
- Fixed VSB courses such as ENGR/CS sections where one selectable option contains a credit-bearing lecture plus a required **No Credit Dxx** companion meeting. Both rows, both CRNs, instructors, delivery modes, and meeting times are now preserved inside one atomic option.
- The recurring-time parser now prefers VSB's `hoursInLegend` meeting list, which correctly preserves separate lecture and companion-lab times when the aria label is malformed or concatenated.
- VSB radio choices labeled as same-time alternatives are now imported as separate local timetable options instead of being merged into one impossible multi-professor bundle. Each alternative keeps its own lecture + companion CRNs and professor.
- Required zero-credit companion meetings participate in conflict detection and semester-week display even though they contribute zero credit hours.
- In-person/online preference is based on the primary credit-bearing instructor section, so an in-person lecture with a required synchronous online 0-credit companion remains selectable as an in-person course.
- Professor Prefer/Avoid and grade scoring now target the primary instructor of record rather than a required zero-credit lab/discussion assistant.
- Linked-section result cards now list every component with its section, CRN, instructor, zero-credit marker, and online-meeting marker. Same-time alternatives get a direct Compare button while each ↗ icon remains strictly individual-professor analysis.
- Cache schema bumped to 6 so older merged/missing companion-section captures are rebuilt.

### Final schedule-result polish
- Professor ↗ buttons now open an individual course-specific professor analysis with term filtering, estimated curve, letter-grade donut, metrics, term history, preference controls, and a Compare Professors button.
- The professor comparison remains available as a separate compact view and links back into individual professor analysis.
- Semester week navigation now remains visible when VSB week labels were captured even if exact-date verification falls back conservatively. Added month markers to the week timeline.
- Improved VSB week-boundary detection and tolerant recurring-pattern matching to reduce false special-meeting/full-term verification warnings.
- Cache schema bumped to 5 so older week captures are rebuilt.
### Calendar parity and active-course preview polish
- Assigns each loaded course a stable unique high-contrast color; lecture, lab, discussion, exam, and zero-credit linked components always share that course color.
- Adds VSB-style course checkboxes above Ranked Schedules. Checked courses are the active local analysis set; unchecked courses stay cached and can be re-enabled instantly.
- Checking/unchecking a course recomputes schedule combinations locally without re-scraping TTU. A single checked course can be browsed through its timetable options; adding courses progressively narrows to compatible combinations.
- Shows a clear warning when checked courses cannot coexist under current filters or pinned timetable options.
- Registration copy is disabled while only a subset of courses is shown, preventing accidental copying of an incomplete CRN set.


### Adaptive timetable scanning / VSB timetable parity
- Reworked Schedule Builder collection into an adaptive fast/deep scanner. Ordinary one-pattern lecture/seminar results are read directly from VSB's authoritative accessible legend instead of clicking through every week.
- Complex results (labs, discussions, recitations, no-credit companion sections, multiple meeting patterns, explicit dated meetings, or ambiguous legend mappings) still receive full first-to-last week verification.
- Added per-course timetable-signature reuse so identical VSB time patterns are week-scanned once and reused across same-time professor/CRN alternatives without merging their registration identities.
- Result navigation now calls VSB's own `UU.caseNextResult()` when available and waits for the result index to change, with DOM-click fallback.
- Preserves raw VSB meeting lines, session start/end dates, explicit dated meetings, linked CRNs, instructors, credits, delivery type, and verification source in the cache.
- The HTML semester timeline now remains available for fast-read classes from the VSB session range and mirrors VSB more closely with Previous/Next Week, a week slider, month labels, and per-course semester bars.
- Partial/fast timetable rendering overlays explicit dated meetings on top of recurring meetings instead of hiding them.
- Cache schema bumped to 7 so pre-optimization captures are rebuilt with timetable-source/session metadata.

### Linked-component card layout polish
- Reworked linked lecture/lab/discussion/no-credit component rows so section, CRN, instructor, and meeting times wrap cleanly inside narrow result cards instead of overflowing into neighboring cards.
- Deduplicated identical recurring meeting strings in the result-card display only; the underlying timetable/occurrence data remains unchanged for conflict detection and week browsing.

### Progressive timetable verification / instant-use loading
- Split Schedule Builder loading into a fast foreground pass and a lower-priority full-semester verification pass. Students can begin sorting, filtering, comparing professors, pinning sections, and previewing schedules as soon as official section/CRN/recurring-time data is available.
- Added per-course and overall full-semester scan bars. Bars remain red while verification is pending/running and turn fully green only after the background semester scan completes.
- Background verification yields to interactive course search and new course loading, then resumes automatically.
- Simple recurring sections reuse one verified term/holiday calendar plus VSB's authoritative legend; complex lab/discussion/no-credit/exam patterns still receive full week-by-week verification.
- Provisional calendars are marked as unverified and are replaced in-place by verified timetable data without losing linked CRNs, professor identities, or special meeting information.
- Cache schema bumped to 8 so verified and provisional timetable states cannot be confused.
