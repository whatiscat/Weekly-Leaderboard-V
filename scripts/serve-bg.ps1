<#
  后台常驻预览服务
  用法：
    powershell -ExecutionPolicy Bypass -File scripts\serve-bg.ps1          启动
    powershell -ExecutionPolicy Bypass -File scripts\serve-bg.ps1 -Stop    停止
    powershell -ExecutionPolicy Bypass -File scripts\serve-bg.ps1 -Status  查看
  说明：通过 WMI 创建进程，不挂在当前终端/作业对象下，关掉窗口也不会停。
#>
param(
  [switch]$Stop,
  [switch]$Status,
  [int]$Port = 5173
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root "logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$log = Join-Path $logDir "serve.log"

function Test-Port {
  param([int]$p)
  try {
    $c = New-Object Net.Sockets.TcpClient
    $c.Connect("127.0.0.1", $p)
    $c.Close()
    return $true
  } catch { return $false }
}

function Get-ServeProcess {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like "*cli.js*serve*" }
}

if ($Status) {
  $procs = @(Get-ServeProcess)
  if ($procs.Count -eq 0) { Write-Host "服务未运行"; exit 0 }
  foreach ($p in $procs) { Write-Host ("PID " + $p.ProcessId) }
  if (Test-Port $Port) { Write-Host ("http://127.0.0.1:" + $Port + "/ 可访问") } else { Write-Host "端口未响应" }
  exit 0
}

if ($Stop) {
  $procs = @(Get-ServeProcess)
  if ($procs.Count -eq 0) { Write-Host "服务未运行"; exit 0 }
  foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  Write-Host "已停止"
  exit 0
}

if (Test-Port $Port) {
  Write-Host ("服务已在运行：http://127.0.0.1:" + $Port + "/")
  exit 0
}

$cmd = "cmd.exe /c cd /d " + [char]34 + $root + [char]34 + " && node src\cli.js serve >> " + [char]34 + $log + [char]34 + " 2>&1"
$res = ([wmiclass]"Win32_Process").Create($cmd)
if ($res.ReturnValue -ne 0) { throw ("启动失败，ReturnValue=" + $res.ReturnValue) }

for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 400
  if (Test-Port $Port) { break }
}

if (Test-Port $Port) {
  Write-Host ("已启动：http://127.0.0.1:" + $Port + "/")
  Write-Host ("日志：" + $log)
  Write-Host "停止：powershell -ExecutionPolicy Bypass -File scripts\serve-bg.ps1 -Stop"
} else {
  Write-Host "启动后端口未响应，请查看日志："
  if (Test-Path $log) { Get-Content $log -Tail 20 }
  exit 1
}
