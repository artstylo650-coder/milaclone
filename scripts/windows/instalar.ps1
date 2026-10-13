# Installs Milaclone as an app on this Windows account:
#   1. checks Node.js (and git, needed for updates) and installs the dependencies;
#   2. stops a server started by hand on the same port;
#   3. registers a scheduled task that starts the server, hidden, every time you
#      log on to Windows, and starts it now;
#   4. creates "Milaclone" shortcuts (Start menu and Desktop) that open the app in
#      its own window (Edge or Chrome in --app mode: no tabs, no address bar).
# Nothing leaves your boards or uploads (data\ and public\uploads\). Undo it with
# desinstalar.ps1. -DryRun prints what would be done and changes nothing.

param(
  [switch]$DryRun,
  [string]$TaskName = 'Milaclone',
  [int]$Port = 4321,
  [string]$ShortcutDir
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
function Step($message) { Write-Host "• $message" }
function Act($message, [scriptblock]$work) { Step $message; if (-not $DryRun) { & $work } }

# 1. requirements ----------------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js não foi encontrado. Instale o Node 20 ou mais novo em https://nodejs.org e rode este instalador de novo.' }
Step "Node.js $(& node -v) em $($node.Source)"
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Warning 'O git não foi encontrado: o Milaclone funciona, mas não conseguirá se atualizar sozinho.'
}
if (-not (Test-Path (Join-Path $root 'node_modules\express'))) {
  Act 'Instalando as dependências (npm install)…' { Push-Location $root; try { npm install --no-audit --no-fund } finally { Pop-Location } }
}

# 2. a server started by hand on the same port ---------------------------------------
$old = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($old) {
  Act "Parando o servidor que já está usando a porta $Port…" { $old | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }; Start-Sleep -Seconds 1 }
}

# 3. start with Windows -------------------------------------------------------------
$vbs = Join-Path $PSScriptRoot 'iniciar-oculto.vbs'
$taskAction = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $vbs + '"')
$taskTrigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$taskSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Act "Registrando a tarefa '$TaskName' (liga o servidor ao entrar no Windows)…" {
  Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger $taskTrigger -Settings $taskSettings `
    -Description 'Servidor do Milaclone, em segundo plano' -Force | Out-Null
}
Act 'Ligando o Milaclone agora…' { Start-ScheduledTask -TaskName $TaskName }
if (-not $DryRun) {
  $up = $false
  foreach ($i in 1..40) {
    try { Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/version" -UseBasicParsing -TimeoutSec 2 | Out-Null; $up = $true; break } catch { Start-Sleep -Seconds 1 }
  }
  if (-not $up) { Write-Warning "O servidor não respondeu em 40 segundos. Veja data\server.out.log e data\server.err.log." }
}

# 4. shortcuts ---------------------------------------------------------------------
$candidates = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$browser = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
$icon = Join-Path $root 'public\icons\milaclone.ico'
if (-not $browser) {
  Write-Warning "Edge ou Chrome não encontrados: abra http://127.0.0.1:$Port no navegador e use 'Instalar Milaclone' no menu."
} else {
  $folders = if ($ShortcutDir) { @($ShortcutDir) } else { @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop')) }
  foreach ($folder in $folders) {
    Act "Criando o atalho 'Milaclone' em $folder" {
      New-Item -ItemType Directory -Force $folder | Out-Null
      $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $folder 'Milaclone.lnk'))
      $shortcut.TargetPath = $browser
      $shortcut.Arguments = "--app=http://127.0.0.1:$Port"
      $shortcut.IconLocation = $icon
      $shortcut.Description = 'Milaclone'
      $shortcut.Save()
    }
  }
}

Write-Host ''
Write-Host 'Pronto. Abra o Milaclone pelo atalho "Milaclone" (Menu Iniciar ou Área de Trabalho).'
Write-Host 'Ele liga sozinho com o Windows. Para atualizar: menu dos 3 pontos (canto superior direito) > Sobre o Milaclone, ou 'Atualizar Milaclone.bat'.'
