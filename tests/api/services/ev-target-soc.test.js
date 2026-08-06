// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../api/services/ha-client.ts', () => ({
  fetchHaEntityState: vi.fn(),
}));

import {
  parseTargetSocState,
  fetchEvTargetSoc,
  resolveEvTargetSoc,
} from '../../../api/services/ev-target-soc.ts';
import { fetchHaEntityState } from '../../../api/services/ha-client.ts';

function makeSettings(overrides = {}) {
  return {
    evTargetSoc_percent: 80,
    evTargetSocEntity: 'number.tesla_charge_limit',
    haUrl: 'ws://ha.local:8123/api/websocket',
    haToken: 'tok',
    ...overrides,
  };
}

describe('parseTargetSocState', () => {
  it('parses a numeric state', () => {
    expect(parseTargetSocState('90')).toBe(90);
    expect(parseTargetSocState('72.5')).toBe(72.5);
  });

  it('clamps above 100', () => {
    expect(parseTargetSocState('130')).toBe(100);
    expect(parseTargetSocState('100')).toBe(100);
  });

  it('returns null for non-numeric states', () => {
    expect(parseTargetSocState('unavailable')).toBeNull();
    expect(parseTargetSocState('unknown')).toBeNull();
    expect(parseTargetSocState('')).toBeNull();
    expect(parseTargetSocState(undefined)).toBeNull();
  });

  // A 0% charge limit is nobody's setting — it is an unsynced input_number, a
  // template sensor evaluating to 0, or the wrong entity id. Taking it literally
  // would plan no EV charge, clamp evMinSocFloor_percent to 0, and idle every
  // slot on the liveSoc >= targetSoc cutoff, all without a fallback firing.
  it('returns null for zero and negative states', () => {
    expect(parseTargetSocState('0')).toBeNull();
    expect(parseTargetSocState('0.0')).toBeNull();
    expect(parseTargetSocState('-5')).toBeNull();
  });
});

describe('fetchEvTargetSoc', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('reads the configured entity', async () => {
    fetchHaEntityState.mockResolvedValue({ state: '90' });
    await expect(fetchEvTargetSoc(makeSettings())).resolves.toBe(90);
    expect(fetchHaEntityState).toHaveBeenCalledWith({
      haUrl: 'ws://ha.local:8123/api/websocket',
      haToken: 'tok',
      entityId: 'number.tesla_charge_limit',
    });
  });

  it('returns null (no HA call) when no entity is configured', async () => {
    await expect(fetchEvTargetSoc(makeSettings({ evTargetSocEntity: '' }))).resolves.toBeNull();
    await expect(fetchEvTargetSoc(makeSettings({ evTargetSocEntity: '   ' }))).resolves.toBeNull();
    await expect(fetchEvTargetSoc(makeSettings({ evTargetSocEntity: undefined }))).resolves.toBeNull();
    expect(fetchHaEntityState).not.toHaveBeenCalled();
  });

  it('returns null (no HA call) when HA is not configured', async () => {
    await expect(fetchEvTargetSoc(makeSettings({ haUrl: '' }))).resolves.toBeNull();
    expect(fetchHaEntityState).not.toHaveBeenCalled();
  });

  it('reads through the supervisor proxy in add-on mode (no haUrl)', async () => {
    process.env.SUPERVISOR_TOKEN = 'supervisor-token';
    fetchHaEntityState.mockResolvedValue({ state: '70' });
    await expect(fetchEvTargetSoc(makeSettings({ haUrl: '' }))).resolves.toBe(70);
    expect(fetchHaEntityState).toHaveBeenCalledOnce();
  });

  it('returns null when HA is unreachable', async () => {
    fetchHaEntityState.mockRejectedValue(new Error('HA unreachable'));
    await expect(fetchEvTargetSoc(makeSettings())).resolves.toBeNull();
  });

  it('returns null when the entity state is not a number', async () => {
    fetchHaEntityState.mockResolvedValue({ state: 'unavailable' });
    await expect(fetchEvTargetSoc(makeSettings())).resolves.toBeNull();
  });
});

describe('resolveEvTargetSoc', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('prefers the live entity value over the setting', async () => {
    fetchHaEntityState.mockResolvedValue({ state: '65' });
    await expect(resolveEvTargetSoc(makeSettings())).resolves.toBe(65);
  });

  it('falls back to the setting when the entity is unreadable', async () => {
    fetchHaEntityState.mockRejectedValue(new Error('boom'));
    await expect(resolveEvTargetSoc(makeSettings())).resolves.toBe(80);
  });

  it('falls back to the setting when no entity is configured', async () => {
    await expect(resolveEvTargetSoc(makeSettings({ evTargetSocEntity: '' }))).resolves.toBe(80);
  });
});

describe('fetchEvTargetSoc — unusable entity states fall back', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns null when the entity reports 0 (unsynced helper / wrong entity)', async () => {
    fetchHaEntityState.mockResolvedValue({ state: '0' });
    await expect(fetchEvTargetSoc(makeSettings())).resolves.toBeNull();
    await expect(resolveEvTargetSoc(makeSettings())).resolves.toBe(80);
  });
});
