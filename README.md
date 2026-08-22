# TTU Grade Scraper 3.1.1

A local web application for scraping Texas Tech University Grade Distribution reports from IBM Cognos, viewing course/professor analytics, and building ranked schedules from Texas Tech Visual Schedule Builder data.

The application combines official TTU timetable and grade-distribution data with optional Rate My Professors aggregate information so students can compare sections and professors in one place.

> Independent student project. Not affiliated with, endorsed by, or maintained by Texas Tech University.

## Features

- Pinned course options are automatically invalidated by course-specific preference changes after a confirmation, so stale locks cannot block schedule refreshes.
- Texas Tech Grade Distribution scraping through IBM Cognos
- Two Cognos workers for grade-history retrieval
- Texas Tech Visual Schedule Builder timetable loading
- Fast timetable loading prioritized ahead of background full-semester verification
- Adaptive 1–5 VSB sessions for large full-semester scans
- Fresh per-worker VSB server sessions with UUID diagnostics and cookie-fingerprint isolation checks
- Exact course-code validation and in-place clearing of pre-existing VSB courses
- Linked lecture/lab/discussion/no-credit bundles kept together
- Conflict-free local schedule generation and ranking
- Professor Prefer / Neutral / Avoid controls
- Per-course professor priority and delivery preferences
- Calendar time, gap, Friday, honors, full/waitlist, and schedule-style constraints
- TTU grade history used as the primary professor-ranking source
- Sample-aware Rate My Professors fallback only when TTU grade history is unavailable
- Unrated RMP profiles treated as unavailable data rather than `0/5`
- Professor profiles and side-by-side professor comparisons
- Estimated GPA, adjusted GPA, DFW rate, enrollment, grade distributions, trends, and forecasts
- Click-to-pin calendar blocks and recommended course cards
- Local caching so previously loaded courses can be reused quickly
- Responsive interfaces for desktop, tablet, and mobile use

## Requirements

- **Node.js 20 or newer**
- **npm** (included with Node.js)
- Internet connection
- Texas Tech eRaider account with access to the Grade Distribution report and Schedule Builder
- Windows, macOS, or Linux

The setup script installs the required Node packages and Playwright Chromium browser automatically.

## Setup

### Windows

1. Download or clone this repository.
2. Open the project folder.
3. Run:

```text
setup.bat
```

This only needs to be done the first time.

If Windows blocks `setup.bat` after downloading the repository as a ZIP, right-click the ZIP before extracting it, select **Properties**, check **Unblock**, then extract it again.

### macOS / Linux

Open Terminal in the project folder and run:

```bash
chmod +x setup.sh start.sh start.command
./setup.sh
```

This only needs to be done the first time.

## Run

### Windows

Double-click:

```text
start.vbs
```

This starts the scraper in the background and opens the web interface without leaving a terminal window open.

You can also use:

```text
start.bat
```

Starting the scraper again closes the previous scraper session and creates a fresh one.

### macOS / Linux

Run:

```bash
./start.sh
```

On macOS, you can also open:

```text
start.command
```

The local interface is normally available at:

```text
http://127.0.0.1:3847
```

## Force Quit

If the scraper becomes stuck or you need to stop it manually:

### Windows

```bat
taskkill /F /IM node.exe
```

> This stops all currently running Node.js processes on the computer.

### macOS / Linux

To stop the TTU Grade Scraper server specifically:

```bash
pkill -f "node.*server.js"
```

If that does not stop it, you can stop all Node.js processes for your user account with:

```bash
killall node
```

> `killall node` stops every Node.js process for your user account, so use it only if needed.

## Grade Distribution Scraper

1. Sign in with your Texas Tech credentials if prompted.
2. Select the academic terms to search.
3. Select one or more subjects.
4. Load the available courses.
5. Select the courses and terms you want to analyze.
6. Start the scrape.
7. Open the generated Grade Analytics page when complete.

The standalone scraper can use two independent Cognos pages so multiple selected courses can be processed concurrently while preserving the user's requested output order.

Grade Analytics includes course and professor comparisons, grade distributions, estimated GPA, adjusted GPA, DFW rate, enrollment, historical trends, forecasts when enough history exists, and Rate My Professors context when available.

## Schedule Analyzer

The Schedule Analyzer combines current TTU timetable data with historical professor information.

When courses are added, preliminary VSB timetable data is given priority so the calendar becomes usable quickly. Schedule generation is allowed as soon as every checked course has a fast VSB timetable; Cognos professor history can continue loading in the background, and the ranking refreshes automatically when that richer data arrives. Courses added while Cognos is reading another course's grade history can still begin their VSB fast-load pass instead of waiting behind that Cognos job.

After preliminary timetables are available, full-semester verification runs in the background for labs, discussions, no-credit companions, exams, holidays, irregular dates, and other unusual timetable patterns.

