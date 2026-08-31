#!/usr/bin/env node
import { spawn } from 'node:child_process';
import process from 'node:process';

/**
 * Production-style local run: the built panel plus the worker.
 * Requires `pnpm build` to have run first.
 *
 *   pnpm start
 */

const ESC = String.fromCharCode(27);
const RESET = `${ESC}[0m`;

const PROCESSES = [
  { name: 'web', color: `${ESC}[36m`, command: 'next', args: ['start', '--port', process.env.WEB_PORT ?? '4310'] },
  { name: 'worker', color: `${ESC}[35m`, command: 'tsx', args: ['src/worker/main.ts'] },
];

const children = [];
let shuttingDown = false;

function pipe(stream, name, color, target) {
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) target.write(`${color}[${name}]${RESET} ${line}\n`);
  });
}

for (const entry of PROCESSES) {
  const child = spawn(entry.command, entry.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    env: process.env,
  });
  pipe(child.stdout, entry.name, entry.color, process.stdout);
  pipe(child.stderr, entry.name, entry.color, process.stderr);
  child.on('exit', (code) => {
    if (shuttingDown) return;
    process.stdout.write(`${entry.color}[${entry.name}]${RESET} encerrou com código ${code ?? 0}\n`);
    shutdown(code ?? 0);
  });
  children.push(child);
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 500);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
