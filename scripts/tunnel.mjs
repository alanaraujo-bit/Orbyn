#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';

/**
 * Brings up the public address Meta delivers webhooks to, and records it.
 *
 *   pnpm tunnel
 *
 * A quick Cloudflare tunnel gets a different hostname on every start. That is
 * survivable; what is not survivable is nobody noticing. So this script does
 * three things beyond starting the tunnel: it proves the new address actually
 * reaches this machine, it writes the address into `.env` as
 * PUBLIC_WEBHOOK_URL so the worker's watchdog can keep checking it, and it
 * prints the exact string to paste into the Meta panel.
 */

const PORT = process.env.WEB_PORT ?? '4310';
const WEBHOOK_PATH = '/api/webhooks/instagram';
const ENV_PATH = path.resolve(process.cwd(), '.env');
const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
/** How long a freshly created hostname gets to become routable at the edge. */
const VERIFY_WINDOW_MS = 90_000;

function log(message) {
  process.stdout.write(`${message}\n`);
}

/** Reads a key straight from .env, so `pnpm tunnel` needs no exported vars. */
function readEnvValue(key) {
  if (!existsSync(ENV_PATH)) return undefined;
  const match = readFileSync(ENV_PATH, 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'));
  return match?.[1]?.trim() || undefined;
}

function readVerifyToken() {
  if (!existsSync(ENV_PATH)) return undefined;
  const match = readFileSync(ENV_PATH, 'utf8').match(/^INSTAGRAM_WEBHOOK_VERIFY_TOKEN=(.*)$/m);
  return match?.[1]?.trim() || undefined;
}

/** Writes PUBLIC_WEBHOOK_URL into .env, replacing any previous value. */
function persistPublicUrl(webhookUrl) {
  const line = `PUBLIC_WEBHOOK_URL=${webhookUrl}`;
  const current = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
  const next = /^PUBLIC_WEBHOOK_URL=.*$/m.test(current)
    ? current.replace(/^PUBLIC_WEBHOOK_URL=.*$/m, line)
    : `${current.endsWith('\n') || current === '' ? current : `${current}\n`}${line}\n`;
  writeFileSync(ENV_PATH, next);
}

/**
 * Runs Meta's own handshake against the public URL. Only an exact echo of a
 * fresh random challenge proves the tunnel lands on this machine.
 */
async function verify(webhookUrl, verifyToken) {
  if (!verifyToken)
    return { ok: false, retryable: false, reason: 'INSTAGRAM_WEBHOOK_VERIFY_TOKEN não está no .env' };
  const challenge = randomUUID();
  const url = new URL(webhookUrl);
  url.searchParams.set('hub.mode', 'subscribe');
  url.searchParams.set('hub.verify_token', verifyToken);
  url.searchParams.set('hub.challenge', challenge);
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const body = (await response.text()).trim();
    if (!response.ok) return { ok: false, retryable: true, reason: `respondeu HTTP ${response.status}` };
    if (body !== challenge)
      return { ok: false, retryable: true, reason: 'respondeu, mas não é o painel atendendo nessa URL' };
    return { ok: true };
  } catch (error) {
    return { ok: false, retryable: true, reason: error instanceof Error ? error.message : String(error) };
  }
}

async function panelIsUp() {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch {
    return false;
  }
}

if (!(await panelIsUp())) {
  log(`\nO painel não está respondendo em http://127.0.0.1:${PORT}.`);
  log('Suba ele primeiro com `pnpm dev` em outro terminal, depois rode este comando.\n');
  process.exit(1);
}

/**
 * A reserved ngrok domain is the whole point of this branch: it does not change
 * between runs, so the Callback URL is pasted into the Meta panel once and stays
 * correct forever. Without it we fall back to a Cloudflare quick tunnel, which
 * works but hands out a new hostname on every start.
 */
const ngrokDomain = process.env.NGROK_DOMAIN ?? readEnvValue('NGROK_DOMAIN');

const child = ngrokDomain
  ? spawn('ngrok', ['http', PORT, `--domain=${ngrokDomain}`, '--log=stdout'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: process.env,
    })
  : spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${PORT}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: process.env,
    });

log(
  ngrokDomain
    ? `Provedor: ngrok, domínio fixo ${ngrokDomain}.`
    : 'Provedor: Cloudflare quick tunnel (hostname novo a cada início).\n' +
      'Defina NGROK_DOMAIN no .env para um endereço que não muda.',
);

