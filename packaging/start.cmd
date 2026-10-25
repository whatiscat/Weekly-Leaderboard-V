@echo off
setlocal EnableExtensions
chcp 65001 >nul
title 术力口周榜 - 便携版
cd /d "%~dp0"

echo.
echo   ============================================
echo    术力口周榜 - 数据看板（便携版）
echo   ============================================
echo.

where node >nul 2>nul
if errorlevel 1 goto NODE_MISSING

for /f "delims=" %%v in ('node -p "process.versions.node"') do set NODE_VER=%%v
for /f "tokens=1 delims=." %%m in ("%NODE_VER%") do set NODE_MAJOR=%%m
if %NODE_MAJOR% LSS 20 goto NODE_OLD

if not exist "public\index.html" (
  echo   [1/3] 首次运行，正在生成看板...
  call node src\cli.js build
  if errorlevel 1 goto BUILD_FAIL
)

rem 已有服务在运行就直接打开浏览器
powershell -NoProfile -Command "try{ $c=New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1',5173); $c.Close(); exit 0 }catch{ exit 1 }" >nul 2>nul
if not errorlevel 1 (
  echo   看板已在运行，正在打开浏览器...
  start "" "http://127.0.0.1:5173/"
  timeout /t 2 >nul
  exit /b 0
)

if not exist ".installed" call :ASK_TASK

echo   正在启动本地服务，关闭此窗口即停止。
echo.
node src\cli.js serve --open
echo.
echo   服务已停止。
pause
exit /b 0

:ASK_TASK
echo.
echo   是否添加「每周三 19:30 自动更新」的计划任务？
echo     Y = 添加（推荐，之后可随时删除）
echo     N = 跳过，手动运行「更新数据.cmd」即可
set "BBW_ANS="
set /p BBW_ANS=  请选择 [Y/N]: 
if /i "%BBW_ANS%"=="Y" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\register-task.ps1"
) else (
  echo   已跳过。
)
echo installed> ".installed"
echo.
goto :eof

:NODE_MISSING
echo   [!] 没有检测到 Node.js。
echo       请先安装 Node.js 20 或更高版本： https://nodejs.org/zh-cn
echo       安装后重新双击本文件即可。
echo.
pause
exit /b 1

:NODE_OLD
echo   [!] Node.js 版本过低（当前 %NODE_VER%），需要 20 及以上。
echo       https://nodejs.org/zh-cn
echo.
pause
exit /b 1

:BUILD_FAIL
echo.
echo   [!] 生成看板失败，请把上面的报错信息发给维护者。
pause
exit /b 1
