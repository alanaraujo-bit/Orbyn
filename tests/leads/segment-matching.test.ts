import { describe, expect, it } from 'vitest';
import { scoreLead } from '@/features/leads/scoring';

/**
 * The ICP segments are written as prose about the client, while the client's own
 * bio is a shop sign. Before stems were compared, the plural in the segment
 * ("distribuidores") missed the singular in the bio ("DISTRIBUIDORA"), so real
 * prospects scored below the qualification threshold while a software agency —
 * whose bio happened to speak the same corporate vocabulary as the segment text —
 * scored above it. These are real profiles observed on 2026-08-30.
 */
describe('ICP segment matching against how businesses actually write', () => {
  function score(bio: string) {
    return scoreLead({ handle: 'x', bio, isBusinessAccount: true }, 'customer');
  }

  it('matches a segment plural against the profile singular', () => {
    const result = score('J.A DISTRIBUIDORA — Água | Gás — atacado e varejo');
    const segments = result.signals.find((s) => s.key === 'icp_segments');
    expect(segments?.weight).toBeGreaterThan(0);
  });

  it('matches a store that never uses the segment wording verbatim', () => {
    const result = score('TEB - Materiais de Construção. Tudo para sua obra.');
    expect(result.signals.some((s) => s.key === 'icp_segments' || s.key === 'icp_keywords')).toBe(true);
  });

  it('does not match a profile with nothing to do with the ICP', () => {
    const result = score('Fotografia de casamento e ensaios ao ar livre');
    const segments = result.signals.find((s) => s.key === 'icp_segments');
    expect(segments).toBeUndefined();
  });
});
