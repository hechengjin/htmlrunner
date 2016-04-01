taskkill /f /t /im xulrunner.exe 1>nul 2>&1
Start "Starting helloWorld" "../../htmlrunner/xulrunner.exe" -app application.ini %*
exit