let announced = false;
let buffer = '';

/**
 * cloudflared's diagnostics are the only explanation available when the tunnel
 * comes up but nothing reaches it. Printing every line would bury the Callback
 * URL, so keep the recent ones and show them exactly when they matter.
 */
const recentOutput = [];
function remember(line) {
  recentOutput.push(line);
  if (recentOutput.length > 25) recentOutput.shift();
}
function dumpRecentOutput() {
  if (recentOutput.length === 0) return;
  log('  Últimas linhas do cloudflared:');
  for (const line of recentOutput) log(`    ${line}`);
  log('');
}

async function onCandidateUrl(base) {
  if (announced) return;
  announced = true;
  const webhookUrl = `${base}${WEBHOOK_PATH}`;

  // Record the new address before verifying, not after. The verification window
  // is up to a minute and a half; for all of it the watchdog would otherwise be
  // probing the previous, already-dead hostname written by the last run.
  persistPublicUrl(webhookUrl);

  // Cloudflare prints the hostname before the edge route is fully live, so a
  // single immediate probe reports a false failure. Wait on the clock rather
  // than on an attempt count: a DNS miss fails in milliseconds while a hanging
  // request burns 15s, so "10 tentativas" means anywhere from 20s to 3 minutes.
  const verifyToken = readVerifyToken();
  const deadline = Date.now() + VERIFY_WINDOW_MS;
  let result = { ok: false, retryable: true, reason: 'não verificado' };
  let attempt = 0;
  log(`Verificando se ${base} chega até esta máquina (até ${VERIFY_WINDOW_MS / 1000}s) ...`);
  do {
    attempt += 1;
    result = await verify(webhookUrl, verifyToken);
    if (result.ok || result.retryable === false) break;
    log(`  tentativa ${attempt}: ${result.reason}`);
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  } while (Date.now() < deadline);

  log('\n──────────────────────────────────────────────────────────────');
  if (result.ok) {
    log('  Túnel no ar e comprovado: o desafio voltou por esta URL.');
  } else {
    log(`  Túnel subiu, mas a verificação falhou após ${attempt} tentativa(s): ${result.reason}`);
    log('  A URL foi gravada mesmo assim; o watchdog vai continuar checando.');
    log('');
    dumpRecentOutput();
  }
  log('');
  log('  Cole esta Callback URL no painel da Meta:');
  log(`    ${webhookUrl}`);
  log('');
  log(`  Verify token: o valor de INSTAGRAM_WEBHOOK_VERIFY_TOKEN no .env`);
  log('');
  log('  Gravado em .env como PUBLIC_WEBHOOK_URL — o worker relê esse arquivo');
  log('  a cada verificação, sem precisar reiniciar, e vigia este endereço a');
  log('  cada 5 minutos: a primeira falha abre um aviso, a segunda seguida');
  log('  escala para alerta crítico.');
  log('');
  if (!ngrokDomain) {
    log('  Este endereço muda a cada início. Para parar de recolar a URL na');
    log('  Meta, reserve um domínio no ngrok e ponha NGROK_DOMAIN no .env.');
    log('');
  }
  log('  Mantenha este terminal aberto. Fechá-lo derruba o túnel.');
  log('──────────────────────────────────────────────────────────────\n');
}

function consume(chunk) {
  buffer += chunk.toString();
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) remember(trimmed);
    const match = line.match(URL_PATTERN);
    if (match) void onCandidateUrl(match[0]);
  }
}

child.stdout.on('data', consume);
child.stderr.on('data', consume);

// The hostname is reserved, so it needs no discovery — go straight to proving
// the tunnel actually carries traffic to this machine.
if (ngrokDomain) void onCandidateUrl(`https://${ngrokDomain}`);

child.on('exit', (code) => {
  log(`\ncloudflared encerrou com código ${code ?? 0}. A URL pública morreu.`);
  if (code) dumpRecentOutput();
  log('Rode `pnpm tunnel` de novo e cole a URL nova no painel da Meta.\n');
  process.exit(code ?? 0);
});

const stop = () => {
  if (!child.killed) child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 300);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

log(`\nSubindo o túnel para http://127.0.0.1:${PORT} ...\n`);
