@echo off
chcp 65001 >nul
setlocal

rem ===================================================================
rem  Encerra o Orbyn por completo.
rem
rem  Fechar as janelas na mao nem sempre basta: no Windows o "pnpm dev"
rem  fica atras de um cmd.exe intermediario, e matar apenas a janela
rem  deixa o worker orfao arrendando jobs da mesma fila que o proximo.
rem  Este script mata as arvores inteiras.
rem
rem  Usa PowerShell em vez de wmic, que a Microsoft esta removendo.
rem ===================================================================

echo.
echo   Orbyn - encerrando
echo.

powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'Orbyn' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>&1 | Out-Null }"
powershell -NoProfile -Command "Get-Process ngrok,cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force"

ping -n 4 127.0.0.1 >nul

curl -s -m 3 -o nul http://127.0.0.1:4310/api/health
if %errorlevel%==0 (
  echo   [AVISO] ainda ha algo respondendo na porta 4310.
  echo           Rode este script de novo ou reinicie a maquina.
) else (
  echo   [ok]   painel e worker encerrados
  echo   [ok]   tunel encerrado
)

echo.
echo   O Chrome da automacao continua aberto - feche na mao se quiser.
echo   Nada se perde: a fila e duravel e retoma de onde parou.
echo.
ping -n 9 127.0.0.1 >nul
