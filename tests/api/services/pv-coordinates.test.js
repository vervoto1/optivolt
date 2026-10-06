import { describe, it, expect } from 'vitest';
import { hasPvCoordinates } from '../../../api/services/pv-coordinates.ts';

describe('hasPvCoordinates', () => {
  it('accepts real locations, including ones on the equator or the prime meridian', () => {
    expect(hasPvCoordinates({ latitude: 50.85, longitude: 4.35 })).toBe(true);
    expect(hasPvCoordinates({ latitude: 0, longitude: 32.5 })).toBe(true);
    expect(hasPvCoordinates({ latitude: 51.48, longitude: 0 })).toBe(true);
    expect(hasPvCoordinates({ latitude: -33.9, longitude: -70.6 })).toBe(true);
  });

  it('treats a missing config, missing/non-finite values and (0, 0) as unset', () => {
    expect(hasPvCoordinates(null)).toBe(false);
    expect(hasPvCoordinates(undefined)).toBe(false);
    expect(hasPvCoordinates({})).toBe(false);
    expect(hasPvCoordinates({ latitude: null, longitude: 5 })).toBe(false);
    expect(hasPvCoordinates({ latitude: 52, longitude: undefined })).toBe(false);
    expect(hasPvCoordinates({ latitude: Number.NaN, longitude: 5 })).toBe(false);
    expect(hasPvCoordinates({ latitude: 52, longitude: Number.POSITIVE_INFINITY })).toBe(false);
    expect(hasPvCoordinates({ latitude: '52', longitude: 5 })).toBe(false);
    expect(hasPvCoordinates({ latitude: 0, longitude: 0 })).toBe(false);
  });
});
