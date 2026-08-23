import { describe, it, expect } from 'vitest';
import {
  normalizePredictionConfigPatch,
  LOOKBACK_WEEKS_MAX,
  LOOKBACK_WEEKS_MIN,
} from '../../../api/services/prediction-config-schema.ts';

const hp = (overrides = {}) => ({ sensor: 'Total Load', lookbackWeeks: 4, dayFilter: 'same', aggregation: 'mean', ...overrides });

describe('normalizePredictionConfigPatch', () => {
  it('passes a valid full patch through, stripping the server-owned keys', () => {
    const patch = {
      sensors: [{ id: 'sensor.a', name: 'A', unit: 'kWh' }],
      derived: [{ name: 'Total', formula: ['+A'] }],
      activeType: 'historical',
      historicalPredictor: hp(),
      fixedPredictor: { load_W: 250 },
      pvConfig: { latitude: 51.05, longitude: 3.71, historyDays: 14, pvSensor: 'Solar', pvModel: 'clearSkyRatio' },
      includeRecent: false,
      haUrl: 'ws://x', haToken: 't', validationWindow: { start: 'a', end: 'b' },
    };
    const out = normalizePredictionConfigPatch(patch);
    expect(out).not.toHaveProperty('haUrl');
    expect(out).not.toHaveProperty('haToken');
    expect(out).not.toHaveProperty('validationWindow');
    expect(out.historicalPredictor).toEqual(hp());
    expect(out.includeRecent).toBe(false);
  });

  it('validates only the keys present — a strategy-less save is fine', () => {
    expect(normalizePredictionConfigPatch({ pvConfig: { latitude: 1 } })).toEqual({ pvConfig: { latitude: 1 } });
    expect(normalizePredictionConfigPatch({})).toEqual({});
    // Legacy / unknown keys are passed through untouched.
    expect(normalizePredictionConfigPatch({ activeConfig: { sensor: 'x' } })).toEqual({ activeConfig: { sensor: 'x' } });
  });

  it('rejects a non-object payload', () => {
    for (const bad of [null, 'x', 3, [1]]) {
      expect(() => normalizePredictionConfigPatch(bad)).toThrow('prediction config payload must be an object');
    }
  });

  it('bounds lookbackWeeks — a huge value pins the process in predict()', () => {
    expect(() => normalizePredictionConfigPatch({ historicalPredictor: hp({ lookbackWeeks: 20000 }) }))
      .toThrow(`historicalPredictor.lookbackWeeks must be an integer between ${LOOKBACK_WEEKS_MIN} and ${LOOKBACK_WEEKS_MAX}`);
    for (const bad of [0, -1, 1e7, 2.5, NaN, '4', null, undefined]) {
      expect(() => normalizePredictionConfigPatch({ historicalPredictor: hp({ lookbackWeeks: bad }) })).toThrow('lookbackWeeks');
    }
    expect(normalizePredictionConfigPatch({ historicalPredictor: hp({ lookbackWeeks: LOOKBACK_WEEKS_MAX }) }).historicalPredictor.lookbackWeeks).toBe(52);
  });

  it('rejects bad historicalPredictor fields and shapes', () => {
    expect(() => normalizePredictionConfigPatch({ historicalPredictor: 'x' })).toThrow('historicalPredictor must be an object');
    expect(() => normalizePredictionConfigPatch({ historicalPredictor: hp({ sensor: '' }) })).toThrow('historicalPredictor.sensor must be a non-empty string');
    expect(() => normalizePredictionConfigPatch({ historicalPredictor: hp({ dayFilter: 'weekends' }) })).toThrow('historicalPredictor.dayFilter must be one of');
    expect(() => normalizePredictionConfigPatch({ historicalPredictor: hp({ aggregation: 'max' }) })).toThrow('historicalPredictor.aggregation must be one of');
    // Extra keys on the predictor are dropped (only the four declared fields are kept).
    expect(normalizePredictionConfigPatch({ historicalPredictor: hp({ extra: 1 }) }).historicalPredictor).toEqual(hp());
  });

  it('validates activeType, fixedPredictor, sensors, derived and pvConfig', () => {
    expect(() => normalizePredictionConfigPatch({ activeType: 'neural' })).toThrow('activeType must be one of');
    expect(() => normalizePredictionConfigPatch({ fixedPredictor: { load_W: -1 } })).toThrow('fixedPredictor.load_W must be >= 0');
    expect(() => normalizePredictionConfigPatch({ fixedPredictor: { load_W: 'x' } })).toThrow('fixedPredictor.load_W must be a finite number');
    expect(() => normalizePredictionConfigPatch({ fixedPredictor: null })).toThrow('fixedPredictor must be an object');
    expect(() => normalizePredictionConfigPatch({ sensors: {} })).toThrow('sensors must be an array');
    expect(() => normalizePredictionConfigPatch({ sensors: [{ name: 'no id' }] })).toThrow('sensors[0].id must be a non-empty string');
    expect(() => normalizePredictionConfigPatch({ sensors: ['x'] })).toThrow('sensors[0] must be an object');
    expect(() => normalizePredictionConfigPatch({ derived: [{ formula: [] }] })).toThrow('derived[0].name must be a non-empty string');
    expect(() => normalizePredictionConfigPatch({ pvConfig: [] })).toThrow('pvConfig must be an object');
    expect(() => normalizePredictionConfigPatch({ pvConfig: { latitude: 'x' } })).toThrow('pvConfig.latitude must be a finite number');
    expect(() => normalizePredictionConfigPatch({ pvConfig: { longitude: NaN } })).toThrow('pvConfig.longitude must be a finite number');
    expect(() => normalizePredictionConfigPatch({ pvConfig: { historyDays: 0 } })).toThrow('pvConfig.historyDays must be an integer between 1 and 365');
    expect(normalizePredictionConfigPatch({ pvConfig: { pvMode: 'hybrid' } })).toEqual({ pvConfig: { pvMode: 'hybrid' } });
  });
});
