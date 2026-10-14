@echo off
rem ----------------------------------------------------------------
rem  CODEZY launcher - double-click for the chat TUI, no typing.
rem  Arguments pass straight through to the CLI, e.g.
rem    "cli launch.bat" doctor
rem    "cli launch.bat" -p "explain this error"
rem    "cli launch.bat" exec "fix the tests" --auto
rem ----------------------------------------------------------------
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

node "%~dp0cli\index.mjs" %*
set RC=%ERRORLEVEL%
if not "%~1"=="" exit /b %RC%
if not "%RC%"=="0" goto broken
exit /b 0

:nonode
echo Node.js is required but was not found on PATH.
echo Install it from https://nodejs.org/ then open this window again.
pause
exit /b 1

:broken
echo.
echo CODEZY stopped with an error (code %RC%).
pause
exit /b %RC%
