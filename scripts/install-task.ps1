param([string]$TaskName = 'Insight-Daily', [switch]$Remove)
$ErrorActionPreference = 'Stop'
if ($Remove) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false; exit }
$Root = Split-Path -Parent $PSScriptRoot
$Node = (Get-Command node -ErrorAction Stop).Source
if ((Get-TimeZone).Id -ne 'China Standard Time') { throw '当前任务按北京时间19:50安装；请先将Windows时区设为中国标准时间，或自行配置触发器。' }
& $Node (Join-Path $PSScriptRoot 'pi-daily.mjs') --check
if ($LASTEXITCODE -ne 0) { throw '配置检查未通过，不安装定时任务。' }
$Config = Get-Content (Join-Path $Root 'config/settings.json') -Raw | ConvertFrom-Json
$Action = New-ScheduledTaskAction -Execute $Node -Argument ('"' + (Join-Path $PSScriptRoot 'pi-daily.mjs') + '"') -WorkingDirectory $Root
$Trigger = New-ScheduledTaskTrigger -Daily -At $Config.scheduleLocalTime
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$User = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$Principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal -Description 'Insight: daily 12-news HTML via existing Pi; Feishu not enabled' -Force | Out-Null
Write-Host "已安装 $TaskName。需要当前用户已登录、电脑运行且联网；关机/休眠时不保证按时制作。"
