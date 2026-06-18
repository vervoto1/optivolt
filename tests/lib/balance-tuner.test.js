import { describe, it, expect } from 'vitest';
import { decideBalanceSettings } from '../../lib/balance-tuner.ts';

const policy = {
  highCurrentThreshold_A: 50,
  tightTrigger: 0.005,
  looseTrigger: 0.02,
  step: 0.05,
  topCap: 3.55,
  criticalHighVoltage: 3.549,
  topStart: 3.45,
  bottomTop: 3.4,
  bottomFloor: 2.9,
  maxWarnVoltage: 3.6,
};

const decide = (v, i = 0) => decideBalanceSettings(v, i, policy);

describe('decideBalanceSettings — high current back-off', () => {
  it('overrides voltage logic with a high start + loose trigger', () => {
    const d = decide(3.3, 60);
    expect(d.reason).toBe('high_current');
    expect(d.startVoltage).toBe(3.55);
    expect(d.triggerVoltage).toBe(0.02);
  });

  it('treats large discharge current the same (abs value)', () => {
    expect(decide(3.3, -80).reason).toBe('high_current');
  });
});

describe('decideBalanceSettings — top region (tight trigger)', () => {
  it('quantizes the start voltage within the top window', () => {
    expect(decide(3.45).startVoltage).toBe(3.45);
    expect(decide(3.47).startVoltage).toBe(3.45);
    expect(decide(3.5).startVoltage).toBe(3.5);
    expect(decide(3.5).triggerVoltage).toBe(0.005);
    expect(decide(3.5).reason).toBe('top');
  });

  it('pins critical-high to the clamped top value', () => {
    const d = decide(3.58);
    expect(d.reason).toBe('critical_high');
    expect(d.startVoltage).toBe(3.5);
    expect(d.triggerVoltage).toBe(0.005);
  });
});

describe('decideBalanceSettings — transition + bottom', () => {
  it('fixes the transition band start at bottomTop with a loose trigger', () => {
    const d = decide(3.42);
    expect(d.reason).toBe('transition');
    expect(d.startVoltage).toBe(3.4);
    expect(d.triggerVoltage).toBe(0.02);
  });

  it('tracks the bottom region down in steps', () => {
    const d = decide(3.3);
    expect(d.reason).toBe('bottom');
    expect(d.startVoltage).toBe(3.3);
    expect(d.triggerVoltage).toBe(0.02);
  });

  it('never drops the start below the floor', () => {
    const d = decide(2.85);
    expect(d.startVoltage).toBe(2.9);
    expect(d.reason).toBe('bottom');
  });
});

describe('decideBalanceSettings — out-of-range warning', () => {
  it('flags voltages below the floor', () => {
    expect(decide(2.8).warning).toBe(true);
  });
  it('flags voltages above the warn cap', () => {
    expect(decide(3.7).warning).toBe(true);
  });
  it('does not flag a normal voltage', () => {
    expect(decide(3.3).warning).toBe(false);
  });
});

describe('decideBalanceSettings — degenerate step (step <= 0)', () => {
  // When step <= 0 the quantizer can't grid-snap; it simply clamps the raw
  // voltage into [base, cap]. Exercised via the bottom region where the start
  // is computed with steppedVoltage(v, bottomFloor, step, topCap).
  const zeroStepPolicy = { ...policy, step: 0 };

  it('clamps the raw voltage into [bottomFloor, topCap] in the bottom region', () => {
    // v=3.3 is in the bottom band (< bottomTop 3.4); with step 0 the start is
    // clamped to the raw voltage 3.3 (between floor 2.9 and cap 3.55).
    const d = decideBalanceSettings(3.3, 0, zeroStepPolicy);
    expect(d.reason).toBe('bottom');
    expect(d.startVoltage).toBe(3.3);
  });

  it('clamps up to the floor when the voltage is below it', () => {
    // v=2.85 < bottomFloor 2.9 → Math.max(base, v) lifts it to the floor.
    const d = decideBalanceSettings(2.85, 0, zeroStepPolicy);
    expect(d.reason).toBe('bottom');
    expect(d.startVoltage).toBe(2.9);
    expect(d.warning).toBe(true);
  });

  it('clamps down to the topCap in the top region', () => {
    // v=3.5 (top band). With step 0, steppedVoltage returns min(cap, max(base, v))
    // = min(3.55, max(3.45, 3.5)) = 3.5.
    const d = decideBalanceSettings(3.5, 0, zeroStepPolicy);
    expect(d.reason).toBe('top');
    expect(d.startVoltage).toBe(3.5);
  });
});
