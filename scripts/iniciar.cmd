@echo off
chcp 65001 >nul
setlocal

rem ===================================================================
rem  Sobe o Orbyn inteiro, na ordem correta.
rem
rem  A ordem importa: o tunel se recusa a subir enquanto o painel nao
rem  responder. Este script so o inicia depois de confirmar a saude do
rem  painel, que e o passo mais facil de errar quando feito na mao.
rem ===================================================================

set "RAIZ=%~dp0.."
set "PERFIL=%RAIZ%\.chrome-profile"
set "PORTA=4310"
rem O endereco publico vem do .env (NGROK_DOMAIN), escrito la por
rem "pnpm tunnel". Fixa-lo aqui o colocaria no controle de versao, e
rem este repositorio e publico.
set "PAINEL="
for /f "tokens=2 delims==" %%D in ('findstr /b /c:"NGROK_DOMAIN=" "%RAIZ%\.env" 2^>nul') do set "PAINEL=https://%%D"

rem O caminho do Chrome e resolvido AQUI, fora de qualquer bloco: uma
rem variavel definida dentro de um "if" nao e lida no mesmo bloco, e
rem entregaria um caminho vazio.
set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"

echo.
echo   Orbyn - iniciando
echo   ------------------------------------------------
echo.

rem --- 1. Chrome da automacao -------------------------------------
curl -s -m 3 -o nul http://127.0.0.1:9222/json/version
if %errorlevel%==0 goto chrome_ok

if not exist "%CHROME%" (
  echo   [ERRO] chrome.exe nao encontrado nos caminhos padrao.
  echo          Edite a variavel CHROME neste script.
  pause
  exit /b 1
)

echo   [...]  abrindo o Chrome da automacao
start "" "%CHROME%" --remote-debugging-port=9222 --user-data-dir="%PERFIL%" https://www.instagram.com/
ping -n 8 127.0.0.1 >nul
curl -s -m 3 -o nul http://127.0.0.1:9222/json/version
if %errorlevel%==0 goto chrome_ok

echo   [AVISO] o Chrome abriu, mas a porta 9222 nao respondeu.
echo           Quase sempre e porque ja havia um Chrome aberto: nesse
echo           caso a janela nova se anexa a ele e a flag e ignorada.
echo           Feche TODAS as janelas do Chrome e rode este script de novo.
echo           Sem isso, o envio por navegador vai falhar.
goto painel

:chrome_ok
echo   [ok]   Chrome pronto com depuracao remota

rem --- 2. Painel e worker -----------------------------------------
:painel
curl -s -m 3 -o nul http://127.0.0.1:%PORTA%/api/health
if %errorlevel%==0 (
  echo   [ok]   painel ja estava rodando na porta %PORTA%
) else (
  echo   [...]  subindo painel e worker
  start "Orbyn - painel e worker" cmd /k "cd /d "%RAIZ%" && pnpm dev"
)

rem --- 3. Espera o painel atender ---------------------------------
echo   [...]  aguardando o painel responder
set /a TENTATIVAS=0

:esperar
curl -s -m 3 -o nul http://127.0.0.1:%PORTA%/api/health
if %errorlevel%==0 goto pronto
set /a TENTATIVAS+=1
if %TENTATIVAS% geq 40 (
  echo.
  echo   [ERRO] o painel nao respondeu em 2 minutos.
  echo          Veja a janela "Orbyn - painel e worker" para o motivo.
  echo.
  pause
  exit /b 1
)
ping -n 4 127.0.0.1 >nul
goto esperar

:pronto
echo   [ok]   painel respondendo

rem --- 4. Tunel publico -------------------------------------------
echo   [...]  subindo o tunel publico
start "Orbyn - tunel" cmd /k "cd /d "%RAIZ%" && pnpm tunnel"

echo.
echo   ------------------------------------------------
echo   Tudo iniciado.
echo.
if defined PAINEL (
  echo   Painel publico:  %PAINEL%
) else (
  echo   Painel publico:  veja a janela "Orbyn - tunel"
)
echo   Painel local:    http://127.0.0.1:%PORTA%
echo.
echo   As duas janelas abertas precisam continuar abertas.
echo   Fechar uma derruba a parte correspondente.
echo.
echo   Envio automatico: das 09h as 20h.
echo   Resposta de lead: recebida a qualquer hora.
echo   ------------------------------------------------
echo.
ping -n 16 127.0.0.1 >nul
