@echo off
title Mumtaz Pharmacy - Start
REM Double-click to start the whole Mumtaz system: database, backend,
REM frontend, then the browser. Keep the windows open while you use it.
REM The database writes its log to logs\mongod.log (in this folder).
cd /d "%~dp0"
if not exist "%~dp0logs" mkdir "%~dp0logs"

set "MONGOD=C:\Program Files\MongoDB\Server\8.0\bin\mongod.exe"
set "DBPATH=%USERPROFILE%\nagaad-mongo-data"

netstat -ano | findstr /R /C:":27018 .*LISTENING" >nul
if errorlevel 1 (
  echo Starting the database...
  > "%~dp0logs\start-info.txt" echo MONGOD=%MONGOD%
  >> "%~dp0logs\start-info.txt" echo DBPATH=%DBPATH%
  if exist "%MONGOD%" (>> "%~dp0logs\start-info.txt" echo mongod.exe found) else (>> "%~dp0logs\start-info.txt" echo mongod.exe NOT FOUND)
  if exist "%DBPATH%" (>> "%~dp0logs\start-info.txt" echo dbpath found) else (>> "%~dp0logs\start-info.txt" echo dbpath NOT FOUND)
  netstat -ano | findstr ":27017 :27018" >> "%~dp0logs\start-info.txt"
  start "Mumtaz DATABASE" cmd /k ""%MONGOD%" --dbpath "%DBPATH%" --port 27018 --replSet rs0 --bind_ip 127.0.0.1 --logpath "%~dp0logs\mongod.log" --logappend & echo. & echo THE DATABASE STOPPED -- see logs\mongod.log"
  timeout /t 10 /nobreak >nul
) else (
  echo The database is already running.
)

start "Mumtaz BACKEND" cmd /k "cd /d "%~dp0backend" && npm run dev"
start "Mumtaz FRONTEND" cmd /k "cd /d "%~dp0frontend" && npm run dev"

echo Starting... the browser opens in 12 seconds.
timeout /t 12 /nobreak >nul
start "" http://localhost:5173
