@echo off
title 千川数据服务
chcp 65001 >nul 2>&1
cd /d "%~dp0"

:::: 启动数据服务（统一入口会校验端口所属 PID，避免重复实例）
call "%~dp0tools\start_server.cmd" -OpenBrowser
if errorlevel 1 (
    echo 启动未完成。请记录上方错误信息，检查安装环境或联系部署服务人员。
    pause
    exit /b 1
)
echo ✓ 工作台已打开。首次使用请按页面指引连接千川账户。

:::: 注：直播数据采集已融入 server（liveCollector 调度器随 server 启动，
:::: 按 SCHEDULER.statusIntervalMs 每10分钟检测直播状态，在播才采、下播补采终值）。
:::: Agent 定时盯盘由外部调度器执行（纪律见 references/discipline.md）。

echo.
echo 启动完成。
echo  - 关闭此窗口不会停止后台服务。
echo.
pause
