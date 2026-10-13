# Keeps the Milaclone server running in the background.
#   - one copy at a time (a second launch exits at once);
#   - the server is started again if it stops, after 3 seconds, and right away
#     when it exits with code 75, which is how an update asks for a restart;
#   - logs go to data\server.log (this script), server.out.log and server.err.log.
# Started hidden at Windows logon by the scheduled task that instalar.ps1 creates.

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root

$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\MilacloneServer', [ref]$created)
if (-not $created) { exit 0 }

# the server listens on this computer only; PORT and DATA_DIR may be set by the caller
$env:HOST = '127.0.0.1'
if (-not $env:PORT) { $env:PORT = '4321' }
$dataDir = if ($env:DATA_DIR) { $env:DATA_DIR } else { Join-Path $root 'data' }
New-Item -ItemType Directory -Force $dataDir | Out-Null
$log = Join-Path $dataDir 'server.log'
$out = Join-Path $dataDir 'server.out.log'
$err = Join-Path $dataDir 'server.err.log'
function Log($message) { Add-Content -Path $log -Value ('{0} {1}' -f (Get-Date -Format s), $message) }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Log 'node não foi encontrado no PATH'; exit 1 }

while ($true) {
  foreach ($file in $log, $out, $err) {
    if ((Test-Path $file) -and ((Get-Item $file).Length -gt 5MB)) { Move-Item $file "$file.old" -Force }
  }
  Log "iniciando o servidor na porta $($env:PORT)"
  $process = Start-Process -FilePath $node -ArgumentList 'server.js' -WorkingDirectory $root -WindowStyle Hidden `
    -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
  $null = $process.Handle   # without this, Windows PowerShell 5.1 can report no exit code
  $process.WaitForExit()
  $code = $process.ExitCode
  Log "o servidor saiu com código $code"
  if ($code -ne 75) { Start-Sleep -Seconds 3 }
}
