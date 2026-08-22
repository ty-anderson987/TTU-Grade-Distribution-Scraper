# V3.1.1 Validation Checklist

## Automated local checks

Run:

```bash
npm test
```

The regression suite covers:

- exact course-code normalization
- atomic lecture/lab/discussion bundles
- alternate linked bundles never cross-pairing components
- alternating-week labs using verified exact dates
- conservative fallback when exact week capture is incomplete
- one-off test/discussion conflict detection
- primary lecture-instructor grade matching without falling through to lab/discussion assistants
- professor Avoid hard filtering
- in-person/online delivery filtering
- linked-course credit totals
- required zero-credit companion labs retaining their own CRNs and conflict times
- same-time professor alternatives remaining separate atomic CRN bundles
- synchronous online meetings not adding campus days


## V3.0.12 targeted regression checks

- Course reset is in-place: the scraper must not navigate to `criteria.jsp?src=clear`; it clears the actual visible active course rows individually, so the count may be 0, 1, 5, or any other current value.
- Stale `No schedule combination(s)` text must not beat a positive result set that appears while VSB is rebuilding after a course change.
- Ranking source precedence is TTU grade distribution first, then sample-aware RMP only when TTU history is unavailable, then schedule-only when neither exists.
- A professor with TTU grade history must rank from TTU data even if an RMP value is present.
- A no-data professor must not manufacture a neutral professor score; with no explicit Prefer, schedule convenience decides.
- A failed timetable course must show a contained Retry panel and must not count as a pending full-semester-verification course.

## Live TTU acceptance smoke test

Because TTU controls the live Cognos and Visual Schedule Builder pages, run these before treating a release as production-ready:

1. Authenticate to Cognos and VSB, including MFA if requested.
2. Choose a planning term and confirm pre-enrolled VSB courses are cleared from the hidden working page.
3. Search an exact normal lecture course and verify every captured CRN/instructor/time against VSB.
4. Search a course with a required lab or discussion. Verify each generated timetable option keeps the linked lecture + lab/discussion together and shows the lock marker.
5. Pin one linked course block and verify changing schedules never changes any component/CRN of that pinned bundle.
6. Test a VSB option that contains a normal lecture plus a required **No Credit Dxx** lab/discussion. Verify both CRNs appear, the 0-credit meeting appears on the calendar, and its time blocks conflicts.
7. For a VSB same-time radio choice with different professors, verify each professor/CRN pair is a separate local option and Prefer/Avoid selects the correct pair without cross-mixing CRNs.
8. Test two alternating-week labs at the same weekday/time. Verify they can coexist only when their dated weeks do not overlap.
9. Test a course with a one-off discussion/test period and verify it appears on the correct week and blocks a real conflict on that date.
10. Verify full/waitlist and online/in-person filters against the official VSB sections.
11. Verify Prefer and Don't take professor rules, including a course with multiple instructors/components.
12. Compare the final CRN copy list and total credit hours against the official VSB result before registration.

If VSB's full week range cannot be verified, V3 intentionally uses conservative recurring-time conflict logic instead of claiming an exact no-conflict result.

## Professor detail / semester timeline
- Click ↗ on a professor card. Confirm the individual professor view opens (not comparison) and shows the estimated curve, letter-grade donut, metrics, term filter, and Compare Professors button.
- Click the RMP link from a professor preference row, comparison row, professor detail view, and selected schedule card. Confirm each opens a new Rate My Professors search scoped to Texas Tech and prefilled with that professor name.
- Change the term filter and confirm metrics/charts update without leaving the popup.
- Use Compare Professors, then View ↗ on a row to return to an individual professor.
- Confirm the week timeline is visible whenever VSB supplied captured week labels, with Previous/Next week, slider, month labels, and dated weekday headers.
- For a course with lecture + lab/discussion, pin any calendar block and confirm the entire linked option remains fixed while browsing schedules.
## VSB-style active course preview
- Load at least 4 courses and verify every course has a different color swatch.
- Verify every lecture/lab/discussion/no-credit/test block belonging to the same course uses the exact same fill color.
- Click **Clear**, check only one course, and verify Previous/Next browses that course's distinct timetable choices.
- Check a second course and verify the list recomputes immediately from cached data and shows only conflict-free pairings.
- Pin a section, then check a course that cannot coexist with that pin; verify a red incompatibility warning appears and the app does not invent a schedule.
- Uncheck a course and verify its cached data is retained; recheck it and confirm Schedule Builder/Cognos are not re-scraped merely because of the checkbox.
- With a subset checked, verify **Copy CRNs** is disabled; re-enable all courses and verify the full CRN copy button returns.


