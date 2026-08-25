@echo off
cd /d "%~dp0"
if exist ".venv\.ytlt_dependencies_installed" del ".venv\.ytlt_dependencies_installed"
call start_server.bat
