// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { resolveEvMode } from '../../../api/services/ev-mode.ts';

describe('resolveEvMode — single authoritative EV mode', () => {
  it('is off when evEnabled is false', () => {
    expect(resolveEvMode({ evEnabled: false })).toBe('off');
  });

  it('is native when evEnabled is true', () => {
    expect(resolveEvMode({ evEnabled: true })).toBe('native');
  });

  it('ignores any stray fields beyond evEnabled', () => {
    // Only evEnabled drives the mode now that the legacy haSchedule path is gone.
    expect(resolveEvMode({ evEnabled: true, evSource: 'haSchedule' })).toBe('native');
    expect(resolveEvMode({ evEnabled: false, evSource: 'native' })).toBe('off');
  });
});
