@echo off
setlocal EnableExtensions
chcp 65001 >nul
title 术力口周榜 - 更新数据
cd /d "%~dp0"
echo.
echo   正在从 Biliboard 同步最新一期并重新生成看板...
echo.
node src\cli.js update
echo.
if errorlevel 1 (
  echo   [!] 更新失败，可先运行 node src\cli.js doctor 自检。
) else (
  echo   更新完成，双击「启动.cmd」即可查看。
)
pause
