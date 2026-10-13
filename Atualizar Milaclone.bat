@echo off
rem Updates Milaclone from its git repository and restarts the background server.
cd /d "%~dp0"
git pull --ff-only
if errorlevel 1 (
  echo.
  echo Nao foi possivel atualizar. Veja a mensagem acima.
  pause
  exit /b 1
)
call npm install --no-audit --no-fund
rem the keep-alive script starts the server again within seconds
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 4321 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"
echo.
echo Atualizado. O Milaclone reinicia em alguns segundos.
pause
