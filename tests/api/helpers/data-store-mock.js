/**
 * Give a mocked `data-store` an `updateData` with the real contract —
 * load → mutate → save unless null, resolving to the data as it stands
 * afterwards — so tests keep asserting on `saveData` (what was persisted)
 * after the writers moved to the locked read-modify-write. Call it after
 * `vi.resetAllMocks()`, which drops the implementation again.
 */
export function wireUpdateData({ loadData, saveData, updateData }) {
  updateData.mockImplementation(async (mutate) => {
    const current = await loadData();
    const next = mutate(current);
    if (!next) return current;
    await saveData(next);
    return next;
  });
}
