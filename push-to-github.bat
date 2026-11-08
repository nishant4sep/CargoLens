@echo off
echo ===================================================
echo Pushing CargoLens commit history to GitHub...
echo Repository: https://github.com/nishant4sep/cargolens
echo ===================================================
git push -u origin main
echo.
if %ERRORLEVEL% equ 0 (
    echo [SUCCESS] Repository successfully pushed to GitHub!
) else (
    echo [ERROR] Push failed. Make sure you created the public repo at:
    echo         https://github.com/new with name 'cargolens'
)
pause
