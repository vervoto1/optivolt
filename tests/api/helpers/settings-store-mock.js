/**
 * Give a mocked `settings-store` an `updateSettings` with the real contract —
 * load → mutate → save unless null — so tests keep asserting on
 * `saveSettings` (what was persisted) after the writers moved to the locked
 * read-modify-write. Call it after `vi.resetAllMocks()`, which drops the
 * implementation again.
 */
export function wireUpdateSettings({ loadSettings, saveSettings, updateSettings }) {
  updateSettings.mockImplementation(async (mutate) => {
    const next = mutate(await loadSettings());
    if (next) await saveSettings(next);
    return next;
  });
}
