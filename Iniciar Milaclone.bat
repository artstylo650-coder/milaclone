@echo off
cd /d "%~dp0"
set HOST=127.0.0.1
start "" http://localhost:4321
node server.js
pause
