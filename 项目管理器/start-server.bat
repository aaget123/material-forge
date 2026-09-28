@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist "dist\web\index.html" (
  echo 前端尚未构建，正在构建...
  call npm run web:build
)

rem 等服务起来再打开浏览器（默认端口 8756，被占用时会自动往后找并写进 <库目录>\runtime.json）
start "" cmd /c "timeout /t 2 >nul & start "" http://127.0.0.1:8756"

echo 启动本地服务（关闭此窗口即停止服务）...
node --no-warnings server\server.ts
