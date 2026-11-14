import { describe, expect, it } from 'vitest';
import { formatPublicationTime } from './presentation.ts';

describe('publication time presentation', () => {
  it('displays readable UTC seconds while retaining the exact input timestamp', () => {
    const publication = Object.freeze({
      published_at: '2026-11-14T12:30:01.123456Z',
    });

    expect(formatPublicationTime(publication.published_at)).toBe(
      '14 Nov 2026, 12:30:01 UTC',
    );
    expect(publication.published_at).toBe('2026-11-14T12:30:01.123456Z');
    expect(formatPublicationTime('2026-11-14T12:30:01Z')).toBe(
      '14 Nov 2026, 12:30:01 UTC',
    );
  });

  it('uses UTC across a date boundary instead of the viewer local timezone', () => {
    expect(formatPublicationTime('2026-11-14T00:30:01+01:00')).toBe(
      '13 Nov 2026, 23:30:01 UTC',
    );
  });
});
