import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';

/** Small presentational primitives shared by every page. */

export type Tone = 'neutral' | 'accent' | 'positive' | 'warning' | 'danger';

const TONE_CLASS: Record<Tone, string> = {
  neutral: 'bg-surface-muted text-ink-muted border-line',
  accent: 'bg-accent-soft text-accent-ink border-transparent',
  positive: 'bg-positive-soft text-positive border-transparent',
  warning: 'bg-warning-soft text-warning border-transparent',
  danger: 'bg-danger-soft text-danger border-transparent',
};

export function Pill({ children, tone = 'neutral', title }: { children: ReactNode; tone?: Tone; title?: string }) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] leading-5 font-medium whitespace-nowrap ${TONE_CLASS[tone]}`}
    >
      {children}
    </span>
  );
}

export function Dot({ tone = 'neutral' }: { tone?: Tone }) {
  const color =
    tone === 'positive'
      ? 'bg-positive'
      : tone === 'warning'
        ? 'bg-warning'
        : tone === 'danger'
          ? 'bg-danger'
          : tone === 'accent'
            ? 'bg-accent'
            : 'bg-ink-faint';
  return <span aria-hidden className={`inline-block size-1.5 rounded-full ${color}`} />;
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-5 flex flex-col items-stretch gap-3 md:mb-6 md:flex-row md:flex-wrap md:items-start md:justify-between md:gap-4">
      <div className="min-w-0">
        <h1 className="text-[20px] font-semibold tracking-[-0.01em] text-ink md:text-[19px]">{title}</h1>
        {description ? <p className="mt-1 max-w-2xl text-[13px] leading-5 text-ink-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2 md:shrink-0 md:flex-nowrap">{actions}</div> : null}
    </header>
  );
}

export function Card({
  title,
  description,
  actions,
  children,
  className = '',
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {title ? (
        <div className="flex flex-col gap-2 border-b border-line px-4 py-3 md:flex-row md:items-start md:justify-between md:gap-3">
          <div className="min-w-0">
            <h2 className="text-[13px] font-semibold text-ink">{title}</h2>
            {description ? <p className="mt-0.5 text-[12px] leading-4 text-ink-faint">{description}</p> : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2 md:shrink-0">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: Tone;
}) {
  const valueTone =
    tone === 'positive'
      ? 'text-positive'
      : tone === 'warning'
        ? 'text-warning'
        : tone === 'danger'
          ? 'text-danger'
          : 'text-ink';
  return (
    <div className="card px-3.5 py-3 md:px-4">
      <div className="text-[11px] font-medium tracking-wide text-ink-faint uppercase">{label}</div>
      <div className={`num mt-1 text-[21px] leading-7 font-semibold md:text-[22px] ${valueTone}`}>{value}</div>
      {hint ? <div className="mt-0.5 text-[12px] leading-4 text-ink-faint">{hint}</div> : null}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      {icon ? <div className="mb-3 text-ink-faint">{icon}</div> : null}
      <p className="text-[13px] font-semibold text-ink">{title}</p>
      <p className="mt-1 max-w-md text-[12.5px] leading-5 text-ink-muted">{description}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 py-2">
      <dt className="text-[11px] font-medium tracking-wide text-ink-faint uppercase">{label}</dt>
      <dd className="text-[13px] leading-5 text-ink">{children}</dd>
    </div>
  );
}

export function Divider() {
  return <hr className="border-line" />;
}

/** Flattens an element tree down to its text, for use as a cell's label. */
function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return '';
}

/**
 * What a column becomes once the row is a card on a phone.
 *
 * - `title`  the line you read first, unlabelled and larger. Defaults to the
 *            first column when a table declares none.
 * - `badge`  a pill that sits to the left of the title: severity, status.
 * - `meta`   small muted text under the title, unlabelled: a timestamp.
 * - `detail` the default — a labelled field on its own line.
 * - `action` controls, laid out as a footer with no heading above them.
 */
export type ColumnRole = 'title' | 'badge' | 'meta' | 'detail' | 'action';

/** Headers whose cells hold controls, when a page has not said so itself. */
const ACTION_HEADERS = new Set(['ações', 'controle']);

interface RowProps {
  children?: ReactNode;
}

interface HeadProps {
  children?: ReactNode;
  role?: ColumnRole;
}

/**
 * A table on the desktop, a list of cards on a phone.
 *
 * A five-column table cannot be shown as a table on a 390px screen, and the
 * honest alternative is not a smaller table — it is the layout a phone app would
 * have used in the first place: one card per row, with a title you read first,
 * a status pill, a timestamp, and the controls at the foot.
 *
 * Pages describe their columns once, on the `<Th>`, and get both layouts. This
 * function carries each column's label and role onto every matching cell, so the
 * rows themselves stay ordinary `<tr><Td>…` markup with nothing repeated.
 */
export function TableShell({ head, children }: { head: ReactNode; children: ReactNode }) {
  const headings = isValidElement<RowProps>(head) ? head.props.children : head;
  const columns = Children.toArray(headings).map((heading) => {
    const label = textOf(heading);
    const declared = isValidElement<HeadProps>(heading) ? heading.props.role : undefined;
    const role: ColumnRole = declared ?? (ACTION_HEADERS.has(label.trim().toLowerCase()) ? 'action' : 'detail');
    return { label, role };
  });

  // Every card needs something to lead with. If no column claimed the title, the
  // first one that is not a pill or a control takes it.
  if (!columns.some((column) => column.role === 'title')) {
    const lead = columns.find((column) => column.role === 'detail');
    if (lead) lead.role = 'title';
  }

  const rows = Children.map(children, (row) => {
    if (!isValidElement<RowProps>(row)) return row;
    const cells = Children.map(row.props.children, (cell, index) => {
      if (!isValidElement<CellProps>(cell)) return cell;
      const column = columns[index];
      return cloneElement(cell, {
        label: column?.label ?? '',
        role: column?.role ?? 'detail',
        // "—" means the field has no value. Worth a placeholder in a table
        // column, worth nothing at all in a card.
        empty: textOf(cell.props.children).trim() === '—',
      });
    });
    return cloneElement(row as ReactElement<RowProps>, undefined, cells);
  });

  return (
    <div className="scroll-slim overflow-x-auto">
      <table data-stacked className="w-full border-collapse text-left md:min-w-[640px]">
        <thead className="border-b border-line bg-surface-muted/60">
          <tr className="text-[11px] font-medium tracking-wide text-ink-faint uppercase">{head}</tr>
        </thead>
        <tbody className="divide-y divide-line">{rows}</tbody>
      </table>
    </div>
  );
}

export function Th({
  children,
  className = '',
  role: _role,
}: {
  children: ReactNode;
  className?: string;
  /** Read by TableShell to compose the phone layout; not rendered. */
  role?: ColumnRole;
}) {
  return <th className={`px-4 py-2 font-medium ${className}`}>{children}</th>;
}

interface CellProps {
  children: ReactNode;
  className?: string;
  title?: string;
  /** All three injected by TableShell from the column header. */
  label?: string;
  role?: ColumnRole;
  empty?: boolean;
}

export function Td({ children, className = '', title, label, role, empty }: CellProps) {
  return (
    <td
      title={title}
      data-label={label}
      data-role={role}
      data-empty={empty ? '' : undefined}
      className={`px-4 py-2.5 align-top text-[12.5px] leading-5 text-ink ${className}`}
    >
      {/*
        The wrapper is what keeps the mobile layout honest. Stacked, the cell is
        a grid — label, then value — and every direct child of a grid is its own
        item, so a cell holding a title and a note would drop the note into the
        label column. One wrapper means one item, whatever is inside.
      */}
      <div>{children}</div>
    </td>
  );
}
