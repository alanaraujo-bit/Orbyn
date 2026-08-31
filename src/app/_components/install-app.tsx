'use client';

import { useState, useSyncExternalStore } from 'react';
import { Icon } from './icons';

/**
 * Installing the panel as an app, offered by the panel itself.
 *
 * The browser's own "install app" menu item is buried, and on iOS there is no
 * menu item at all — only a share-sheet action nobody finds by accident. So the
 * offer is made here.
 *
 * Chrome and the other Chromium browsers announce installability by firing
 * `beforeinstallprompt`, and that event is the only way to open the install
 * dialog: it cannot be summoned on demand later. It also fires around page
 * load, often before React has hydrated, so a `useEffect` listener misses it
 * outright. The inline script in the root layout catches it first and parks it
 * on `window`; everything here reads from there.
 *
 * Safari fires nothing and exposes no API, so iOS gets instructions instead of
 * a button — and other engines can install perfectly well while never firing
 * the event either, so a handheld that gets no event still gets instructions
 * rather than nothing. That is why this is three paths and not one.
 */

/** Set by the capture script in the root layout. */
declare global {
  interface Window {
    __orbynInstallPrompt?: BeforeInstallPromptEvent | null;
  }
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/** Name of the event the capture script and this module use to sync up. */
export const INSTALL_EVENT = 'orbyn:install-state';

const DISMISS_KEY = 'orbyn.install-banner-dismissed';

type Mode = 'none' | 'prompt' | 'ios' | 'manual';

function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // Safari's own, pre-standard flag; it never adopted `display-mode`.
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function isIOS(): boolean {
  const ua = navigator.userAgent;
  // An iPad on iPadOS 13+ claims to be a Mac; the touch points give it away.
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/** A phone or tablet: where installing is the point, whatever the engine. */
function isHandheld(): boolean {
  return window.matchMedia('(pointer: coarse)').matches && window.innerWidth < 900;
}

function dismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    // Private mode, or site data blocked. Not remembering is the safe failure.
    return false;
  }
}

/*
 * One external store for both pieces of UI. The snapshot has to be a stable
 * primitive — React compares it by identity on every render — so it is encoded
 * as a string and split by the hook below.
 */
function subscribe(onChange: () => void): () => void {
  const media = window.matchMedia('(display-mode: standalone)');
  window.addEventListener(INSTALL_EVENT, onChange);
  window.addEventListener('appinstalled', onChange);
  media.addEventListener('change', onChange);
  return () => {
    window.removeEventListener(INSTALL_EVENT, onChange);
    window.removeEventListener('appinstalled', onChange);
    media.removeEventListener('change', onChange);
  };
}

function getSnapshot(): string {
  if (isStandalone()) return 'none:1';
  /*
   * The order matters. A live prompt event is the best outcome and beats
   * everything. Failing that, a handheld still gets the offer with manual
   * steps: plenty of browsers install fine but never fire the event — Brave and
   * Firefox among them — and a tunnel or proxy that mangles the manifest kills
   * the event too. Vanishing entirely in those cases is the one behaviour that
   * leaves the operator with no way in at all.
   */
  const mode: Mode = window.__orbynInstallPrompt ? 'prompt' : isIOS() ? 'ios' : isHandheld() ? 'manual' : 'none';
  return `${mode}:${dismissed() ? '1' : '0'}`;
}

/** The server renders nothing: installability is a property of the device. */
function getServerSnapshot(): string {
  return 'none:0';
}

function useInstallState(): { mode: Mode; bannerDismissed: boolean } {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [mode, flag] = snapshot.split(':');
  return { mode: (mode ?? 'none') as Mode, bannerDismissed: flag === '1' };
}

function announce(): void {
  window.dispatchEvent(new Event(INSTALL_EVENT));
}

async function runInstall(): Promise<void> {
  const event = window.__orbynInstallPrompt;
  if (!event) return;

  /*
   * The event is spent the moment `prompt()` is called — a second call throws
   * InvalidStateError — so the offer retires here, on the call, and not on the
   * answer. Waiting for `userChoice` first would leave the button live but
   * inert for as long as the dialog is open, and permanently so if that promise
   * never settles. Declining the dialog therefore hides the offer until the
   * next page load, which is when Chrome hands the event over again.
   */
  window.__orbynInstallPrompt = null;
  announce();
  try {
    await event.prompt();
  } catch {
    // Already used, or the browser refused to show it. Nothing left to do.
  }
}

