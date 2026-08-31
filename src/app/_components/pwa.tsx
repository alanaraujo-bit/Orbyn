'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useOffline } from 'next/offline';

/**
 * The three behaviours that separate an installed app from a browser tab:
 * it registers its service worker, it says so when the network is gone, and it
 * refreshes itself when you bring it back to the foreground.
 */

/** Below this, a backgrounded app is treated as still current on return. */
const STALE_AFTER_MS = 30_000;

export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    // Registration is best-effort: over plain HTTP (a LAN address, say) it
    // rejects, and the panel must keep working exactly as before.
    void navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch(() => undefined);
  }, []);

  return null;
}

/**
 * Re-fetches the current screen when the app comes back to the foreground.
 *
 * Every page is `force-dynamic`, so what is on screen is only ever a snapshot
 * of the moment it loaded. Reopening the app from the home screen does not
 * remount anything — without this, the operator is looking at numbers from
 * whenever they last had it open, with nothing saying so.
 */
export function ForegroundRefresh() {
  const router = useRouter();
  const hiddenSince = useRef<number | null>(null);

  useEffect(() => {
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') {
        hiddenSince.current = Date.now();
        return;
      }
      const since = hiddenSince.current;
      hiddenSince.current = null;
      if (since !== null && Date.now() - since >= STALE_AFTER_MS) router.refresh();
    };

    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [router]);

  return null;
}

/**
 * A banner while the connection is down.
 *
 * With `experimental.useOffline` on, a navigation or Server Action fired while
 * offline does not fail — Next holds it and retries on reconnect. That is the
 * right behaviour but an invisible one: the screen just sits in its loading
 * state. This is what tells the operator the wait is the network, not the work.
 */
export function OfflineBanner() {
  const isOffline = useOffline();
  const [wasOffline, setWasOffline] = useState(isOffline);
  const [reconnected, setReconnected] = useState(false);

  // Derived during render rather than in an effect: the "connection is back"
  // note exists only because connectivity just changed, so it belongs to the
  // same render as the change instead of a second pass after it.
  if (wasOffline !== isOffline) {
    setWasOffline(isOffline);
    setReconnected(wasOffline && !isOffline);
  }

  useEffect(() => {
    if (!reconnected) return;
    const timer = setTimeout(() => setReconnected(false), 2500);
    return () => clearTimeout(timer);
  }, [reconnected]);

  if (!isOffline && !reconnected) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={`sticky top-0 z-30 px-4 py-1.5 text-center text-[12px] font-medium ${
        isOffline ? 'bg-warning-soft text-warning' : 'bg-positive-soft text-positive'
      }`}
    >
      {isOffline ? 'Sem conexão — as ações ficam pendentes e seguem sozinhas quando a rede voltar.' : 'Conexão restabelecida.'}
    </div>
  );
}
