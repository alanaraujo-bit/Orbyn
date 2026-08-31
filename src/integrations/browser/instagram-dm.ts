import type { Page } from 'playwright-core';
import { AppError } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { randomIntBetween } from '@/lib/time';
import { sleep } from '@/lib/sleep';
import { profileUrl } from '@/features/leads/handle';
import { connectToChrome, disconnect, withAgentPage, type PageDiagnostics } from './cdp';
import { captureEvidence } from './artifacts';
import { detectSafetySignal } from './safety';
import type { DmDriver, SendDmCommand, SendDmResult } from './types';

const log = createLogger('browser.dm');

/**
 * Real Instagram DM driver.
 *
 * Element lookup goes through accessible roles and names rather than CSS
 * classes, because Instagram's generated class names change constantly while
 * the accessible names are comparatively stable.
 */

const NAV_TIMEOUT_MS = 25_000;
const ACTION_TIMEOUT_MS = 12_000;
const COMPOSER_TIMEOUT_MS = 20_000;

const MESSAGE_BUTTON_NAMES = [/^mensagem$/i, /^message$/i, /enviar mensagem/i, /send message/i];
const COMPOSER_NAMES = [
  /^mensagem/i,
  /^message/i,
  /escreva uma mensagem/i,
  /write a message/i,
  /digite uma mensagem/i,
];
const NOT_FOUND_MARKERS = [
  /esta p[áa]gina n[ãa]o est[áa] dispon[íi]vel/i,
  /sorry, this page isn'?t available/i,
  /p[áa]gina n[ãa]o encontrada/i,
];

async function pageText(page: Page): Promise<string> {
  try {
    return (await page.locator('body').innerText({ timeout: 5_000 })).slice(0, 20_000);
  } catch {
    return '';
  }
}

async function assertSafe(page: Page, diagnostics: PageDiagnostics, command: SendDmCommand): Promise<void> {
  const text = await pageText(page);
  const detection = detectSafetySignal(page.url(), text);
  if (!detection) return;
  const evidence = await captureEvidence(page, diagnostics, command.jobId, `safety_${detection.signal}`);
  throw new AppError('account_safety_signal', `Sinal de segurança detectado: ${detection.signal}.`, {
    details: { signal: detection.signal, evidence: detection.evidence, artifacts: evidence },
  });
}

async function findMessageButton(page: Page) {
  for (const name of MESSAGE_BUTTON_NAMES) {
    const byRole = page.getByRole('button', { name }).first();
    if (await byRole.count().then((count) => count > 0)) return byRole;
    const byLink = page.getByRole('link', { name }).first();
    if (await byLink.count().then((count) => count > 0)) return byLink;
  }
  return null;
}

/**
 * Finds the message composer.
 *
 * Instagram has three shapes for this: a full `/direct/` thread, a modal, and a
 * floating chat widget that opens on the profile page itself. The widget's
 * textbox carries no accessible name, so a name lookup is not enough.
 *
 * The generic fallback is therefore anchored on *change*: only a textbox that
 * appeared after we clicked the message button counts. An unscoped "last
 * textbox on the page" would happily match Instagram's search field, and in
 * live mode we would type a commercial message into the search box.
 */
async function findComposer(page: Page, textboxesBeforeClick: number) {
  for (const name of COMPOSER_NAMES) {
    const candidate = page.getByRole('textbox', { name }).first();
    if (await candidate.count().then((count) => count > 0)) return candidate;
  }

  const dialog = page.getByRole('dialog').getByRole('textbox').last();
  if (await dialog.count().then((count) => count > 0)) return dialog;

  const textboxes = page.getByRole('textbox');
  const count = await textboxes.count();
  if (/\/direct\//.test(page.url()) && count > 0) return textboxes.last();
  if (count > textboxesBeforeClick) return textboxes.last();

  return null;
}

/**
 * Instagram may open the thread in the current tab or in a new one. Only a tab
 * that did not exist before our click may be adopted - the operator's own tabs
 * are never taken over - and an adopted tab is closed by the caller.
 */
async function resolveThreadPage(
  page: Page,
  pagesBeforeClick: ReadonlySet<Page>,
  timeoutMs: number,
): Promise<{ page: Page; adopted: boolean }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (/\/direct\//.test(page.url())) return { page, adopted: false };
    const opened = page
      .context()
      .pages()
      .find((candidate) => !pagesBeforeClick.has(candidate) && candidate !== page && /\/direct\//.test(candidate.url()));
    if (opened) return { page: opened, adopted: true };
    await sleep(400);
  }
  return { page, adopted: false };
}

/**
 * Opening a thread is a navigation, not an instant DOM swap. Poll for the
 * composer over the whole deadline rather than guessing a sleep duration.
 */
async function waitForComposer(page: Page, textboxesBeforeClick: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const composer = await findComposer(page, textboxesBeforeClick);
    if (composer) return composer;
    await sleep(500);
  }
  return null;
}

