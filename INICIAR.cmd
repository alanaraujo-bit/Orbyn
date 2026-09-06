@echo off
rem Atalho de clique duplo. A logica de verdade vive em scripts\iniciar.cmd;
rem este arquivo existe so para que o ponto de entrada fique visivel na raiz
rem do projeto, onde se procura por ele.
call "%~dp0scripts\iniciar.cmd" %*
