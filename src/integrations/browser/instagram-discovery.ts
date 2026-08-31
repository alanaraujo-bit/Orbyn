import type { Page } from 'playwright-core';
import { AppError } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { randomIntBetween } from '@/lib/time';
import { sleep } from '@/lib/sleep';
import { normalizeHandle, profileUrl } from '@/features/leads/handle';
import { connectToChrome, disconnect, withAgentPage } from './cdp';
import { parseCanonicalBio, parsePostCaptions, parsePostHashtags, parseProfileHeader } from './profile-header';
import { detectSafetySignal } from './safety';

const log = createLogger('browser.discovery');

/**
 * Public-profile discovery through the operator's own logged-in Chrome.
 *
 * Only fields that Instagram renders publicly on the profile page are read, and
 * only the ones the ICP scoring actually needs. No private endpoint is called
 * and no hidden data is inferred.
 */

export interface PublicProfileRead {
  handle: string;
  displayName: string | null;
  bio: string | null;
  category: string | null;
  externalUrl: string | null;
  followersCount: number | null;
  isBusinessAccount: boolean | null;
  /** Captions the account wrote on its own recent posts. */
  postCaptions: string[];
  postHashtags: string[];
  provenance: Record<string, string>;
}

const HANDLE_LINK = /^https:\/\/www\.instagram\.com\/([A-Za-z0-9._]{1,30})\/?$/;
const RESERVED_PATHS = new Set(['explore', 'direct', 'accounts', 'reels', 'stories', 'p', 'about', 'legal']);

async function bodyText(page: Page): Promise<string> {
  try {
    return (await page.locator('body').innerText({ timeout: 5_000 })).slice(0, 20_000);
  } catch {
    return '';
  }
}

async function guardSafety(page: Page): Promise<void> {
  const detection = detectSafetySignal(page.url(), await bodyText(page));
  if (!detection) return;
  throw new AppError('account_safety_signal', `Sinal de segurança detectado durante a descoberta: ${detection.signal}.`, {
    details: { signal: detection.signal, evidence: detection.evidence },
  });
}

/**
 * Reads a follower count out of Instagram's meta description.
 *
 * Two conventions live in the same string and mean opposite things:
 * "3,656 seguidores" groups thousands with a comma, while "16,5 mil" uses the
 * comma as a decimal point. Reading the first as Brazilian formatting turned
 * 3656 followers into 4 - quietly corrupting every size-based ICP signal.
 *
 * The suffix disambiguates: with one, a comma is decimal; without one, it
 * only groups. Anchoring on the "seguidores"/"followers" label also keeps the
 * post and following counts in the same string from being read instead.
 */
export function parseCompactCount(raw: string): number | null {
  const text = raw.trim();
  const labelled = /([\d.,]+)\s*(mil|k|mi|m)?\s*(seguidores|followers)/i.exec(text);
  const match = labelled ?? /([\d.,]+)\s*(mil|k|mi|m)?/i.exec(text);
  if (!match?.[1]) return null;

  const suffix = match[2]?.toLowerCase();
  const normalized = suffix
    ? match[1].replace(',', '.') // compact: the separator is a decimal point
    : match[1].replace(/[.,]/g, ''); // plain: separators only group thousands

  const digits = Number(normalized);
  if (Number.isNaN(digits)) return null;
  if (suffix === 'mil' || suffix === 'k') return Math.round(digits * 1_000);
  if (suffix === 'mi' || suffix === 'm') return Math.round(digits * 1_000_000);
  return Math.round(digits);
}

