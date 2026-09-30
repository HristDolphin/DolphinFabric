@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "PY=%~dp0python\portable\python.exe"
if not exist "%PY%" (
  echo [ERROR] Portable Python not found: %PY%
  echo Please ensure python\portable\python.exe exists - copy the whole folder.
  pause
  exit /b 1
)
REM 启动前清理占用端口 8000 的残留实例(避免 X 窗口后服务仍在)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8000.*LISTENING"') do (
  taskkill /PID %%a /F >nul 2>&1
)
echo Starting DolphinFabric (port 8000)...
echo Ctrl+C 或关闭本窗口即停止服务
start "" "http://127.0.0.1:8000/"
"%PY%" serve.py xietai --port 8000
pause
