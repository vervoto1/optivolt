// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { resolveEvMode } from '../../../api/services/ev-mode.ts';

describe('resolveEvMode — single authoritative EV mode', () => {
  it('is off when evEnabled is false, regardless of source', () => {
    expect(resolveEvMode({ evEnabled: false, evSource: 'native' })).toBe('off');
    expect(resolveEvMode({ evEnabled: false, evSource: 'haSchedule' })).toBe('off');
  });

  it('is native when enabled with the native source (or no source)', () => {
    expect(resolveEvMode({ evEnabled: true, evSource: 'native' })).toBe('native');
    expect(resolveEvMode({ evEnabled: true, evSource: undefined })).toBe('native');
  });

  it('is haSchedule when enabled with the haSchedule source', () => {
    expect(resolveEvMode({ evEnabled: true, evSource: 'haSchedule' })).toBe('haSchedule');
  });

  it('native and haSchedule are mutually exclusive (no double-count path)', () => {
    const native = resolveEvMode({ evEnabled: true, evSource: 'native' });
    const legacy = resolveEvMode({ evEnabled: true, evSource: 'haSchedule' });
    // Native never enables the legacy evLoad injection and vice-versa.
    expect(native === 'haSchedule').toBe(false);
    expect(legacy === 'native').toBe(false);
  });
});
