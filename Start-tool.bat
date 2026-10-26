@echo off
rem yt-bulk-edits :: start the local sign-in helper and open the app.
rem The helper also serves the page, so the app runs at http://localhost:8787
rem (a real origin, which is what Google's OAuth redirect needs).
setlocal
cd /d "%~dp0"
title yt-bulk-edits helper
echo.
echo   Starting the yt-bulk-edits sign-in helper on http://localhost:8787
echo   Keep this window open while you work. Close it (or Ctrl+C) to stop.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0auth-helper.ps1"
echo.
echo   Helper exited. Press any key to close this window.
pause >nul
