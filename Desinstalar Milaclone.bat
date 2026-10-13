@echo off
rem Removes the scheduled task and shortcuts (boards and uploads stay). See scripts\windows\desinstalar.ps1
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\windows\desinstalar.ps1"
echo.
pause
