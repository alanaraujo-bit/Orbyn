import { NextResponse } from 'next/server';
import { PANEL_COOKIE } from '@/lib/panel-auth';

export async function POST(): Promise<Response> {
  // Relative, for the same reason as the sign-in route: behind the tunnel an
  // absolute redirect built from the request would point at localhost.
  const response = new NextResponse(null, { status: 303, headers: { location: '/entrar' } });
  response.cookies.set(PANEL_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 });
  return response;
}
