import type { Metadata, Viewport } from 'next';
import Script from 'next/script';
import { cookies } from 'next/headers';
import { and, eq } from 'drizzle-orm';
import './globals.css';
import { PANEL_COOKIE, safeEqual, sessionToken } from '@/lib/panel-auth';
import { getDb } from '@/db/client';
import { alerts } from '@/db/schema';
import { getBusinessConfig } from '@/config/business';
import { capabilityReport } from '@/features/system/capabilities';
import { ensureDefaultExperiments } from '@/features/experiments/seed';
import { verifyConfigIntegrity } from '@/features/system/config-integrity';
import { Nav } from './_components/nav';
import { MobileNav, type MobileNavLink } from './_components/mobile-nav';
import { GlobalPause } from './_components/global-pause';
import { ForegroundRefresh, OfflineBanner, ServiceWorkerRegistration } from './_components/pwa';
import { InstallBanner, InstallSheetRow } from './_components/install-app';
import { Dot } from './_components/ui';

export const metadata: Metadata = {
  title: 'Orbyn — Prospecção no Instagram',
  description: 'Painel operacional de prospecção autônoma no Instagram.',
  applicationName: 'Orbyn',
  // Installed on iOS this is what removes the browser chrome and names the
  // icon; Safari reads none of it from the manifest.
  appleWebApp: { capable: true, title: 'Orbyn', statusBarStyle: 'default' },
  icons: {
    icon: [
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Pinch and double-tap zoom are off at the operator's request: having to zoom
  // to read a panel is the tell of a web page rather than an app. The trade is
  // that nothing may be too small to read at 1x, so body text on a phone is
  // sized up to compensate instead of keeping desktop density. (iOS Safari
  // honours this for double-tap only; it has ignored `user-scalable=no` for
  // pinch since iOS 10, which is the accessibility escape hatch.)
  maximumScale: 1,
  userScalable: false,
  // Lets the layout run under the notch and the home indicator, which is what
  // the `env(safe-area-inset-*)` padding throughout the shell then reclaims.
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#23262a' },
  ],
};

export const dynamic = 'force-dynamic';

/**
 * The sign-in page is the one route the proxy lets through, so the shell around
 * it must not give anything away: the company name, the open-alert count and the
 * capability list are all operational detail. Unauthenticated requests get a
 * bare page, and none of the database work below runs for them.
 */
async function isSignedIn(): Promise<boolean> {
  const password = process.env.PANEL_PASSWORD?.trim();
  if (!password) return false;
  const cookie = (await cookies()).get(PANEL_COOKIE)?.value;
  return Boolean(cookie && safeEqual(cookie, await sessionToken(password)));
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  if (!(await isSignedIn())) {
    return (
      <html lang="pt-BR">
        <body className="min-h-screen">
          {/* React hoists this into <head>. See the note above about credentials. */}
          <link rel="manifest" href="/manifest.webmanifest" crossOrigin="use-credentials" />
          {children}
          <Script id="orbyn-install-capture" strategy="beforeInteractive">
            {`window.__orbynInstallPrompt=null;addEventListener('beforeinstallprompt',function(e){e.preventDefault();window.__orbynInstallPrompt=e;dispatchEvent(new Event('orbyn:install-state'))});addEventListener('appinstalled',function(){window.__orbynInstallPrompt=null})`}
          </Script>
          <ServiceWorkerRegistration />
        </body>
      </html>
    );
  }

  const db = getDb();
  ensureDefaultExperiments(db);
  verifyConfigIntegrity(db);

  const config = getBusinessConfig();
  const capabilities = capabilityReport(db);
  const openAlerts = db.select({ id: alerts.id }).from(alerts).where(eq(alerts.status, 'open')).all().length;
  const criticalAlerts = db
    .select({ id: alerts.id })
    .from(alerts)
    .where(and(eq(alerts.status, 'open'), eq(alerts.severity, 'critical')))
    .all().length;

  const globalPaused = capabilities.find((entry) => entry.id === 'global')?.paused ?? false;
  const degraded = capabilities.filter((entry) => !entry.usable);

  /** Status rail, shared by the desktop sidebar and the mobile sheet. */
  const capabilityList = (
    <ul className="flex flex-col gap-1">
      {capabilities
        .filter((entry) => entry.id !== 'global')
        .map((entry) => (
          <li key={entry.id} className="flex items-center gap-2 px-1 py-0.5 text-[11.5px] text-ink-faint">
            <Dot tone={entry.usable ? 'positive' : entry.paused ? 'danger' : 'warning'} />
            <span className="truncate">{CAPABILITY_SHORT[entry.id] ?? entry.id}</span>
          </li>
        ))}
    </ul>
  );

  /** The four screens worth a thumb tap; the rest sit behind "Mais". */
  const tabs: MobileNavLink[] = [
    { href: '/', label: 'Visão geral', icon: 'overview' },
    { href: '/clientes', label: 'Clientes', icon: 'customers' },
    { href: '/alertas', label: 'Alertas', icon: 'alerts', badge: openAlerts },
    { href: '/jobs', label: 'Jobs', icon: 'jobs' },
  ];

  const moreLinks: MobileNavLink[] = [
    { href: '/afiliados', label: 'Funil de afiliados', icon: 'affiliates' },
    { href: '/experimentos', label: 'Experimentos', icon: 'experiments' },
    { href: '/decisoes', label: 'Decisões da IA', icon: 'decisions' },
    { href: '/custos', label: 'Custo de IA', icon: 'costs' },
    { href: '/configuracoes', label: 'Configurações', icon: 'settings' },
  ];

  return (
    <html lang="pt-BR">
      <body className="min-h-screen">
      {/* React hoists this into <head>. See the note above about credentials. */}
      <link rel="manifest" href="/manifest.webmanifest" crossOrigin="use-credentials" />
        <div className="flex min-h-screen">
          <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-line bg-surface md:flex">
            <div className="flex items-center gap-2.5 border-b border-line px-4 py-3.5">
              <span aria-hidden className="grid size-7 place-items-center rounded-md bg-accent text-[13px] font-bold text-white">
                O
              </span>
              <div className="min-w-0">
                <p className="truncate text-[13px] font-semibold text-ink">Orbyn</p>
                <p className="truncate text-[11px] text-ink-faint">{config.company.name}</p>
              </div>
            </div>

            <div className="scroll-slim flex-1 overflow-y-auto">
              <Nav
                groups={[
                  {
                    title: 'Operação',
                    items: [
                      { href: '/', label: 'Visão geral' },
                      { href: '/clientes', label: 'Funil de clientes' },
                      { href: '/afiliados', label: 'Funil de afiliados' },
                      { href: '/alertas', label: 'Alertas e exceções', badge: openAlerts },
                    ],
                  },
                  {
                    title: 'Inteligência',
                    items: [
                      { href: '/experimentos', label: 'Experimentos' },
                      { href: '/decisoes', label: 'Decisões da IA' },
                      { href: '/custos', label: 'Custo de IA' },
                    ],
                  },
                  {
                    title: 'Sistema',
                    items: [
                      { href: '/jobs', label: 'Fila de jobs' },
                      { href: '/configuracoes', label: 'Configurações' },
                    ],
                  },
                ]}
              />
            </div>

            <div className="border-t border-line px-3 py-3">
              <GlobalPause paused={globalPaused} />
              <div className="mt-3">{capabilityList}</div>
            </div>
          </aside>

          <div className="min-w-0 flex-1">
            {/* Phone header. Compact on purpose: the tab bar carries navigation,
                so this only has to say where you are and show the master state. */}
            <header className="sticky top-0 z-30 flex items-center gap-2.5 border-b border-line bg-surface/95 px-4 py-2.5 pt-[max(0.625rem,env(safe-area-inset-top))] backdrop-blur md:hidden">
              <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-md bg-accent text-[13px] font-bold text-white">
                O
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] leading-tight font-semibold text-ink">Orbyn</p>
                <p className="truncate text-[11px] leading-tight text-ink-faint">{config.company.name}</p>
              </div>
              {globalPaused ? (
                <span className="shrink-0 rounded-full bg-danger-soft px-2 py-1 text-[11px] font-semibold text-danger">
                  Pausado
                </span>
              ) : null}
            </header>

            <OfflineBanner />
            <InstallBanner />

            {globalPaused ? (
              <div role="status" className="border-b border-danger/30 bg-danger-soft px-4 py-2 text-[12.5px] text-danger md:px-6">
                Operação pausada. Nenhuma abordagem, resposta automática ou descoberta será executada.
              </div>
            ) : null}
            {criticalAlerts > 0 && !globalPaused ? (
              <div role="status" className="border-b border-warning/30 bg-warning-soft px-4 py-2 text-[12.5px] text-warning md:px-6">
                {criticalAlerts === 1
                  ? '1 alerta crítico aberto exige atenção.'
                  : `${criticalAlerts} alertas críticos abertos exigem atenção.`}
              </div>
            ) : null}
            {degraded.length > 0 && !globalPaused ? (
              <div className="border-b border-line bg-surface-muted px-4 py-2 text-[12px] text-ink-muted md:px-6">
                Capacidades indisponíveis: {degraded.map((entry) => CAPABILITY_SHORT[entry.id] ?? entry.id).join(', ')}.
              </div>
            ) : null}

            {/* The bottom padding clears the fixed tab bar and the home indicator. */}
            <main className="mx-auto max-w-[1240px] px-4 py-4 pb-[calc(4.5rem+env(safe-area-inset-bottom))] md:px-6 md:py-6 md:pb-6">
              {children}
            </main>
          </div>
        </div>

        <MobileNav
          tabs={tabs}
          moreLinks={moreLinks}
          pauseControl={<GlobalPause paused={globalPaused} />}
          capabilities={capabilityList}
          install={<InstallSheetRow />}
        />

        <Script id="orbyn-install-capture" strategy="beforeInteractive">
          {`window.__orbynInstallPrompt=null;addEventListener('beforeinstallprompt',function(e){e.preventDefault();window.__orbynInstallPrompt=e;dispatchEvent(new Event('orbyn:install-state'))});addEventListener('appinstalled',function(){window.__orbynInstallPrompt=null})`}
        </Script>
        <ServiceWorkerRegistration />
        <ForegroundRefresh />
      </body>
    </html>
  );
}

const CAPABILITY_SHORT: Record<string, string> = {
  discovery: 'Descoberta',
  browser_outreach: 'Navegador',
  api_messaging: 'API oficial',
  ai_engine: 'IA',
  customer_funnel: 'Funil clientes',
  affiliate_funnel: 'Funil afiliados',
};
