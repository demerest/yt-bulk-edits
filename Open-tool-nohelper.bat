@echo off
rem yt-bulk-edits :: open the app straight from disk, no helper process.
rem Use this with the "Paste access token" tab (Google OAuth Playground).
setlocal
cd /d "%~dp0"
start "" "%~dp0index.html"