/** The route through the browser's own menu, for engines with no prompt event. */
function ManualSteps() {
  return (
    <ol className="mt-2 flex flex-col gap-1.5 text-[12.5px] leading-5 text-ink-muted">
      <li className="flex items-start gap-2">
        <span aria-hidden className="num shrink-0 text-ink-faint">
          1.
        </span>
        <span>
          Abra o menu do navegador <strong className="font-medium text-ink">⋮</strong> no canto da tela.
        </span>
      </li>
      <li className="flex items-start gap-2">
        <span aria-hidden className="num shrink-0 text-ink-faint">
          2.
        </span>
        <span>
          Toque em <strong className="font-medium text-ink">Instalar aplicativo</strong> — em alguns navegadores aparece
          como <strong className="font-medium text-ink">Adicionar à tela inicial</strong>.
        </span>
      </li>
      <li className="flex items-start gap-2">
        <span aria-hidden className="num shrink-0 text-ink-faint">
          3.
        </span>
        <span>Confirme. O ícone do Orbyn aparece junto dos seus apps.</span>
      </li>
    </ol>
  );
}

function IosSteps() {
  return (
    <ol className="mt-2 flex flex-col gap-1.5 text-[12.5px] leading-5 text-ink-muted">
      <li className="flex items-start gap-2">
        <span aria-hidden className="num shrink-0 text-ink-faint">
          1.
        </span>
        <span className="flex flex-wrap items-center gap-1">
          Toque em compartilhar
          <Icon name="share-ios" className="inline-block size-4 align-text-bottom text-accent-ink" />
          na barra do Safari.
        </span>
      </li>
      <li className="flex items-start gap-2">
        <span aria-hidden className="num shrink-0 text-ink-faint">
          2.
        </span>
        <span>
          Escolha <strong className="font-medium text-ink">Adicionar à Tela de Início</strong>.
        </span>
      </li>
      <li className="flex items-start gap-2">
        <span aria-hidden className="num shrink-0 text-ink-faint">
          3.
        </span>
        <span>Confirme em Adicionar. O ícone do Orbyn aparece junto dos seus apps.</span>
      </li>
    </ol>
  );
}

/**
 * The offer, shown once at the top of the panel until it is taken or dismissed.
 */
export function InstallBanner() {
  const { mode, bannerDismissed } = useInstallState();
  const [showSteps, setShowSteps] = useState(false);

  if (mode === 'none' || bannerDismissed) return null;

  const dismiss = (): void => {
    try {
      window.localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // Nothing to do: the banner simply comes back next time.
    }
    announce();
  };

  return (
    <div className="border-b border-line bg-accent-soft/60 px-4 py-2.5 md:px-6">
      <div className="mx-auto flex max-w-[1240px] flex-wrap items-center gap-x-3 gap-y-2">
        <Icon name="install" className="size-5 shrink-0 text-accent-ink" />
        <p className="min-w-0 flex-1 text-[12.5px] leading-5 text-ink">
          <span className="font-medium">Instale o Orbyn</span> — abre em tela cheia, com ícone próprio.
        </p>

        {mode === 'prompt' ? (
          <button
            type="button"
            onClick={() => void runInstall()}
            className="min-h-11 shrink-0 rounded-md bg-accent px-3.5 text-[12.5px] font-medium text-white active:opacity-90 md:min-h-9"
          >
            Instalar
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setShowSteps((open) => !open)}
            aria-expanded={showSteps}
            className="min-h-11 shrink-0 rounded-md bg-accent px-3.5 text-[12.5px] font-medium text-white active:opacity-90 md:min-h-9"
          >
            {showSteps ? 'Fechar' : 'Como instalar'}
          </button>
        )}

        <button
          type="button"
          onClick={dismiss}
          aria-label="Dispensar"
          className="grid size-11 shrink-0 place-items-center rounded-md text-ink-muted active:bg-surface-muted md:size-9"
        >
          <span aria-hidden className="text-[18px] leading-none">
            ×
          </span>
        </button>

        {showSteps ? <div className="w-full">{mode === 'ios' ? <IosSteps /> : <ManualSteps />}</div> : null}
      </div>
    </div>
  );
}

/**
 * The same offer as a row in the "Mais" sheet — the place to find it again
 * after the banner has been dismissed.
 */
export function InstallSheetRow() {
  const { mode } = useInstallState();
  const [showSteps, setShowSteps] = useState(false);

  if (mode === 'none') return null;

  return (
    <div className="border-t border-line px-4 py-3">
      <button
        type="button"
        onClick={() => (mode === 'prompt' ? void runInstall() : setShowSteps((open) => !open))}
        aria-expanded={mode === 'prompt' ? undefined : showSteps}
        className="flex min-h-12 w-full items-center gap-3 rounded-lg bg-accent-soft px-3 text-[14px] font-medium text-accent-ink active:opacity-90"
      >
        <Icon name="install" className="size-5 shrink-0" />
        <span className="flex-1 text-left">Instalar como aplicativo</span>
      </button>
      {mode !== 'prompt' && showSteps ? mode === 'ios' ? <IosSteps /> : <ManualSteps /> : null}
    </div>
  );
}
