import { describe, expect, it } from 'vitest';
import {
  applyPredictionAdjustmentsToData,
  applyPredictionAdjustmentsToSeries,
  createPredictionAdjustment,
  pruneExpiredPredictionAdjustments,
  updatePredictionAdjustment,
  validatePredictionAdjustment,
} from '../../../api/services/prediction-adjustments.ts';

const series = {
  start: '2026-01-01T00:00:00.000Z',
  step: 15,
  values: [100, 200, 300, 400, 500],
};

function adjustment(overrides = {}) {
  return {
    id: 'adj-1',
    series: 'load',
    mode: 'add',
    value_W: 50,
    start: '2026-01-01T00:15:00.000Z',
    end: '2026-01-01T00:45:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('prediction adjustments', () => {
  it('adds watts across the half-open selected range', () => {
    const adjusted = applyPredictionAdjustmentsToSeries(series, [adjustment()], 'load');
    expect(adjusted.values).toEqual([100, 250, 350, 400, 500]);
  });

  it('sets PV to zero across the selected range', () => {
    const adjusted = applyPredictionAdjustmentsToSeries(series, [
      adjustment({ series: 'pv', mode: 'set', value_W: 0, start: '2026-01-01T00:00:00.000Z', end: '2026-01-01T00:30:00.000Z' }),
    ], 'pv');
    expect(adjusted.values).toEqual([0, 0, 300, 400, 500]);
  });

  it('keeps the earlier-listed set when a later-listed set has an older updatedAt', () => {
    const adjusted = applyPredictionAdjustmentsToSeries(series, [
      // set-new is listed first and has the newer updatedAt; set-old comes later
      // with an older updatedAt, exercising the "best wins" branch of the reduce.
      adjustment({ id: 'set-new', mode: 'set', value_W: 800, start: '2026-01-01T00:15:00.000Z', end: '2026-01-01T00:30:00.000Z', updatedAt: '2026-01-01T00:05:00.000Z' }),
      adjustment({ id: 'set-old', mode: 'set', value_W: 111, start: '2026-01-01T00:15:00.000Z', end: '2026-01-01T00:30:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }),
    ], 'load');
    expect(adjusted.values[1]).toBe(800);
  });

  it('uses the most recently updated set adjustment as the baseline and stacks add adjustments', () => {
    const adjusted = applyPredictionAdjustmentsToSeries(series, [
      // set-2 has a later updatedAt so it wins as the baseline at the overlapping slot
      adjustment({ id: 'set-1', mode: 'set', value_W: 900, start: '2026-01-01T00:15:00.000Z', end: '2026-01-01T01:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }),
      adjustment({ id: 'set-2', mode: 'set', value_W: 700, start: '2026-01-01T00:30:00.000Z', end: '2026-01-01T00:45:00.000Z', updatedAt: '2026-01-01T00:01:00.000Z' }),
      adjustment({ id: 'add-1', mode: 'add', value_W: 25, start: '2026-01-01T00:30:00.000Z', end: '2026-01-01T00:45:00.000Z' }),
    ], 'load');
    // slot 1: only set-1 → 900; slot 2: set-2 wins (latest updatedAt) → 700 + 25 = 725; slot 3: only set-1 → 900
    expect(adjusted.values).toEqual([100, 900, 725, 900, 500]);
  });

  it('clamps negative adjusted values to zero', () => {
    const adjusted = applyPredictionAdjustmentsToSeries(series, [
      adjustment({ mode: 'add', value_W: -500, start: '2026-01-01T00:00:00.000Z', end: '2026-01-01T00:30:00.000Z' }),
    ], 'load');
    expect(adjusted.values).toEqual([0, 0, 300, 400, 500]);
  });

  it('applies load and PV adjustments independently to data', () => {
    const data = {
      load: series,
      pv: series,
      importPrice: series,
      exportPrice: series,
      soc: { timestamp: '2026-01-01T00:00:00.000Z', value: 50 },
      predictionAdjustments: [
        adjustment({ series: 'load', mode: 'add', value_W: 100 }),
        adjustment({ series: 'pv', mode: 'set', value_W: 0 }),
      ],
    };
    const adjusted = applyPredictionAdjustmentsToData(data);
    expect(adjusted.load.values).toEqual([100, 300, 400, 400, 500]);
    expect(adjusted.pv.values).toEqual([100, 0, 0, 400, 500]);
  });

  it('prunes expired adjustments', () => {
    const data = {
      load: series,
      pv: series,
      importPrice: series,
      exportPrice: series,
      soc: { timestamp: '2026-01-01T00:00:00.000Z', value: 50 },
      predictionAdjustments: [
        adjustment({ id: 'old', end: '2026-01-01T00:15:00.000Z' }),
        adjustment({ id: 'active', end: '2026-01-01T01:00:00.000Z' }),
      ],
    };
    const result = pruneExpiredPredictionAdjustments(data, new Date('2026-01-01T00:30:00.000Z').getTime());
    expect(result.changed).toBe(true);
    expect(result.adjustments.map(adj => adj.id)).toEqual(['active']);
  });

  it('returns the same data reference unchanged when nothing is expired', () => {
    const data = {
      load: series,
      pv: series,
      predictionAdjustments: [adjustment({ id: 'active', end: '2026-01-01T01:00:00.000Z' })],
    };
    const result = pruneExpiredPredictionAdjustments(data, new Date('2026-01-01T00:30:00.000Z').getTime());
    expect(result.changed).toBe(false);
    expect(result.data).toBe(data);
    expect(result.adjustments.map(adj => adj.id)).toEqual(['active']);
  });

  it('treats missing predictionAdjustments as an empty active list', () => {
    const data = { load: series, pv: series };
    const result = pruneExpiredPredictionAdjustments(data, Date.now());
    expect(result.changed).toBe(false);
    expect(result.adjustments).toEqual([]);
  });

  it('returns the original series when no adjustments target it', () => {
    const out = applyPredictionAdjustmentsToSeries(series, [adjustment({ series: 'pv' })], 'load');
    expect(out).toBe(series);
  });

  it('returns the original series when adjustments list is undefined', () => {
    const out = applyPredictionAdjustmentsToSeries(series, undefined, 'load');
    expect(out).toBe(series);
  });

  it('defaults to a 15-minute step when series.step is absent', () => {
    const noStep = { start: '2026-01-01T00:00:00.000Z', values: [100, 200, 300] };
    const out = applyPredictionAdjustmentsToSeries(noStep, [
      adjustment({ mode: 'add', value_W: 10, start: '2026-01-01T00:15:00.000Z', end: '2026-01-01T00:30:00.000Z' }),
    ], 'load');
    // Only slot index 1 (00:15) is inside the half-open window.
    expect(out.values).toEqual([100, 210, 300]);
  });

  it('returns data unchanged when there are no adjustments at all', () => {
    const data = { load: series, pv: series };
    expect(applyPredictionAdjustmentsToData(data)).toBe(data);
  });

  it('returns data unchanged when predictionAdjustments is an empty array', () => {
    const data = { load: series, pv: series, predictionAdjustments: [] };
    expect(applyPredictionAdjustmentsToData(data)).toBe(data);
  });
});

describe('createPredictionAdjustment', () => {
  const nowMs = new Date('2026-01-01T00:00:00.000Z').getTime();
  const validInput = {
    series: 'load',
    mode: 'add',
    value_W: 250,
    start: '2026-01-01T01:00:00.000Z',
    end: '2026-01-01T02:00:00.000Z',
    label: '  spike  ',
  };

  it('creates an adjustment with a uuid, normalized ISO timestamps and createdAt/updatedAt', () => {
    const adj = createPredictionAdjustment(validInput, nowMs);
    expect(typeof adj.id).toBe('string');
    expect(adj.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/i);
    expect(adj.series).toBe('load');
    expect(adj.mode).toBe('add');
    expect(adj.value_W).toBe(250);
    expect(adj.start).toBe('2026-01-01T01:00:00.000Z');
    expect(adj.end).toBe('2026-01-01T02:00:00.000Z');
    expect(adj.label).toBe('spike');
    expect(adj.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(adj.updatedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('omits the label key entirely when label is blank', () => {
    const adj = createPredictionAdjustment({ ...validInput, label: '   ' }, nowMs);
    expect('label' in adj).toBe(false);
  });

  it('omits the label key when label is null', () => {
    const adj = createPredictionAdjustment({ ...validInput, label: null }, nowMs);
    expect('label' in adj).toBe(false);
  });

  it('truncates an over-long label to 120 characters', () => {
    const adj = createPredictionAdjustment({ ...validInput, label: 'x'.repeat(200) }, nowMs);
    expect(adj.label).toHaveLength(120);
  });

  it('coerces a numeric string value_W to a number', () => {
    const adj = createPredictionAdjustment({ ...validInput, value_W: '300' }, nowMs);
    expect(adj.value_W).toBe(300);
  });

  it('rejects an invalid series', () => {
    expect(() => createPredictionAdjustment({ ...validInput, series: 'grid' }, nowMs))
      .toThrowError('series must be "load" or "pv"');
  });

  it('rejects an invalid mode', () => {
    expect(() => createPredictionAdjustment({ ...validInput, mode: 'multiply' }, nowMs))
      .toThrowError('mode must be "set" or "add"');
  });

  it('rejects a non-finite value_W', () => {
    expect(() => createPredictionAdjustment({ ...validInput, value_W: 'abc' }, nowMs))
      .toThrowError('value_W must be a finite number');
  });

  it('rejects a negative value_W for set mode', () => {
    expect(() => createPredictionAdjustment({ ...validInput, mode: 'set', value_W: -1 }, nowMs))
      .toThrowError('set adjustments require value_W >= 0');
  });

  it('allows a negative value_W for add mode', () => {
    const adj = createPredictionAdjustment({ ...validInput, mode: 'add', value_W: -100 }, nowMs);
    expect(adj.value_W).toBe(-100);
  });

  it('rejects an unparseable start timestamp', () => {
    expect(() => createPredictionAdjustment({ ...validInput, start: 'not-a-date' }, nowMs))
      .toThrowError('start must be a valid timestamp');
  });

  it('rejects a missing start (falls back to empty string)', () => {
    const { start: _start, ...noStart } = validInput;
    expect(() => createPredictionAdjustment(noStart, nowMs))
      .toThrowError('start must be a valid timestamp');
  });

  it('rejects a missing end (falls back to empty string)', () => {
    const { end: _end, ...noEnd } = validInput;
    expect(() => createPredictionAdjustment(noEnd, nowMs))
      .toThrowError('end must be a valid timestamp');
  });

  it('rejects an unparseable end timestamp', () => {
    expect(() => createPredictionAdjustment({ ...validInput, end: 'not-a-date' }, nowMs))
      .toThrowError('end must be a valid timestamp');
  });

  it('rejects when end is not after start', () => {
    expect(() => createPredictionAdjustment({
      ...validInput,
      start: '2026-01-01T02:00:00.000Z',
      end: '2026-01-01T02:00:00.000Z',
    }, nowMs)).toThrowError('end must be after start');
  });

  it('rejects when end is in the past relative to now', () => {
    expect(() => createPredictionAdjustment({
      ...validInput,
      start: '2025-01-01T00:00:00.000Z',
      end: '2025-01-01T01:00:00.000Z',
    }, nowMs)).toThrowError('end must be in the future');
  });
});

describe('updatePredictionAdjustment', () => {
  const nowMs = new Date('2026-01-01T00:00:00.000Z').getTime();
  const existing = {
    id: 'keep-me',
    series: 'load',
    mode: 'add',
    value_W: 100,
    start: '2026-01-01T01:00:00.000Z',
    end: '2026-01-01T02:00:00.000Z',
    label: 'orig',
    createdAt: '2025-12-31T00:00:00.000Z',
    updatedAt: '2025-12-31T00:00:00.000Z',
  };

  it('applies partial updates, falling back to existing fields, and bumps updatedAt', () => {
    const updated = updatePredictionAdjustment(existing, { value_W: 500 }, nowMs);
    expect(updated.id).toBe('keep-me');
    expect(updated.createdAt).toBe('2025-12-31T00:00:00.000Z');
    expect(updated.value_W).toBe(500);
    expect(updated.series).toBe('load');
    expect(updated.mode).toBe('add');
    expect(updated.start).toBe('2026-01-01T01:00:00.000Z');
    expect(updated.end).toBe('2026-01-01T02:00:00.000Z');
    expect(updated.label).toBe('orig');
    expect(updated.updatedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('can switch mode and override fields from input', () => {
    const updated = updatePredictionAdjustment(existing, {
      mode: 'set',
      value_W: 0,
      series: 'pv',
    }, nowMs);
    expect(updated.mode).toBe('set');
    expect(updated.series).toBe('pv');
    expect(updated.value_W).toBe(0);
  });

  it('rejects an update that makes end non-future', () => {
    expect(() => updatePredictionAdjustment(existing, {
      start: '2025-01-01T00:00:00.000Z',
      end: '2025-01-01T01:00:00.000Z',
    }, nowMs)).toThrowError('end must be in the future');
  });
});

describe('validatePredictionAdjustment', () => {
  function valid(overrides = {}) {
    return {
      id: 'adj-1',
      series: 'load',
      mode: 'add',
      value_W: 50,
      start: '2020-01-01T00:00:00.000Z',
      end: '2020-01-01T01:00:00.000Z',
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
      ...overrides,
    };
  }

  it('accepts a well-formed persisted adjustment (past end is fine: nowMs=0)', () => {
    expect(() => validatePredictionAdjustment(valid())).not.toThrow();
  });

  it('throws when id is missing', () => {
    expect(() => validatePredictionAdjustment(valid({ id: undefined })))
      .toThrowError('Invalid predictionAdjustments: id must be a string');
  });

  it('throws when id is not a string', () => {
    expect(() => validatePredictionAdjustment(valid({ id: 123 })))
      .toThrowError('Invalid predictionAdjustments: id must be a string');
  });

  it('throws when createdAt is not a valid timestamp', () => {
    expect(() => validatePredictionAdjustment(valid({ createdAt: 'nope' })))
      .toThrowError('Invalid predictionAdjustments: createdAt must be a valid timestamp');
  });

  it('throws when updatedAt is not a valid timestamp', () => {
    expect(() => validatePredictionAdjustment(valid({ updatedAt: 'nope' })))
      .toThrowError('Invalid predictionAdjustments: updatedAt must be a valid timestamp');
  });

  it('propagates field validation errors (bad series)', () => {
    expect(() => validatePredictionAdjustment(valid({ series: 'grid' })))
      .toThrowError('series must be "load" or "pv"');
  });
});
