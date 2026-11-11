@echo off
chcp 65001 >nul
title CODIZULCA C.A. - TradeTrack ^& RutaDegustacion
cd /d "%~dp0"
echo ============================================================================
echo   CODIZULCA C.A. - Iniciando TradeTrack (:3000) y RutaDegustacion (:5174)
echo ============================================================================
start "" cmd /c "timeout /t 3 /nobreak >nul && start http://localhost:3000 && start http://localhost:5174"
call npm.cmd run dev
pause