## Adaptive scanner / timetable parity
- Time a normal one-pattern lecture course. Confirm its section scan no longer walks every week for every result and reports fast legend reads in the server log.
- Load a lab/discussion/no-credit bundle and confirm it still performs detailed week verification.
- Load two VSB results with the same official timetable pattern but different professor/CRN choices; confirm the detailed pattern is reused while the CRNs and professors remain separate.
- Compare the local semester timeline with VSB: week range, weekday dates, month markers, course colors, recurring meetings, no-credit meetings, and explicit special-date meetings must be retained.
- For any option showing an incomplete deep-verification notice, confirm the engine uses the safer recurring-time conflict fallback rather than claiming an exact non-conflict.

## Progressive background verification
- Add a normal lecture course and confirm timetable options become usable before the full-semester verification bar reaches 100%.
- Confirm the semester scan bar is red while pending/running and turns green only after the verified timetable replaces provisional data.
- While background verification is running, type a new course search. Confirm verification pauses/yields, autocomplete responds, and verification later resumes automatically.
- Add a course with a linked lab/discussion/no-credit companion and confirm its provisional bundle keeps every CRN together; after background verification completes, confirm the exact dated blocks still belong to that same atomic bundle.
- Confirm a verified cache reload shows a green full-semester bar immediately and does not repeat the expensive deep scan.

## Interactive performance acceptance

- With several ready courses, click Calendar course checkboxes on/off rapidly. The checkbox itself and current calendar must respond immediately; the page must not lock while combinations are recomputed.
- Confirm the Step 6 analysis bar advances while Update schedules is running and turns green at completion.
- Toggle back to a recently used checked-course combination and confirm it restores from the local analysis cache without another visible delay.
- Rapidly toggle two or more courses and confirm an older worker result never overwrites the final checkbox state.
- While analysis is running, verify professor dropdowns, page scrolling, authentication/status polling, and the current calendar remain interactive.

## Live pre-update time-filter availability
- With a completed local analysis, select `10:00 AM or later`. Confirm the live availability banner changes immediately and each earliest/latest/gap button shows its count without a TTU request.
- Choose a combination known to be impossible. Confirm the banner turns red, displays `0`, the Update schedules button changes to `No schedules — adjust filters`, and proven-zero alternative buttons are disabled before Update is pressed.
- Confirm `Any start`, `Any end`, and `Any gap` clear their respective constraints and restore the correct count.
- Confirm latest-end counts are based on meeting **end** time, not start time.
- Confirm No Friday participates in the same joint count rather than showing an independent/stale count.
- On an intentionally safety-limited analysis, confirm counts are displayed as `≥N` and a zero count is not disabled as definitive.

## Honors section filter
- Load a course containing both `Lec H###` and regular lecture sections. Confirm Honors only retains only the `Lec H###` options and Regular only excludes them.
- Confirm a required lab/discussion/`No Credit D##` remains attached to its honors lecture and does not independently change honors classification.
- Select Honors only for a checked course with zero honors options. Confirm the UI reports the course as impossible and disables Update schedules before analysis.

## Professor GPA forecast
- Use a professor/course with at least three historical terms. Confirm the professor row/detail/comparison and ranked schedule card show a bounded 0.00–4.00 planning-term forecast, confidence label, and range where appropriate.
- Confirm a professor with fewer than three usable historical terms displays no forecast rather than inventing one.
- Confirm changing the historical Cognos-term selection recomputes the forecast from only those selected prior terms.
- Confirm the UI wording calls this an aggregate section GPA estimate and never presents it as the student's predicted personal grade.

## Parallel loading / Cognos recovery

