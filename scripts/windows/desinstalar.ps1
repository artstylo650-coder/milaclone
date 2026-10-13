# Undoes instalar.ps1: removes the scheduled task and the shortcuts and stops the
# background server. Boards, uploads and backups (data\, public\uploads\) stay.

param(
  [string]$TaskName = 'Milaclone',
  [int]$Port = 4321,
  [string]$ShortcutDir
)
$ErrorActionPreference = 'Continue'

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Write-Host "• Removendo a tarefa '$TaskName'"
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

# the keep-alive loop first, so it does not start the server again
Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*servidor.ps1*' } |
  ForEach-Object { Write-Host '• Parando o monitor do servidor'; Stop-Process -Id $_.ProcessId -Force }
Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Write-Host "• Parando o servidor na porta $Port"; Stop-Process -Id $_.OwningProcess -Force }

$folders = if ($ShortcutDir) { @($ShortcutDir) } else { @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop')) }
foreach ($folder in $folders) {
  $lnk = Join-Path $folder 'Milaclone.lnk'
  if (Test-Path $lnk) { Write-Host "• Removendo o atalho em $folder"; Remove-Item $lnk -Force }
}
Write-Host 'Pronto. Seus boards e imagens continuam nas pastas data\ e public\uploads\.'
