@echo off
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js was not found.
    echo Install Node.js 20 or newer, then run setup.bat.
    pause
    exit /b 1
)

if not exist "node_modules\playwright" (
    echo Dependencies are not installed yet.
    echo Run setup.bat once, then run start.bat again.
    pause
    exit /b 1
)

wscript.exe "%~dp0start.vbs"
exit /b 0
