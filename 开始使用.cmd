@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if not errorlevel 1 goto ready
where winget >nul 2>nul
if errorlevel 1 goto need_agent
echo 正在安装运行环境。若 Windows 要求本人确认安装权限，请完成该确认。
winget install --id OpenJS.NodeJS.LTS --exact --source winget --silent --accept-package-agreements --accept-source-agreements --disable-interactivity
if errorlevel 1 goto need_agent
where node >nul 2>nul
if not errorlevel 1 goto ready
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
where node >nul 2>nul
if errorlevel 1 goto need_agent
:ready
node tools/setup.cjs --open
set "startResult=%errorlevel%"
if not "%startResult%"=="0" echo 尚未完成。请保留上方错误信息，让 Agent 按 docs/客户端接入.md 继续处理；不要发送登录文件。
pause
exit /b %startResult%
:need_agent
echo 运行环境尚未就绪。请让有本机操作能力的 Agent 阅读 docs/客户端接入.md，自行完成安装和验证。
pause
exit /b 1
