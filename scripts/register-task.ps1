<#
  注册 / 注销 Windows 计划任务：每周三 19:30 自动执行增量更新。
  用法：
    powershell -ExecutionPolicy Bypass -File scripts\register-task.ps1
    powershell -ExecutionPolicy Bypass -File scripts\register-task.ps1 -Remove
    powershell -ExecutionPolicy Bypass -File scripts\register-task.ps1 -Time 20:00 -DayOfWeek Thursday
#>
param(
  [string]$TaskName = 'BiliBoardWeekly',
  [string]$Time = '19:30',
  [ValidateSet('Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday')]
  [string]$DayOfWeek = 'Wednesday',
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if ($Remove) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "已删除计划任务 $TaskName"
  exit 0
}

$node = (Get-Command node -ErrorAction Stop).Source
$action = New-ScheduledTaskAction -Execute $node -Argument 'src/cli.js update' -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $DayOfWeek -At $Time
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries

$desc = 'Bili-Board_Atel 术力口周榜：增量抓取并重新生成看板'
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force -Description $desc | Out-Null

Write-Host "已注册计划任务 $TaskName：每周 $DayOfWeek $Time 执行 node src/cli.js update"
Write-Host "工作目录：$root"
Write-Host "手动运行：schtasks /Run /TN $TaskName"
