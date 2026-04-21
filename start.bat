@echo off
echo ================================
echo    BANKCORE STARTUP SCRIPT
echo ================================
echo.
echo Make sure XAMPP MySQL is running!
echo Press any key after MySQL is started...
pause > nul
cd /d %~dp0
start "BankCore Server" cmd /k "node app.js"
timeout /t 3 /nobreak > nul
start http://localhost:3000
echo.
echo BANKCORE IS RUNNING!
pause