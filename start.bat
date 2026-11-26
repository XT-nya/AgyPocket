@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoLogo -ExecutionPolicy Bypass -File "%~dp0start-agy-pocket.ps1"
pause
