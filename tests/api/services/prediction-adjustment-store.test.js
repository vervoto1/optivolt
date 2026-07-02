import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../api/services/data-store.ts');

import { loadData, saveData } from '../../../api/services/data-store.ts';
import {
  createStoredPredictionAdjustment,
  deleteStoredPredictionAdjustment,
  loadActiveAdjustmentsAndPrune,
  updateStoredPredictionAdjustment,
} from '../../../api/services/prediction-adjustment-store.ts';

// Far-future bounds so adjustments never count as expired during the test run.
const FUTURE_START = '2099-01-01T00:00:00.000Z';
const FUTURE_END = '2099-01-01T01:00:00.000Z';
const PAST_END = '2000-01-01T01:00:00.000Z';

function storedAdjustment(overrides = {}) {
  return {
    id: 'adj-1',
    series: 'load',
    mode: 'add',
    value_W: 100,
    start: FUTURE_START,
    end: FUTURE_END,
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const validInput = {
  series: 'pv',
  mode: 'set',
  value_W: 0,
  start: FUTURE_START,
  end: FUTURE_END,
  label: 'cloudy',
};

describe('prediction-adjustment-store', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    saveData.mockResolvedValue();
  });

  describe('loadActiveAdjustmentsAndPrune', () => {
    it('returns active adjustments and persists when pruning removed expired ones', async () => {
      loadData.mockResolvedValue({
        load: {},
        predictionAdjustments: [
          storedAdjustment({ id: 'active' }),
          storedAdjustment({ id: 'expired', end: PAST_END }),
        ],
      });

      const result = await loadActiveAdjustmentsAndPrune();

      expect(result.adjustments.map(a => a.id)).toEqual(['active']);
      expect(saveData).toHaveBeenCalledTimes(1);
      expect(saveData.mock.calls[0][0].predictionAdjustments.map(a => a.id)).toEqual(['active']);
      expect(result.data.predictionAdjustments.map(a => a.id)).toEqual(['active']);
    });

    it('does not save when nothing expired', async () => {
      loadData.mockResolvedValue({
        load: {},
        predictionAdjustments: [storedAdjustment({ id: 'active' })],
      });

      const result = await loadActiveAdjustmentsAndPrune();

      expect(result.adjustments.map(a => a.id)).toEqual(['active']);
      expect(saveData).not.toHaveBeenCalled();
    });

    it('handles data with no adjustments', async () => {
      loadData.mockResolvedValue({ load: {} });
      const result = await loadActiveAdjustmentsAndPrune();
      expect(result.adjustments).toEqual([]);
      expect(saveData).not.toHaveBeenCalled();
    });
  });

  describe('createStoredPredictionAdjustment', () => {
    it('appends a created adjustment to the existing (pruned) list and persists', async () => {
      loadData.mockResolvedValue({
        load: {},
        predictionAdjustments: [
          storedAdjustment({ id: 'keep' }),
          storedAdjustment({ id: 'expired', end: PAST_END }),
        ],
      });

      const { adjustment, adjustments } = await createStoredPredictionAdjustment(validInput);

      // Pruned away the expired one, kept 'keep', appended the new one.
      expect(adjustments.map(a => a.id)).toEqual(['keep', adjustment.id]);
      expect(adjustment.series).toBe('pv');
      expect(adjustment.mode).toBe('set');
      expect(adjustment.value_W).toBe(0);
      expect(adjustment.label).toBe('cloudy');
      expect(typeof adjustment.id).toBe('string');

      expect(saveData).toHaveBeenCalledTimes(1);
      const saved = saveData.mock.calls[0][0];
      expect(saved.predictionAdjustments.map(a => a.id)).toEqual(['keep', adjustment.id]);
    });

    it('creates into an empty list when there are no existing adjustments', async () => {
      loadData.mockResolvedValue({ load: {} });

      const { adjustments } = await createStoredPredictionAdjustment(validInput);

      expect(adjustments).toHaveLength(1);
      expect(saveData).toHaveBeenCalledTimes(1);
    });

    it('propagates validation errors and does not persist', async () => {
      loadData.mockResolvedValue({ load: {}, predictionAdjustments: [] });

      await expect(
        createStoredPredictionAdjustment({ ...validInput, series: 'grid' }),
      ).rejects.toThrowError('series must be "load" or "pv"');
      expect(saveData).not.toHaveBeenCalled();
    });
  });

  describe('updateStoredPredictionAdjustment', () => {
    it('updates the matching adjustment in place and persists', async () => {
      loadData.mockResolvedValue({
        load: {},
        predictionAdjustments: [
          storedAdjustment({ id: 'a', value_W: 100 }),
          storedAdjustment({ id: 'b', value_W: 200 }),
        ],
      });

      const { adjustment, adjustments } = await updateStoredPredictionAdjustment('b', { value_W: 999 });

      expect(adjustment.id).toBe('b');
      expect(adjustment.value_W).toBe(999);
      expect(adjustments.map(a => a.id)).toEqual(['a', 'b']);
      expect(adjustments.find(a => a.id === 'a').value_W).toBe(100);
      expect(adjustments.find(a => a.id === 'b').value_W).toBe(999);

      expect(saveData).toHaveBeenCalledTimes(1);
      const saved = saveData.mock.calls[0][0];
      expect(saved.predictionAdjustments.find(a => a.id === 'b').value_W).toBe(999);
    });

    it('throws 404 when the id is not found and does not persist', async () => {
      loadData.mockResolvedValue({
        load: {},
        predictionAdjustments: [storedAdjustment({ id: 'a' })],
      });

      await expect(updateStoredPredictionAdjustment('missing', { value_W: 1 }))
        .rejects.toMatchObject({ statusCode: 404, message: 'Prediction adjustment not found' });
      expect(saveData).not.toHaveBeenCalled();
    });

    it('throws 404 when the id was expired (pruned before lookup)', async () => {
      loadData.mockResolvedValue({
        load: {},
        predictionAdjustments: [storedAdjustment({ id: 'gone', end: PAST_END })],
      });

      await expect(updateStoredPredictionAdjustment('gone', { value_W: 1 }))
        .rejects.toMatchObject({ statusCode: 404 });
      expect(saveData).not.toHaveBeenCalled();
    });

    it('handles data with no adjustments (404)', async () => {
      loadData.mockResolvedValue({ load: {} });
      await expect(updateStoredPredictionAdjustment('x', { value_W: 1 }))
        .rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('deleteStoredPredictionAdjustment', () => {
    it('removes the matching adjustment and persists', async () => {
      loadData.mockResolvedValue({
        load: {},
        predictionAdjustments: [
          storedAdjustment({ id: 'a' }),
          storedAdjustment({ id: 'b' }),
        ],
      });

      const { adjustments } = await deleteStoredPredictionAdjustment('a');

      expect(adjustments.map(x => x.id)).toEqual(['b']);
      expect(saveData).toHaveBeenCalledTimes(1);
      expect(saveData.mock.calls[0][0].predictionAdjustments.map(x => x.id)).toEqual(['b']);
    });

    it('throws 404 when nothing matches and does not persist', async () => {
      loadData.mockResolvedValue({
        load: {},
        predictionAdjustments: [storedAdjustment({ id: 'a' })],
      });

      await expect(deleteStoredPredictionAdjustment('missing'))
        .rejects.toMatchObject({ statusCode: 404, message: 'Prediction adjustment not found' });
      expect(saveData).not.toHaveBeenCalled();
    });

    it('throws 404 when there are no adjustments at all', async () => {
      loadData.mockResolvedValue({ load: {} });
      await expect(deleteStoredPredictionAdjustment('x'))
        .rejects.toMatchObject({ statusCode: 404 });
      expect(saveData).not.toHaveBeenCalled();
    });
  });
});