- With 6-12 uncached historical terms selected for one course, confirm the server log shows two Cognos history workers and that both make forward progress. Compare returned term/professor rows with the manual Cognos report.
- Force or reproduce a transient Cognos empty result. Confirm the term is retried on a fresh prompt before the UI says it has no history. If both attempts fail because Cognos is unavailable, confirm the course says the term could not be verified rather than claiming authoritative no-history.
- Load Recent 6, then switch to Recent 12. Confirm the six previously verified terms are reused from the per-term cache and only the newly selected terms are requested from Cognos. Switch back to Recent 6 and confirm it is immediate.
- Add at least five uncached courses in one action. Confirm the primary Schedule Builder starts immediately and, when TTU SSO permits it, up to four additional isolated VSB workers load other courses concurrently. Each ready-worker log must show its own UUID marker and server-cookie fingerprint. Distinct fingerprints across active sessions are expected; a `WARNING: duplicate server-cookie fingerprint detected` line is a failure that must be investigated. Verify every captured course/CRN against the official VSB result.
- Stress-test adaptive deep verification with representative result counts around the boundaries: 7→1 desired session, 8→2, 24→3, 60→4, and 100→5. The actual lane count may be lower when a worker cannot bootstrap or higher-priority fast timetable work needs capacity. For PHYS 1408 (107 results), confirm the available sessions receive disjoint near-equal ranges, periodic lane summaries show more than one lane advancing, and the final result reaches complete index coverage.
- Temporarily prevent isolated VSB workers from reusing SSO (or let their startup time out). Confirm the primary Schedule Builder continues loading courses and no course is marked failed solely because parallel worker creation failed.
- Verify `freshWorkerStorageState()` removes host-only `schedulebuilder.ttu.edu`, `.schedulebuilder.ttu.edu`, and parent `.ttu.edu` cookies while retaining unrelated TTU login/identity-provider state.
- Force one deep-scan worker to fail after completing part of its assigned work. Confirm completed ranges are kept, only the missing range is retried, and a complete primary rescan occurs only if targeted repair also fails.



## V3.0.9 RMP + standalone Cognos checks

1. In the standalone Grade Scraper, select at least two uncached course/term jobs and start scraping. The live log should show both `(worker 1/2)` and `(worker 2/2)` course jobs before the first pair finishes. Confirm the generated Grade Analytics rows still follow the user's selected job order.
2. Open a professor detail in Grade Analytics. The RMP summary should load asynchronously without delaying the existing Cognos metrics.
3. In Schedule Analyzer, add a course with named professors. Professor cards should first show `RMP loading…`, then show rating/difficulty/take-again/count when an exact Texas Tech match is found.
4. Open Compare professors. Confirm RMP aggregates appear independently of the Cognos GPA columns and the RMP button deep-links to the exact professor profile when matched.
5. Disconnect the machine from the internet after TTU data is cached (or otherwise make RMP unreachable). The app should retain all TTU functionality and degrade only the RMP enrichment.
6. Run `npm test`; `test-rmp-client.js` and the standalone two-worker concurrency assertion in `test-scraper-reliability.js` must pass.

## V3.0.10 responsive UI checks

- Check Grade Scraper, Schedule Analyzer, Grade Analytics, and Professor Comparison at 320/390 px phone widths, 768 px tablet width, and 1440+ px desktop widths.
- Confirm no page-level horizontal overflow. Intended data tables and multi-professor comparisons may scroll inside their own containers.
- Open an Analytics professor detail and verify RMP rating, difficulty, would-take-again, rating count, and tags wrap cleanly.
- On a narrow Schedule Analyzer professor modal, verify the term-history table scrolls horizontally instead of clipping columns.
- Compare one professor on a phone and verify no unnecessary horizontal scroll; compare 2–4 professors and verify the left metric-label column stays visible while scrolling.
## V3.0.11 targeted checks

- Verify 107-result / five-session range planning and strict per-range result-index coverage.
- Verify a worker reporting 38 results cannot be accepted for an expected 107-result deep scan.
- Verify JavaScript syntax and the full existing regression suite after targeted-repair changes.
- Render professor preference cards at narrow/mobile and desktop widths and confirm text/buttons no longer squeeze into a tiny content column.
- Hover the calendar in a scrollable page and verify a vertical mouse wheel moves the page rather than being trapped by the calendar container.
- Verify automatic analysis refresh preserves the selected schedule when its stable schedule id still exists.


