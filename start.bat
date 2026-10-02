@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Node.js。请先安装 https://nodejs.org 的 LTS 版本，然后重新双击本文件。
  pause
  exit /b 1
)
echo 正在启动善鸡通AI，浏览器打开 http://localhost:8080
start "" http://localhost:8080
node server.js
pause