For large result sets, full-semester verification can use up to five VSB sessions. The primary authenticated session is joined by isolated Chromium workers that reuse only the TTU SSO state needed to sign in; cookies that would be sent to `schedulebuilder.ttu.edu` (including parent-domain `.ttu.edu` cookies) are removed before each worker enters VSB so TTU can bootstrap a separate Schedule Builder server session. Each VSB session receives a local UUID marker and a short hash of its applicable TTU Schedule Builder cookies for diagnostics; real authentication-cookie values are never printed. Parallel results are accepted only after coverage and result-count checks pass. If an isolated worker misses an exact course or range, the application preserves successful work and retries only the affected range through a healthy/primary session rather than silently accepting incomplete data.

Fast timetable work remains higher priority than background deep verification. If a new course is added while a large deep scan is running, verification can yield so the new course's preliminary VSB timetable becomes available first, then resume from cached/verified progress. Five VSB sessions are therefore a ceiling, not a requirement that every deep scan must occupy continuously.

### Course pinning

Clicking a calendar meeting block pins or unpins that exact timetable option.

The recommended course card itself is also clickable and uses the same pin state. This is especially useful for online courses or other options with no fixed calendar meeting block.

Profile, RMP, Compare, and other buttons inside the card remain independent and do not toggle the pin.

### Calendar subsets

Courses can be temporarily unchecked above the ranked calendar without deleting their cached data. This lets you preview one course, then two, then a full combination.

When the UI says it is showing only part of the loaded course set, that is an intentional local calendar selection. The unchecked courses remain loaded/cached and can be re-enabled immediately.

## Professor Ranking

Professor ranking follows this priority:

1. **Texas Tech Grade Distribution data**
   - Used whenever usable TTU grade history exists for that professor/course.

2. **Rate My Professors fallback**
   - Used only when usable TTU grade history is unavailable.
   - The rating is sample-aware so a tiny number of reviews receives less influence.

3. **Schedule convenience**
   - Used when neither usable TTU grade history nor usable RMP data exists.

A professor with an RMP profile but zero student ratings is treated as **unrated**. The app displays `—` instead of `0/5`, and the professor receives no RMP ranking penalty.

Explicit **Prefer** and **Avoid** selections remain user-controlled overrides.

## Rate My Professors

When a professor can be confidently matched, the application may display:

- Overall rating
- Difficulty
- Would-take-again percentage
- Number of ratings
- Common tags
- Department
- Course-code evidence when available

RMP is supplemental student feedback. It remains visible even when TTU grade history is the ranking source so users can evaluate the two sources separately.

If a professor cannot be confidently matched, the application avoids assigning potentially incorrect RMP data and keeps a direct/search link for manual verification.

## Output

Generated Grade Analytics files are saved in:

```text
output/
```

The generated pages can be opened locally in a web browser.

## Local Data, Authentication & Privacy

- Your Texas Tech credentials are used only to perform the requested Texas Tech authentication.
- The application does not intentionally save your Texas Tech password or MFA code.
- Persistent local Playwright browser profiles may retain authenticated Texas Tech session information.
- Parallel VSB workers intentionally create fresh Schedule Builder application sessions; the console logs only a generated worker marker and a short cookie fingerprint, not TTU cookie values.
- Schedule/grade/RMP caches are stored locally to reduce unnecessary repeated requests.
- The local server normally binds only to `127.0.0.1:3847` and is not intended to be exposed directly to the public Internet.
- Do not commit browser profiles, cached authentication data, logs containing sensitive information, or other private local files to a public repository.

## Testing

Run the regression suite with:

```bash
npm test
```

The automated tests cover schedule generation, linked bundles, conflict detection, parallel utilities, VSB reset/reliability behavior, parent-domain Schedule Builder cookie stripping/session isolation, Cognos reliability/concurrency, RMP handling, and release-level UI/behavior checks.

Live TTU markup can change, so final course availability, meeting times, instructors, and CRNs should still be verified in official Texas Tech systems.

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — application structure and data flow
- [AUDIT.md](AUDIT.md) — reliability, correctness, UI, and live-acceptance findings
- [CHANGELOG.md](CHANGELOG.md) — version history
- [TESTING.md](TESTING.md) — automated and live testing checklist

## Disclaimer & Responsible Use

This project is an independent educational/personal project and is not affiliated with, endorsed by, or maintained by Texas Tech University.

The application automates interaction with the existing Texas Tech Grade Distribution portal and Visual Schedule Builder and requires users to authenticate using their own authorized access. It does not provide access to data or systems that the user is not otherwise authorized to access.

Users are responsible for complying with Texas Tech University policies and any applicable terms of use. Avoid excessive or high-frequency requests that could place unnecessary load on university systems. Large data collections should be performed in smaller batches when appropriate.

The developer is not responsible for account restrictions, rate limiting, service interruptions, inaccurate third-party information, changes to external services, or other consequences resulting from improper or excessive use of this software.

Schedule recommendations and professor analytics are provided for informational purposes only. Users should verify course availability, prerequisites, restrictions, meeting times, instructors, credit hours, and final CRNs through official Texas Tech systems before registration.

Rate My Professors data represents third-party student feedback and should not be interpreted as official Texas Tech University data.

This software is provided for educational and informational purposes only.

## License

Licensed under the Apache License 2.0.

Copyright © 2026 Ty Anderson.

See [LICENSE](LICENSE) and [NOTICE](NOTICE) for details.
