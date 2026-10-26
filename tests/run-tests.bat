@echo off
rem yt-bulk-edits :: run both test suites in headless Chrome.
rem No Node or Python needed - Chrome is the runtime, and --dump-dom returns the
rem assertions as text. Exits 1 if any test in either suite fails.
setlocal enabledelayedexpansion
set "HERE=%~dp0"
set "OUTDIR=%TEMP%"

set "CHROME="
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" set "CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" set "CHROME=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" set "CHROME=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if not defined CHROME if exist "C:\Program Files\Microsoft\Edge\Application\msedge.exe" set "CHROME=C:\Program Files\Microsoft\Edge\Application\msedge.exe"
if not defined CHROME (
  echo No Chrome or Edge found. Install one, or edit this script.
  exit /b 2
)

set "CHROME_FLAGS=--headless=new --disable-gpu --no-first-run --no-default-browser-check"
set RC=0
rem A fresh profile per run: localStorage otherwise carries the previous run's
rem change log into this one and the counts stop meaning anything.
set "UNIT_DIR=%OUTDIR%\ytbe-t-unit-%RANDOM%%RANDOM%"
set "DOM_DIR=%OUTDIR%\ytbe-t-dom-%RANDOM%%RANDOM%"

echo ==========================================================================
echo   Suite 1/2: unit tests (engine, api, store, auth)
echo ==========================================================================
"%CHROME%" %CHROME_FLAGS% --user-data-dir="%UNIT_DIR%" ^
  --virtual-time-budget=180000 --timeout=240000 ^
  --dump-dom "file:///%HERE%harness.html" > "%OUTDIR%\ytbe-unit-out.html" 2>nul
findstr /C:"SUMMARY pass=" "%OUTDIR%\ytbe-unit-out.html"
findstr /B /C:"FAIL" "%OUTDIR%\ytbe-unit-out.html"
rem Gate on the real fail count, not a hardcoded total that rots as tests are added.
findstr /C:"fail=0 total=" "%OUTDIR%\ytbe-unit-out.html" >nul || set RC=1

echo.
echo ==========================================================================
echo   Suite 2/2: end-to-end DOM tests (real page, demo mode)
echo ==========================================================================
"%CHROME%" %CHROME_FLAGS% --user-data-dir="%DOM_DIR%" ^
  --virtual-time-budget=180000 --timeout=240000 ^
  --dump-dom "file:///%HERE%..\index.html?autotest=1" > "%OUTDIR%\ytbe-dom-out.html" 2>nul
findstr /C:"AUTOTEST pass=" "%OUTDIR%\ytbe-dom-out.html"
findstr /B /C:"FAIL" /C:"FATAL" "%OUTDIR%\ytbe-dom-out.html"
findstr /C:"AUTOTEST pass=" "%OUTDIR%\ytbe-dom-out.html" | findstr /C:"fail=0" >nul || set RC=1

echo.
echo ==========================================================================
if %RC%==0 (
  echo   ALL TESTS PASSED
) else (
  echo   FAILURES PRESENT - full output:
  echo     %OUTDIR%\ytbe-unit-out.html
  echo     %OUTDIR%\ytbe-dom-out.html
)
echo ==========================================================================
exit /b %RC%
