import { assertCondition } from '../http-errors.ts';
import { updateData } from './data-store.ts';
import type { PredictionAdjustment } from '../types.ts';
import type { PredictionAdjustmentInput } from './prediction-adjustments.ts';
import {
  createPredictionAdjustment,
  pruneExpiredPredictionAdjustments,
  updatePredictionAdjustment,
} from './prediction-adjustments.ts';

// Every function here is a locked read-modify-write of data.json (updateData):
// the adjustment list is patched onto the file as it is now, so a concurrent
// planner or forecast write can neither revert nor be reverted by it.

export async function loadActiveAdjustmentsAndPrune() {
  let adjustments: PredictionAdjustment[] = [];
  const data = await updateData(current => {
    const pruned = pruneExpiredPredictionAdjustments(current);
    adjustments = pruned.adjustments;
    return pruned.changed ? pruned.data : null;
  });
  return { data, adjustments };
}

export async function createStoredPredictionAdjustment(input: PredictionAdjustmentInput) {
  // Validate (and build) outside the lock so a 400 never touches the file.
  const adjustment = createPredictionAdjustment(input);
  let adjustments: PredictionAdjustment[] = [];
  await updateData(current => {
    const { data: pruned } = pruneExpiredPredictionAdjustments(current);
    adjustments = [...(pruned.predictionAdjustments ?? []), adjustment];
    return { ...pruned, predictionAdjustments: adjustments };
  });
  return { adjustment, adjustments };
}

export async function updateStoredPredictionAdjustment(id: string, input: PredictionAdjustmentInput) {
  let updated!: PredictionAdjustment;
  let nextAdjustments: PredictionAdjustment[] = [];
  await updateData(current => {
    const { data: pruned } = pruneExpiredPredictionAdjustments(current);
    const adjustments = pruned.predictionAdjustments ?? [];
    const index = adjustments.findIndex(adj => adj.id === id);
    assertCondition(index >= 0, 404, 'Prediction adjustment not found');

    updated = updatePredictionAdjustment(adjustments[index], input);
    nextAdjustments = adjustments.map((adj, i) => i === index ? updated : adj);
    return { ...pruned, predictionAdjustments: nextAdjustments };
  });
  return { adjustment: updated, adjustments: nextAdjustments };
}

export async function deleteStoredPredictionAdjustment(id: string) {
  let nextAdjustments: PredictionAdjustment[] = [];
  await updateData(current => {
    const { data: pruned } = pruneExpiredPredictionAdjustments(current);
    const adjustments = pruned.predictionAdjustments ?? [];
    nextAdjustments = adjustments.filter(adj => adj.id !== id);
    assertCondition(nextAdjustments.length !== adjustments.length, 404, 'Prediction adjustment not found');
    return { ...pruned, predictionAdjustments: nextAdjustments };
  });
  return { adjustments: nextAdjustments };
}
