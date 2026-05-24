@echo off
title PropTech Local Server
echo ========================================
echo Starting Local Server...
echo ========================================

cd /d D:\VSCODE\HOME\backend
set PYTHONPATH=.
start cmd /k "python -m uvicorn app.main:app --host 127.0.0.1 --port 10000"

cd /d D:\VSCODE\HOME\frontend
start cmd /k "npm run dev -- --host 127.0.0.1"

echo Waiting 5 seconds for servers to start...
timeout /t 5
start http://127.0.0.1:5173
