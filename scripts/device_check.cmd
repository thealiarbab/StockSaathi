@echo off
REM Cross-device layout check (WebKit/Safari, Chromium, Firefox). Usage: scripts\device_check.cmd [out_dir]
setlocal
set "PLAYWRIGHT_BROWSERS_PATH=%LOCALAPPDATA%\claude-seo\ms-playwright"
set "PY=%LOCALAPPDATA%\claude-seo\.venv\Scripts\python.exe"
if not exist "%PY%" set "PY=python"
"%PY%" "%~dp0device_check.py" %*
exit /b %ERRORLEVEL%
