import { describe, expect, it } from 'vitest';
import { parseCompactCount } from '@/integrations/browser/instagram-discovery';

/**
 * Instagram's meta description mixes two number conventions in one string, and
 * getting them backwards is silent: a 3,656-follower account was being stored
 * as 4, so every size-based ICP signal scored against a number off by three
 * orders of magnitude. These are the real strings observed on 2026-08-30.
 */
describe('follower count from Instagram meta description', () => {
  it('reads a comma as a thousands separator when there is no suffix', () => {
    expect(
      parseCompactCount('3,656 seguidores, 5,231 seguindo, 38 posts — Software Sob Medida (@softwaresobmedida)'),
    ).toBe(3656);
    expect(parseCompactCount('1,203 seguidores, 435 seguindo, 145 posts — Laon')).toBe(1203);
  });

  it('reads a comma as a decimal point when a magnitude suffix follows', () => {
    expect(parseCompactCount('16,5 mil seguidores')).toBe(16_500);
    expect(parseCompactCount('1,2 mi seguidores')).toBe(1_200_000);
    expect(parseCompactCount('2.5k followers')).toBe(2_500);
  });

  it('takes the followers number, not whichever number comes first', () => {
    // Following and post counts sit in the same sentence; picking the first
    // match would read the wrong one the moment the order changes.
    expect(parseCompactCount('145 posts, 435 seguindo, 1,203 seguidores')).toBe(1203);
  });

  it('handles plain and dotted groupings', () => {
    expect(parseCompactCount('842 seguidores')).toBe(842);
    expect(parseCompactCount('3.656 seguidores')).toBe(3656);
  });

  it('returns null when there is no number to read', () => {
    expect(parseCompactCount('sem números aqui')).toBeNull();
  });
});
