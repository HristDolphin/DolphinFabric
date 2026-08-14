@echo off
cd /d "%~dp0"
set "PY=%~dp0python\portable\python.exe"
if not exist "%PY%" (
  echo [ERROR] Portable Python not found: %PY%
  echo Please ensure python\portable\python.exe exists - copy the whole folder.
  pause
  exit /b 1
)
echo Starting DolphinFabric (海豚编文台) - LAN/phone address printed below
echo Press Ctrl+C in this window to stop, or close the window.
start "" "http://127.0.0.1:8003/"
"%PY%" serve.py xietai --port 8003
pause
