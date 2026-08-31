'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { LeadRow } from '@/db/schema';
import type { Funnel, PipelineStage } from '@/features/leads/states';
import { stagesForFunnel } from '@/features/leads/states';
import { formatRelative } from '@/lib/format';
import { CHANNEL_STATE_LABELS, STAGE_LABELS, labelOr } from '@/app/_lib/labels';
import { Pill, type Tone } from './ui';

/**
 * The funnel: columns on a desktop, one stage at a time on a phone.
 *
 * Side-by-side lanes are the wrong shape for a 390px screen. Swiping through
 * them costs an empty stage a whole screen, cuts the next lane off mid-card,
 * and never shows the funnel as a whole — you cannot see where the leads are
 * without scrolling past every stage that has none. So below `md` the lanes
 * become a row of stage chips carrying their own counts, and the selected one
 * lists its leads full width. The chips are the overview; the list is the work.
 *
 * Read-only either way. Stage changes happen on the lead page, where the
 * operator can see the whole conversation before moving anything.
 */

const CHANNEL_TONE: Record<string, Tone> = {
  browser_contact_pending: 'neutral',
  browser_contact_sent: 'accent',
  waiting_inbound_reply: 'accent',
  api_eligible: 'positive',
  api_active: 'positive',
  api_window_closed: 'warning',
  human_review_required: 'warning',
  do_not_contact: 'danger',
  blocked: 'danger',
  completed: 'neutral',
};

function scoreTone(score: number): Tone {
  if (score >= 70) return 'positive';
  if (score >= 40) return 'accent';
  return 'neutral';
}

function LeadCard({ lead }: { lead: LeadRow }) {
  return (
    <Link
      href={`/leads/${lead.id}`}
      className="card block px-3 py-3 transition-colors hover:border-line-strong active:border-line-strong active:bg-surface-muted md:py-2.5"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 truncate text-[13px] font-medium text-ink md:text-[12.5px]">@{lead.handle}</span>
        <Pill tone={scoreTone(lead.icpScore)} title="Aderência ao ICP">
          {Math.round(lead.icpScore)}
        </Pill>
      </div>
      {lead.displayName ? <p className="mt-0.5 truncate text-[11.5px] text-ink-muted">{lead.displayName}</p> : null}
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="min-w-0">
          <Pill tone={CHANNEL_TONE[lead.channelState] ?? 'neutral'}>
            {labelOr(CHANNEL_STATE_LABELS, lead.channelState)}
          </Pill>
        </span>
        <span className="shrink-0 text-[11px] text-ink-faint">{formatRelative(lead.updatedAt)}</span>
      </div>
    </Link>
  );
}

export function Kanban({ funnel, leads }: { funnel: Funnel; leads: LeadRow[] }) {
  const stages = stagesForFunnel(funnel);
  const byStage = new Map<PipelineStage, LeadRow[]>();
  for (const stage of stages) byStage.set(stage, []);
  for (const lead of leads) {
    const bucket = byStage.get(lead.pipelineStage as PipelineStage);
    if (bucket) bucket.push(lead);
  }

  /*
   * Until the operator picks a stage, open on the first one that has anything
   * in it: landing on an empty "Descoberto" and having to hunt for where the
   * leads actually are is the exact problem the lanes had. Keeping the choice
   * nullable rather than seeding state means the default also follows the data
   * as it refreshes, instead of freezing on whatever was true at first render.
   */
  const [picked, setPicked] = useState<PipelineStage | null>(null);
  const selected = picked ?? stages.find((stage) => (byStage.get(stage) ?? []).length > 0) ?? stages[0];
  if (!selected) return null;

  const current = byStage.get(selected) ?? [];

  return (
    <>
      {/* Phone: stage chips, then the selected stage's leads. */}
      <div className="md:hidden">
        <div
          role="tablist"
          aria-label="Etapas do funil"
          className="scroll-slim -mx-4 flex gap-2 overflow-x-auto px-4 pb-3"
        >
          {stages.map((stage) => {
            const count = (byStage.get(stage) ?? []).length;
            const active = stage === selected;
            return (
              <button
                key={stage}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setPicked(stage)}
                className={`flex min-h-11 shrink-0 items-center gap-2 rounded-full border px-3.5 text-[13px] transition-colors ${
                  active
                    ? 'border-transparent bg-accent font-medium text-white'
                    : 'border-line bg-surface text-ink-muted active:bg-surface-muted'
                }`}
              >
                <span>{STAGE_LABELS[stage]}</span>
                <span
                  className={`num rounded-full px-1.5 text-[11.5px] font-semibold ${
                    active ? 'bg-white/20 text-white' : count > 0 ? 'bg-surface-muted text-ink' : 'text-ink-faint'
                  }`}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        <div role="tabpanel" aria-label={STAGE_LABELS[selected]} className="flex flex-col gap-2">
          {current.length === 0 ? (
            <p className="card px-4 py-10 text-center text-[12.5px] text-ink-faint">
              Nenhum lead em {STAGE_LABELS[selected].toLowerCase()}.
            </p>
          ) : (
            current.map((lead) => <LeadCard key={lead.id} lead={lead} />)
          )}
        </div>
      </div>

      {/* Desktop: the whole funnel side by side. `dvh`, not `vh`, so a browser
          toolbar that comes and goes does not clip the last card. */}
      <div className="scroll-slim hidden gap-3 overflow-x-auto pb-2 md:flex">
        {stages.map((stage) => {
          const items = byStage.get(stage) ?? [];
          return (
            <section key={stage} className="flex w-64 shrink-0 flex-col" aria-label={STAGE_LABELS[stage]}>
              <header className="flex items-center justify-between px-1 pb-2">
                <h2 className="text-[12px] font-semibold text-ink">{STAGE_LABELS[stage]}</h2>
                <span className="num text-[11.5px] text-ink-faint">{items.length}</span>
              </header>
              <div className="scroll-slim flex max-h-[calc(100dvh-16rem)] flex-col gap-2 overflow-y-auto rounded-lg bg-surface-muted/60 p-2">
                {items.length === 0 ? (
                  <p className="px-1 py-4 text-center text-[11.5px] text-ink-faint">Vazio</p>
                ) : (
                  items.map((lead) => <LeadCard key={lead.id} lead={lead} />)
                )}
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}
