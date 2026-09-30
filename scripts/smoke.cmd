@echo off
REM Pre-push smoke test. Usage:  scripts\smoke.cmd [extra paths...]
REM Uses the Playwright + Chromium runtime installed by the claude-seo plugin.
setlocal
set "PLAYWRIGHT_BROWSERS_PATH=%LOCALAPPDATA%\claude-seo\ms-playwright"
set "PY=%LOCALAPPDATA%\claude-seo\.venv\Scripts\python.exe"
if not exist "%PY%" set "PY=python"
"%PY%" "%~dp0smoke_test.py" %*
exit /b %ERRORLEVEL%