/** Human-paced typing: it avoids hammering the UI, it does not hide anything. */
async function typeNaturally(page: Page, text: string): Promise<void> {
  const chunks = text.match(/.{1,18}(\s|$)/g) ?? [text];
  for (const chunk of chunks) {
    await page.keyboard.type(chunk, { delay: randomIntBetween(18, 55) });
    await sleep(randomIntBetween(120, 420));
  }
}

export class InstagramBrowserDriver implements DmDriver {
  readonly name = 'instagram-browser';

  async sendDirectMessage(command: SendDmCommand): Promise<SendDmResult> {
    if (command.mode === 'simulated') {
      throw new AppError('validation_failed', 'O driver real não executa o modo simulado.');
    }

    const session = await connectToChrome();
    // Holder object: TypeScript cannot track assignments made inside the
    // callback below, and the `finally` needs to see the adopted tab.
    const adopted: { page: Page | null } = { page: null };
    try {
      return await withAgentPage(session, async (page, diagnostics) => {
        page.setDefaultTimeout(ACTION_TIMEOUT_MS);
        page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

        await page.goto(profileUrl(command.handle), { waitUntil: 'domcontentloaded' });
        await sleep(randomIntBetween(900, 2_200));
        await assertSafe(page, diagnostics, command);

        const bodyText = await pageText(page);
        if (NOT_FOUND_MARKERS.some((marker) => marker.test(bodyText))) {
          return {
            status: 'profile_not_found',
            evidence: await captureEvidence(page, diagnostics, command.jobId, 'not_found'),
          };
        }

        const messageButton = await findMessageButton(page);
        if (!messageButton) {
          return {
            status: 'messaging_unavailable',
            message: 'Botão de mensagem não encontrado no perfil.',
            evidence: await captureEvidence(page, diagnostics, command.jobId, 'no_message_button'),
          };
        }

        const pagesBeforeClick = new Set(page.context().pages());
        const textboxesBeforeClick = await page.getByRole('textbox').count();
        await messageButton.click();
        await sleep(randomIntBetween(800, 1_600));
        await assertSafe(page, diagnostics, command);

        const thread = await resolveThreadPage(page, pagesBeforeClick, COMPOSER_TIMEOUT_MS);
        adopted.page = thread.adopted ? thread.page : null;
        const threadPage = thread.page;
        await assertSafe(threadPage, diagnostics, command);

        const composer = await waitForComposer(
          threadPage,
          threadPage === page ? textboxesBeforeClick : 0,
          COMPOSER_TIMEOUT_MS,
        );
        if (!composer) {
          return {
            status: 'messaging_unavailable',
            message: 'Campo de digitação da conversa não encontrado.',
            evidence: await captureEvidence(threadPage, diagnostics, command.jobId, 'no_composer'),
          };
        }

        if (command.mode === 'dry_run') {
          // Everything up to this point is real navigation; the send is the one
          // thing a dry run must never do.
          log.info('dry run reached composer without sending', { jobId: command.jobId });
          return {
            status: 'dry_run_ok',
            message: 'Fluxo validado até o campo de mensagem; envio bloqueado pelo modo dry-run.',
            evidence: await captureEvidence(threadPage, diagnostics, command.jobId, 'dry_run'),
          };
        }

        await composer.click();
        await typeNaturally(threadPage, command.text);
        await sleep(randomIntBetween(400, 900));
        await threadPage.keyboard.press('Enter');
        await sleep(randomIntBetween(1_500, 3_000));
        await assertSafe(threadPage, diagnostics, command);

        const delivered = await threadPage.getByText(command.text.slice(0, 40), { exact: false }).count();
        if (delivered === 0) {
          return {
            status: 'failed',
            message: 'Mensagem não localizada na thread após o envio.',
            evidence: await captureEvidence(threadPage, diagnostics, command.jobId, 'delivery_unconfirmed'),
          };
        }

        return {
          status: 'sent',
          sentAt: new Date().toISOString(),
          evidence: { url: threadPage.url(), consoleErrors: diagnostics.consoleErrors.slice(-5) },
        };
      });
    } finally {
      // A tab Instagram opened for us is ours to close; the operator's tabs are
      // never touched.
      if (adopted.page) await adopted.page.close({ runBeforeUnload: false }).catch(() => undefined);
      await disconnect(session);
    }
  }
}
