# TTU Grade Distribution Scraper

A local web application for scraping Texas Tech University Grade
Distribution reports from IBM Cognos and viewing course/professor
analytics.

## Requirements

-   **Node.js 20 or newer**
-   **npm** (included with Node.js)
-   Internet connection
-   Texas Tech eRaider account with access to the Grade Distribution
    report
-   Windows, macOS, or Linux

The setup script installs the required Node packages and Playwright
Chromium browser automatically.

## Setup

### Windows

1.  Download or clone this repository.
2.  Open the project folder.
3.  Run:

``` text
setup.bat
```

This only needs to be done the first time.

If Windows blocks `setup.bat` after downloading the repository as a ZIP,
right-click the ZIP before extracting it, select **Properties**, check
**Unblock**, then extract it again.

### macOS / Linux

Run:

``` bash
chmod +x setup.sh start.sh
./setup.sh
```

## Run

### Windows

Double-click:

``` text
start.vbs
```

This starts the scraper in the background and opens the web interface
without leaving a terminal window open.

You can also use:

``` text
start.bat
```

Starting the scraper again closes the previous scraper session and
creates a fresh one.

### macOS / Linux

Run:

``` bash
./start.sh
```

## Using the Scraper

1.  Sign in with your Texas Tech credentials if prompted.
2.  Select the academic terms to search.
3.  Select one or more subjects.
4.  Load the available courses.
5.  Select the courses and terms you want to analyze.
6.  Start the scrape.
7.  Open the generated Grade Analytics page when complete.

The scraper runs Cognos through Playwright in the background, so the
automated Chromium window does not need to remain visible.

## Output

Generated files are saved in:

``` text
output/
```

The analytics page includes course and professor comparisons, grade
distributions, estimated GPA, DFW rate, enrollment, and
sample-size-adjusted GPA rankings.

## Notes

-   Your Texas Tech password is used for the login attempt and is not
    intentionally saved by the application.
-   A persistent local browser profile may retain your authenticated
    Texas Tech session.
-   Grade-distribution data comes from Texas Tech's Cognos report and
    availability depends on the university's system.
