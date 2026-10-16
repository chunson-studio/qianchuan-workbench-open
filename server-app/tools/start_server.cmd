@echo off
set TZ=Asia/Shanghai
REM Run the local Node.js launcher. No PowerShell or remote script execution.
where node.exe >nul 2>&1
if errorlevel 1 (
  echo Node.js 22.5+ is required. Please contact your deployment provider.
  exit /b 1
)
node.exe "%~dp0..\scripts\start-workbench.js" %*
exit /b %errorlevel%