## V3.0.14 targeted reset/UI checks

- 0 through 12 pre-existing VSB courses are cleared without assuming a fixed starting count.
- Five registered/enrolled courses with no trash control clear through `Plan to drop`.
- Mixed enrolled/manual rows use the correct deactivation mechanism.
- A dropped/ignored row is not treated as an active schedule constraint.
- Ignored remove clicks are retried and DOM row reordering is tolerated.
- A future VSB row with neither drop nor trash control falls back to unchecking the native include box.
- Professor-detail RMP panel has positive vertical separation from the TTU metrics at desktop/mobile widths.

### V3.0.14 final cross-app UI checks

- Standalone Grade Analytics must load RMP aggregate cards directly in professor ranking rows/cards without opening professor detail first.
- Schedule Analyzer, Grade Analytics professor detail, standalone professor rankings, and Professor Comparison must label RMP as student feedback and keep TTU grade-history data visually distinct.
- Professor Comparison must show separate RMP and TTU metric section headers.
- Checkbox controls in login/remember, multi-select filters, grade-term selection, schedule toggles, and calendar course chips must render at least 16 px with at least 7.5 px measured separation from adjacent label/swatch content.
- Responsive browser audit covers 320–2560 px widths with no page-level horizontal overflow; intentional comparison/table overflow stays inside its own scroll container.
- Calendar mouse-wheel test verifies vertical wheel motion scrolls the page while the pointer is over the calendar.


## V3.0.15 dropdown stability check

A Chromium browser regression fixture renders a ready PHYS 1408 row with background full-semester verification in progress, focuses Professor priority, advances verification progress, and asserts that the exact `<select>` DOM node remains focused and is not replaced. It then saves `5 — Highest`, blurs, flushes the deferred render, and verifies both the selected value and the newest progress remain correct. The same check is repeated for Delivery. The final build also reruns `npm test` and compares SHA-256 hashes for `schedule-scraper.js`, `scraper.js`, `schedule-engine.js`, `parallel-utils.js`, `cache-store.js`, and `analysis-worker.js` against V3.0.14.

## V3.0.16 schedule-card action-layout check

- Confirm every recommended schedule professor action is labeled **Profile ↗** rather than an unlabeled arrow.
- Confirm **Profile ↗** and **RMP ↗** are in the top action row on cards both with and without alternative professor choices.
- Confirm **Compare** appears only for same-time equivalent choices and remains on its own lower row.
- Confirm the change does not modify `schedule-scraper.js`, `scraper.js`, `schedule-engine.js`, Cognos worker limits, VSB worker limits, or cache semantics.

## V3.0.17 unrated-RMP regression checks

- Unit-test an RMP profile with `avgRating: 0`, `avgDifficulty: 0`, `numRatings: 0`, and `wouldTakeAgainPercent: 0`; normalized Rating, Difficulty, and Take Again must be unavailable while the profile link remains usable.
- Assert `rmpFallbackScore({avgRating:0,numRatings:0}) === null`.
- Assert an invalid `0/5` rating still produces no ranking score even if a malformed payload claims a positive rating count.
- Confirm Schedule Analyzer, generated Grade Analytics, and Professor Comparison all contain the same unrated-profile guard and display em dashes instead of `0.0/5`.
- Confirm a professor with TTU grade history is still ranked from TTU data regardless of RMP.
- Confirm a professor with no TTU history and no real RMP ratings falls back to schedule convenience.

## V3.0.17 verification-status continuity check

With a fixture where all selected courses transition from background verification to complete:

1. Verify the course-level/overview scan reaches green `100%`.
2. Trigger the automatic schedule re-analysis caused by verification completion.
3. Confirm the schedule-analysis progress panel uses the green complete treatment and says **Full-semester scan complete — refreshing ranked calendar from verified timetable data…** while the ranking worker runs.
4. Confirm completion text changes to **Full-semester scan complete — ranked calendar refreshed with verified timetable data.**
5. Confirm an unrelated later preference change uses normal analysis-progress semantics rather than pretending a new verification event occurred.

## Release package checks

For the final V3.1.1 archive:

