$ErrorActionPreference = 'Stop'
# Local-only watchdog: no model calls and no Feishu messages.
$root = Split-Path $PSScriptRoot -Parent
$now = Get-Date
if ($now.TimeOfDay -lt [TimeSpan]::Parse('19:45:00')) { exit 0 }
$date = $now.ToString('yyyy-MM-dd')
$done = $true
foreach ($kind in @('cost', 'daily')) {
    $file = Join-Path $root "data\delivery-ledger\$date-$kind.json"
    if (!(Test-Path -LiteralPath $file)) { $done = $false; break }
    try {
        $record = Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($record.status -ne 'sent') { $done = $false; break }
    } catch { $done = $false; break }
}
if ($done) { exit 0 }
$task = Get-ScheduledTask -TaskName 'Pi-Feishu-Bridge'
if ($task.State -ne 'Running') { Start-ScheduledTask -TaskName 'Pi-Feishu-Bridge' }
