import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { getEnv } from '@/lib/env';
import { createLogger } from '@/lib/logger';
import type { DmEvidence } from './types';
import type { PageDiagnostics } from './cdp';

const log = createLogger('browser.artifacts');

/**
 * Failure evidence. Screenshots and accessibility snapshots are written under
 * ARTIFACTS_DIR, which is git-ignored: they can contain the operator's own
 * Instagram session on screen.
 */

function artifactsDir(): string {
  const dir = path.resolve(process.cwd(), getEnv().ARTIFACTS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function captureEvidence(
  page: Page,
  diagnostics: PageDiagnostics,
  jobId: string,
  label: string,
): Promise<DmEvidence> {
  const evidence: DmEvidence = {
    consoleErrors: diagnostics.consoleErrors.slice(-10),
    failedRequests: diagnostics.failedRequests.slice(-10),
  };
  try {
    evidence.url = page.url();
  } catch {
    evidence.url = undefined;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.join(artifactsDir(), `${stamp}_${jobId}_${label}`);

  try {
    const screenshotPath = `${base}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: false });
    evidence.screenshotPath = screenshotPath;
  } catch (error) {
    log.warn('screenshot failed', { error: error instanceof Error ? error.message : String(error) });
  }

  try {
    const snapshot = await page.locator('body').ariaSnapshot({ timeout: 5_000 });
    const snapshotPath = `${base}.aria.yaml`;
    fs.writeFileSync(snapshotPath, snapshot, 'utf8');
    evidence.accessibilitySnapshotPath = snapshotPath;
  } catch (error) {
    log.warn('accessibility snapshot failed', { error: error instanceof Error ? error.message : String(error) });
  }

  return evidence;
}
