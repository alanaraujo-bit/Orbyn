/**
 * The icon set for the bottom tab bar and the mobile sheet.
 *
 * Drawn inline rather than pulled from a library: there are eight of them, they
 * are all one stroke weight, and shipping an icon package to a phone on mobile
 * data to get eight glyphs is not a trade worth making.
 *
 * All of them are 24x24, `currentColor`, 1.6 stroke — so they inherit the
 * active/inactive colour from the element around them.
 */

export type IconName =
  | 'overview'
  | 'customers'
  | 'affiliates'
  | 'alerts'
  | 'experiments'
  | 'decisions'
  | 'costs'
  | 'jobs'
  | 'settings'
  | 'more'
  | 'install'
  | 'share-ios';

const PATHS: Record<IconName, React.ReactNode> = {
  overview: (
    <>
      <path d="M3 12.5 12 4l9 8.5" />
      <path d="M5.5 10.8V19a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-8.2" />
    </>
  ),
  customers: (
    <>
      <path d="M4 5h6v14H4z" />
      <path d="M14 5h6v9h-6z" />
    </>
  ),
  affiliates: (
    <>
      <circle cx="12" cy="8" r="3.2" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </>
  ),
  alerts: (
    <>
      <path d="M12 4a6 6 0 0 0-6 6c0 3.5-1.2 5-2 6h16c-.8-1-2-2.5-2-6a6 6 0 0 0-6-6Z" />
      <path d="M10 20a2 2 0 0 0 4 0" />
    </>
  ),
  experiments: (
    <>
      <path d="M9.5 3v6.2L4.6 17.5A1.8 1.8 0 0 0 6.2 20h11.6a1.8 1.8 0 0 0 1.6-2.5L14.5 9.2V3" />
      <path d="M8.5 3h7" />
      <path d="M7.4 14h9.2" />
    </>
  ),
  decisions: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6 7.8 7.8M16.2 16.2l2.2 2.2M18.4 5.6l-2.2 2.2M7.8 16.2l-2.2 2.2" />
    </>
  ),
  costs: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M14.5 9.2A3 3 0 0 0 12 8c-1.7 0-2.6.9-2.6 2s.9 1.7 2.6 2 2.6.9 2.6 2-.9 2-2.6 2a3 3 0 0 1-2.5-1.2" />
      <path d="M12 6.2v1.8M12 16v1.8" />
    </>
  ),
  jobs: (
    <>
      <path d="M4 7h16M4 12h16M4 17h10" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="2.8" />
      <path d="M19.4 14.5a1.5 1.5 0 0 0 .3 1.7l.1.1a1.8 1.8 0 1 1-2.6 2.6l-.1-.1a1.5 1.5 0 0 0-2.5 1v.3a1.8 1.8 0 1 1-3.6 0v-.2a1.5 1.5 0 0 0-2.6-1l-.1.1a1.8 1.8 0 1 1-2.6-2.6l.1-.1a1.5 1.5 0 0 0-1-2.5H4.5a1.8 1.8 0 1 1 0-3.6h.2a1.5 1.5 0 0 0 1-2.6l-.1-.1a1.8 1.8 0 1 1 2.6-2.6l.1.1a1.5 1.5 0 0 0 2.5-1V4.5a1.8 1.8 0 1 1 3.6 0v.2a1.5 1.5 0 0 0 2.5 1l.1-.1a1.8 1.8 0 1 1 2.6 2.6l-.1.1a1.5 1.5 0 0 0 1 2.5h.3a1.8 1.8 0 1 1 0 3.6h-.2a1.5 1.5 0 0 0-1.4.9Z" />
    </>
  ),
  more: (
    <>
      <circle cx="5.5" cy="12" r="1.4" />
      <circle cx="12" cy="12" r="1.4" />
      <circle cx="18.5" cy="12" r="1.4" />
    </>
  ),
  install: (
    <>
      <path d="M12 3.5v11" />
      <path d="M8.2 11l3.8 3.8L15.8 11" />
      <path d="M4.5 16.5v2.2a1.8 1.8 0 0 0 1.8 1.8h11.4a1.8 1.8 0 0 0 1.8-1.8v-2.2" />
    </>
  ),
  /** The iOS share glyph, so the instruction points at something recognisable. */
  'share-ios': (
    <>
      <path d="M12 3.5v10.5" />
      <path d="M8.6 6.9 12 3.5l3.4 3.4" />
      <path d="M7 10.5H5.8A1.8 1.8 0 0 0 4 12.3v6.4a1.8 1.8 0 0 0 1.8 1.8h12.4a1.8 1.8 0 0 0 1.8-1.8v-6.4a1.8 1.8 0 0 0-1.8-1.8H17" />
    </>
  ),
};

export function Icon({ name, className = 'size-[22px]' }: { name: IconName; className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {PATHS[name]}
    </svg>
  );
}
