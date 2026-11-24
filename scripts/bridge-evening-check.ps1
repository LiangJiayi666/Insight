$ErrorActionPreference = 'Stop'
# Local-only watchdog: no model calls and no Feishu messages.
$root = Split-Path $PSScriptRoot -Parent
$now = Get-Date
if ($now.TimeOfDay -lt [TimeSpan]::Parse('22:00:00')) { exit 0 }
$date = $now.ToString('yyyy-MM-dd')
while ((Get-Date).ToString('yyyy-MM-dd') -eq $date) {
$done = $true
foreach ($kind in @('cost', 'daily')) {
    $file = Join-Path $root "data\delivery-ledger\$(if ($kind -eq 'cost') { "$date-published-cost" } else { "$date-daily" }).json"
    if (!(Test-Path -LiteralPath $file)) { $done = $false; break }
    try {
        $record = Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($record.status -ne 'sent' -or ($kind -eq 'daily' -and ($record.kind -ne 'file' -or $record.editionDate -ne $date))) { $done = $false; break }
    } catch { $done = $false; break }
}
if ($done) { exit 0 }
$task = Get-ScheduledTask -TaskName 'Pi-Feishu-Bridge'
if ($task.State -ne 'Running') { Start-ScheduledTask -TaskName 'Pi-Feishu-Bridge' }
Start-Sleep -Seconds 600
}
