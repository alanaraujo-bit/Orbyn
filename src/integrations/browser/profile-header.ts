/**
 * Turns an Instagram profile header into the fields we are willing to stand
 * behind.
 *
 * Discovery used to take `lines.slice(1).join(' ')` as the bio and "the first
 * line of 3 to 40 letters" as the category. Both were wrong in a way that
 * reached real people. The bio absorbed the follower counters, the "... mais"
 * truncation link, the Seguir / Enviar mensagem buttons and every story
 * highlight name; the category matched whichever of those came first, capturing
 * "Seguir", "mais", the @handle or the display name on 15 of the first 16
 * leads.
 *
 * That mattered twice. The junk fed ICP scoring, and it fed the opener as
 * observable fact: a beverage distributor was told "Vi que você trabalha como
 * mecânico" because a line of the owner's personal bio survived in the blob.
 */

/** The "1.494 posts" / "8.395 seguidores" / "101 seguindo" row. */
const COUNTER_LINE = /^[\d.,]+\s*(mil|k|mi|m)?\s*(posts?|publica[çc][õo]es|seguidores|followers|seguindo|following)$/i;

/**
 * The first line of interface chrome. Everything from here on is buttons, the
 * truncation link and story highlight names - never biography.
 */
const CHROME_LINE =
  /^(mais|more|seguir|follow|seguindo|following|enviar mensagem|mensagem|message|contato|contact|ligar|call|e-?mail|como chegar|ver tradu[çc][ãa]o|see translation)$/i;

/** "Seguido(a) por fulano e mais 3" - a social proof row, not the bio. */
const FOLLOWED_BY = /^(seguido\(?a?\)?\s+por|followed by)/i;

export interface ParsedProfileHeader {
  bio: string | null;
  /**
   * Always `null`.
   *
   * Instagram renders the professional category inside the same text block as
   * the bio, and its position is not stable: it is the line right after the
   * counters on one profile and one line further down on another. Any rule that
   * picks it out of plain text is guessing, and a guess is what produced
   * "trabalham com mais". A field whose meaning we cannot establish is worth
   * less than nothing here, because everything downstream treats it as an
   * established fact about someone's business.
   *
   * Recovering it needs a structural read of the category element, not a text
   * heuristic. Until then the openers stay neutral.
   */
  category: null;
}

/**
 * The bio exactly as Instagram publishes it, out of the page's own meta
 * description.
 *
 * Far better evidence than the rendered header: it is untruncated (the header
 * cuts off at "... mais"), carries no interface chrome, and Instagram itself
 * decides what belongs in it. The header text is only a fallback for profiles
 * that publish no meta description at all.
 *
 * Format: `8.278 seguidores, 128 seguindo, 1.495 posts — Nome (@handle) no
 * Instagram: "a bio, com quebras de linha"`.
 */
export function parseCanonicalBio(metaDescription: string | null): string | null {
  if (!metaDescription) return null;
  const quoted = /:\s*"([\s\S]*)"\s*$/.exec(metaDescription.trim())?.[1]?.trim();
  return quoted && quoted.length > 0 ? quoted.slice(0, 600) : null;
}

/**
 * Instagram's own machine description of an image, which it puts in `alt` when
 * the author wrote no caption. It describes pixels, not a business: "May be an
 * image of forklift and text that says..." is not something the account said.
 */
const MACHINE_GENERATED_ALT = /^(photo|video|reel)\s+(by|shared by)\b|may be an image of|foto de\b|pode ser uma imagem de/i;

/** Captions the account actually wrote, from the profile grid. */
export function parsePostCaptions(alts: readonly string[], limit = 6): string[] {
  const captions: string[] = [];
  for (const raw of alts) {
    const text = raw.replace(/\s+/g, ' ').trim();
    if (text.length < 25) continue;
    if (MACHINE_GENERATED_ALT.test(text)) continue;
    // Cut on a word boundary. A caption sliced mid-token leaves a fragment
    // ("#autopec" out of "#autopecas_exemplo") that is not something the account
    // wrote, and this text is used as evidence for what may be said to them.
    captions.push(text.length > 400 ? text.slice(0, 400).replace(/\s+\S*$/, '') : text);
    if (captions.length >= limit) break;
  }
  return captions;
}

/** Hashtags the account used, taken from the captions it wrote. */
export function parsePostHashtags(captions: readonly string[], limit = 20): string[] {
  const tags = new Set<string>();
  for (const caption of captions) {
    for (const match of caption.matchAll(/#([\p{L}\p{N}_]{2,40})/gu)) {
      const tag = match[1];
      if (tag) tags.add(tag.toLowerCase());
      if (tags.size >= limit) return [...tags];
    }
  }
  return [...tags];
}

export function parseProfileHeader(
  headerText: string,
  context: { handle: string; displayName: string | null },
): ParsedProfileHeader {
  const lines = headerText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const handle = context.handle.replace(/^@/, '').toLowerCase();
  const displayName = context.displayName?.trim().toLowerCase() ?? null;

  const kept: string[] = [];
  let seenCounters = false;

  for (const line of lines) {
    if (COUNTER_LINE.test(line)) {
      seenCounters = true;
      continue;
    }
    if (CHROME_LINE.test(line) || FOLLOWED_BY.test(line)) break;

    // The name block sits above the counters row; the bio always sits below it.
    if (!seenCounters) continue;

    const normalized = line.toLowerCase();
    if (normalized === handle || (displayName !== null && normalized === displayName)) continue;

    kept.push(line);
  }

  const bio = kept.join(' ').slice(0, 600);
  return { bio: bio.length > 0 ? bio : null, category: null };
}
