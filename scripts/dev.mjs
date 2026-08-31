#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';

/**
 * One command to bring up the whole local system: the operator panel and the
 * durable worker, in the same terminal, with a single Ctrl+C stopping both.
 *
 *   pnpm dev
 */

const PROCESSES = [
  { name: 'web', color: '[36m', command: 'next', args: ['dev', '--port', process.env.WEB_PORT ?? '4310'] },
  { name: 'worker', color: '[35m', command: 'tsx', args: ['watch', 'src/worker/main.ts'] },
];

const RESET = '[0m';
const children = [];
let shuttingDown = false;

function prefix(name, color) {
  return `${color}[${name}]${RESET} `;
}

function pipe(stream, name, color, target) {
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) target.write(`${prefix(name, color)}${line}\n`);
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
    process.stdout.write(`${prefix(entry.name, entry.color)}encerrou com código ${code ?? 0}\n`);
    shutdown(code ?? 0);
  });
  children.push(child);
}

/**
 * Kills a child and everything it spawned.
 *
 * On Windows `shell: true` puts a cmd.exe between us and the real process, and
 * `child.kill()` reaches only that shell - the node process underneath survives
 * as an orphan. That is not cosmetic: an orphaned worker keeps leasing jobs from
 * the same queue as its replacement, so two of them can race over the same
 * outbound message. Killing the tree is the only reliable stop here.
 */
function killTree(child) {
  if (child.killed || child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  child.kill('SIGTERM');
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) killTree(child);
  setTimeout(() => process.exit(code), 500);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
// Covers the paths that bypass the handlers above: an uncaught error here, or
// the parent being killed by a supervisor that does not deliver a signal first.
process.on('exit', () => {
  for (const child of children) killTree(child);
});

process.stdout.write(
  `\nOrbyn em desenvolvimento\n  painel  http://127.0.0.1:${process.env.WEB_PORT ?? '4310'}\n  worker  processando jobs duráveis\n\nCtrl+C encerra os dois.\n\n`,
);