/** Reads one public profile page. */
export async function readPublicProfile(handle: string): Promise<PublicProfileRead | null> {
  const session = await connectToChrome();
  try {
    return await withAgentPage(session, async (page) => {
      page.setDefaultTimeout(12_000);
      await page.goto(profileUrl(handle), { waitUntil: 'domcontentloaded' });
      await sleep(randomIntBetween(800, 1_800));
      await guardSafety(page);

      const text = await bodyText(page);
      if (/esta p[áa]gina n[ãa]o est[áa] dispon[íi]vel|sorry, this page isn'?t available/i.test(text)) return null;

      const title = await page.title();
      const displayName = /^(.*?)\s*\(@/.exec(title)?.[1]?.trim() ?? null;

      const description = await page
        .locator('meta[name="description"]')
        .getAttribute('content', { timeout: 3_000 })
        .catch(() => null);

      const followersCount = description ? parseCompactCount(description) : null;

      const header = page.locator('header');
      const headerText = await header.innerText({ timeout: 5_000 }).catch(() => '');

      const externalUrl = await header
        .locator('a[href^="http"]:not([href*="instagram.com"])')
        .first()
        .getAttribute('href', { timeout: 3_000 })
        .catch(() => null);

      const header_ = parseProfileHeader(headerText, { handle, displayName });
      // Prefer what Instagram publishes over what the page happens to render.
      const bio = parseCanonicalBio(description) ?? header_.bio;
      const category = header_.category;

      // What the account itself has been posting about. This is the evidence
      // that lets the system say it knows a business before writing to it, and
      // it was never collected: `postCaptions` and `postHashtags` were read by
      // scoring, by the opener prompt and by the content policy, while nothing
      // anywhere wrote them - every lead was judged on a profile header alone.
      const alts = await page
        .locator('main a[href*="/p/"] img, main a[href*="/reel/"] img')
        .evaluateAll((nodes) => nodes.slice(0, 12).map((node) => (node as HTMLImageElement).alt ?? ''))
        .catch(() => [] as string[]);
      const postCaptions = parsePostCaptions(alts);
      const postHashtags = parsePostHashtags(postCaptions);

      return {
        handle: normalizeHandle(handle),
        displayName,
        bio,
        category,
        externalUrl,
        followersCount,
        postCaptions,
        postHashtags,
        // Not derivable from the header text. This used to be `category !== null`,
        // which really meant "the header contained a short line" - true for every
        // profile, so every lead counted as a business account and collected the
        // score and the persona that come with it.
        isBusinessAccount: null,
        provenance: {
          displayName: 'instagram_profile_title',
          bio: description ? 'instagram_meta_description' : 'instagram_profile_header',
          postCaptions: 'instagram_profile_grid_alt',
          followersCount: 'instagram_profile_meta_description',
          externalUrl: 'instagram_profile_header_link',
        },
      } satisfies PublicProfileRead;
    });
  } finally {
    await disconnect(session);
  }
}

/**
 * Runs Instagram's own public search for a keyword and returns the handles it
 * rendered. Uses the accessible search box rather than a private endpoint.
 */
export async function searchPublicProfiles(keyword: string, limit: number): Promise<string[]> {
  const session = await connectToChrome();
  try {
    return await withAgentPage(session, async (page) => {
      page.setDefaultTimeout(12_000);
      await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded' });
      await sleep(randomIntBetween(1_000, 2_200));
      await guardSafety(page);

      // Instagram renders the nav item as icon label + visible text, so its
      // accessible name comes out doubled ("PesquisaPesquisa"). An anchored
      // /^pesquisa$/ never matches it, which is how this whole path used to fail
      // on the first step while blaming the second.
      const searchTrigger = page.getByRole('link', { name: /pesquisa|search/i }).first();
      if ((await searchTrigger.count()) === 0) {
        throw new AppError('browser_action_failed', 'Item "Pesquisa" não encontrado na navegação do Instagram.', {
          retryable: true,
        });
      }
      await searchTrigger.click();

      // The search field does not exist until the panel slides open: waiting for
      // it is the difference between a real failure and simply being early.
      const searchBox = page.getByRole('textbox', { name: /pesquis|search/i }).first();
      try {
        await searchBox.waitFor({ state: 'visible', timeout: 10_000 });
      } catch {
        throw new AppError('browser_action_failed', 'Campo de busca do Instagram não apareceu após abrir o painel.', {
          retryable: true,
        });
      }

      // Clicking is refused here: while the panel animates, an overlay div sits
      // on top of the field and intercepts pointer events. Focus needs no
      // pointer, and the humanised typing below is what matters anyway.
      await searchBox.focus();
      await page.keyboard.type(keyword, { delay: randomIntBetween(30, 90) });
      await sleep(randomIntBetween(1_600, 2_800));
      await guardSafety(page);

      const hrefs = await page.locator('a[href^="/"]').evaluateAll((nodes) =>
        nodes.map((node) => (node as HTMLAnchorElement).href).filter((href) => typeof href === 'string'),
      );

      const handles: string[] = [];
      for (const href of hrefs) {
        const match = HANDLE_LINK.exec(href);
        const candidate = match?.[1];
        if (!candidate || RESERVED_PATHS.has(candidate.toLowerCase())) continue;
        const normalized = candidate.toLowerCase();
        if (!handles.includes(normalized)) handles.push(normalized);
        if (handles.length >= limit) break;
      }

      log.info('discovery search finished', { keyword, found: handles.length });
      return handles;
    });
  } finally {
    await disconnect(session);
  }
}
