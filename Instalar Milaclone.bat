@echo off
rem Installs Milaclone as a Windows app (starts with Windows, own window). See scripts\windows\instalar.ps1
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\windows\instalar.ps1"
echo.
pause
