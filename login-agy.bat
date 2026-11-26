@echo off
chcp 65001 >nul
powershell -NoLogo -ExecutionPolicy Bypass -File "%~dp0login-agy.ps1" %*
