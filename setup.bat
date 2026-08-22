@echo off
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js was not found.
    echo Install Node.js 20 or newer first.
    pause
    exit /b 1
)

node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)" >nul 2>nul
if errorlevel 1 (
    echo Node.js 20 or newer is required.
    node --version
    pause
    exit /b 1
)

echo Installing exact Node dependencies from package-lock.json...
if exist package-lock.json (
    call npm ci
) else (
    call npm install
)
if errorlevel 1 goto :fail

echo.
echo Installing Playwright Chromium...
call npx playwright install chromium
if errorlevel 1 goto :fail

echo.
echo Setup complete.
echo You can now double-click start.vbs (no terminal window) or start.bat.
pause
exit /b 0

:fail
echo.
echo Setup failed. Review the error above.
pause
exit /b 1