- Run `npm test` from the packaged/extracted copy.
- Run `node --check` on every `.js` source file.
- Syntax-check inline JavaScript from all four HTML surfaces.
- Verify `package.json` and root `package-lock.json` both report `3.1.1`.
- Verify the UI header/title and server startup banner report V3.1.1.
- Verify the archive contains current `README.md`, `CHANGELOG.md`, `ARCHITECTURE.md`, `TESTING.md`, and `AUDIT.md`.
- Perform the normal live TTU acceptance smoke test when credentials are available; offline tests cannot prove TTU has not changed its markup.
## V3.1.0 result-card pin and layout checks

- Confirm clicking a recommended course card outside its controls pins that exact `optionKey`.
- Confirm clicking the same card again unpins it.
- Confirm Profile, RMP, Compare, inputs, and other nested interactive controls never toggle the pin.
- Confirm an online/no-fixed-time course can be pinned from its result card even when no calendar event exists.
- Confirm the card receives the same pinned visual state and schedule filtering as a calendar-event pin.
- At desktop widths with short and very long professor names, confirm the card content begins at a consistent vertical position and the action row stays aligned.
- At phone widths, confirm long names expand naturally and controls wrap without horizontal page overflow.

## V3.1.0 cached-analysis status checks

- With all checked courses fast-loaded but deep verification still running, trigger a local re-rank and confirm the subset notice is informational rather than warning-colored.
- With every checked course fully verified, trigger a local re-rank and confirm the subset notice uses the green ready treatment.
- Uncheck several loaded courses and confirm the notice says the subset is the user's calendar selection and that all courses remain loaded/cached.

## V3.1.0 fast-prefetch concurrency checks

- Start one uncached course and let Cognos begin reading its grade terms. Add several more courses while Cognos is still active. Confirm VSB workers start preliminary timetable loads without waiting for that Cognos course to finish.
- Confirm the ranked calendar becomes available when every checked course has a fast timetable even if one or more courses are still `loading-grades`; then confirm the ranking refreshes automatically when grade history finishes.
- Force an isolated worker exact-course miss and confirm the missed course receives an immediate primary-VSB fast-load repair attempt.
- Confirm a failed repair remains queued for the normal authoritative primary path rather than looping forever or being marked as a false no-course result.
- Confirm deep verification yields to newly requested fast timetable work and resumes afterward.
- Confirm the hard ceilings remain two Cognos workers and five total VSB sessions.



## V3.1.1 pinned-course preference checks

- Pin a course from either a calendar event or its result card.
- Change that course's Delivery setting and verify an unlock confirmation appears.
- Cancel and verify the original delivery value and pin remain unchanged.
- Confirm the change and verify only that course is unpinned before the calendar re-ranks.
- Repeat for Professor priority.
- Repeat for Prefer, Neutral, and Avoid from the professor cards and professor modal.
- Verify changing preferences on an unpinned course does not show the confirmation.
- Force a preference-save failure in a test fixture and verify the original pin is restored.
- Verify Profile, RMP, Compare, and unrelated course pins remain unaffected.


## V3.1.1 VSB session-isolation checks

- Run `npm test` and confirm `test-schedule-scraper.js` passes the cookie-applicability and fresh-worker-storage regression cases. Parent `.ttu.edu` cookies must be treated as applicable to `schedulebuilder.ttu.edu`.
- Start at least two VSB sessions and confirm each reports a different `ttu_grade_vsb_worker` UUID marker.
- Compare the logged server-cookie fingerprints. Distinct fingerprints are expected for independently bootstrapped VSB sessions; raw TTU cookie values must never appear in the log.
- On a course large enough for parallel deep verification, confirm at least two lane counters advance before either lane finishes. This distinguishes real overlap from serial work behind multiple browser tabs.
- Add a new course while deep verification is active. Confirm the background verifier yields/pauses, the new course receives its preliminary fast timetable first, and deep verification later resumes without discarding completed work.
- Treat five VSB sessions as a maximum capacity, not a pass condition. A run using fewer healthy lanes is valid if coverage is complete and fast timetable priority is preserved.
- For Cognos, confirm two different terms/jobs are simultaneously active as `(worker 1/2)` and `(worker 2/2)` and that completion order does not change requested output order.
