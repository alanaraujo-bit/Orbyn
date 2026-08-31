import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as login } from '@/app/api/auth/login/route';
import { POST as logout } from '@/app/api/auth/logout/route';
import { proxy } from '@/proxy';
import { PANEL_COOKIE, sessionToken } from '@/lib/panel-auth';

/**
 * Redirects must never carry the panel's own address.
 *
 * `pnpm tunnel` publishes the panel at a public HTTPS hostname while the server
 * still sees `http://localhost:4310`. Any redirect built from the incoming
 * request therefore names localhost, and a phone following it from an HTTPS page
 * gets ERR_SSL_PROTOCOL_ERROR — signed in, but staring at an error page. These
 * tests pin the relative Location that makes both paths work.
 */

const PASSWORD = 'senha-de-teste';

/** How the request looks to the app when a tunnel forwards it. */
const TUNNELED = 'http://localhost:4310';

beforeEach(() => {
  process.env.PANEL_PASSWORD = PASSWORD;
});

afterEach(() => {
  delete process.env.PANEL_PASSWORD;
  delete process.env.PUBLIC_WEBHOOK_URL;
});

function loginRequest(body: Record<string, string>, headers: Record<string, string> = {}): Request {
  const form = new FormData();
  for (const [key, value] of Object.entries(body)) form.append(key, value);
  return new Request(`${TUNNELED}/api/auth/login`, { method: 'POST', body: form, headers });
}

function locationOf(response: Response): string {
  return response.headers.get('location') ?? '';
}

describe('redirecionamentos do painel atrás do túnel', () => {
  it('manda o acesso não autenticado para o login', async () => {
    const response = await proxy(new NextRequest(`${TUNNELED}/clientes`));
    expect(response.status).toBe(307);
    expect(new URL(locationOf(response)).pathname).toBe('/entrar');
  });

  it('preserva o destino pretendido, com escape', async () => {
    const response = await proxy(new NextRequest(`${TUNNELED}/leads/lead_1?aba=conversa`));
    const location = new URL(locationOf(response));
    expect(location.pathname).toBe('/entrar');
    expect(location.searchParams.get('destino')).toBe('/leads/lead_1?aba=conversa');
  });

  it('redireciona para o endereço público que o navegador usou, não para o local', async () => {
    process.env.PUBLIC_WEBHOOK_URL = 'https://tunel.exemplo.dev/api/webhooks/instagram';
    const request = new NextRequest(`${TUNNELED}/clientes`, {
      headers: { 'x-forwarded-host': 'tunel.exemplo.dev', 'x-forwarded-proto': 'https' },
    });
    const location = new URL(locationOf(await proxy(request)));
    expect(location.origin).toBe('https://tunel.exemplo.dev');
    expect(location.host).not.toContain('localhost');
  });

  it('ignora host encaminhado que não seja o do túnel, para não virar redirect aberto', async () => {
    process.env.PUBLIC_WEBHOOK_URL = 'https://tunel.exemplo.dev/api/webhooks/instagram';
    const request = new NextRequest(`${TUNNELED}/clientes`, {
      headers: { 'x-forwarded-host': 'atacante.exemplo', 'x-forwarded-proto': 'https' },
    });
    const location = new URL(locationOf(await proxy(request)));
    expect(location.host).toBe('localhost:4310');
  });

  it('sem endereço público configurado, fica no próprio host', async () => {
    delete process.env.PUBLIC_WEBHOOK_URL;
    const request = new NextRequest(`${TUNNELED}/clientes`, { headers: { 'x-forwarded-host': 'atacante.exemplo' } });
    expect(new URL(locationOf(await proxy(request))).host).toBe('localhost:4310');
  });

  it('deixa passar o que precisa responder sem login', async () => {
    for (const path of ['/entrar', '/api/health', '/api/webhooks/instagram', '/manifest.webmanifest', '/sw.js', '/icons/icon-192.png']) {
      const response = await proxy(new NextRequest(`${TUNNELED}${path}`));
      expect(locationOf(response), `${path} deveria passar`).toBe('');
    }
  });

  it('não deixa passar quem já está autenticado por engano', async () => {
    const request = new NextRequest(`${TUNNELED}/clientes`);
    request.cookies.set(PANEL_COOKIE, await sessionToken(PASSWORD));
    const response = await proxy(request);
    expect(locationOf(response)).toBe('');
  });

  it('senha correta entra com Location relativo e cookie de sessão', async () => {
    const response = await login(loginRequest({ senha: PASSWORD, destino: '/alertas' }));
    expect(response.status).toBe(303);
    expect(locationOf(response)).toBe('/alertas');
    expect(response.headers.get('set-cookie')).toContain(PANEL_COOKIE);
  });

  it('senha errada volta ao login sem cookie', async () => {
    const response = await login(loginRequest({ senha: 'errada' }));
    expect(locationOf(response)).toBe('/entrar?erro=invalida');
    expect(response.headers.get('set-cookie') ?? '').not.toContain(await sessionToken(PASSWORD));
  });

  it('recusa destino externo, para não virar redirect aberto', async () => {
    for (const destino of ['https://exemplo.com/phish', '//exemplo.com/phish']) {
      const response = await login(loginRequest({ senha: PASSWORD, destino }));
      expect(locationOf(response)).toBe('/');
    }
  });

  it('marca o cookie como Secure quando o túnel diz que a conexão é HTTPS', async () => {
    const response = await login(loginRequest({ senha: PASSWORD }, { 'x-forwarded-proto': 'https' }));
    expect(response.headers.get('set-cookie')).toContain('Secure');
  });

  it('não marca Secure em acesso local por HTTP, que não aceitaria o cookie', async () => {
    const response = await login(loginRequest({ senha: PASSWORD }));
    expect(response.headers.get('set-cookie')).not.toContain('Secure');
  });

  it('sair volta ao login e apaga o cookie', async () => {
    const response = await logout();
    expect(locationOf(response)).toBe('/entrar');
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });
});
