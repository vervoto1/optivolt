import { fetchStoredSettings, saveStoredSettings } from "./api/api.js";

// Load exactly what the API has; do not merge client defaults anymore.
export async function loadInitialConfig() {
  try {
    const data = await fetchStoredSettings();
    // If /settings doesn’t exist yet, handler returns server defaults.
    // Otherwise, it’s the user’s persisted snapshot.
    return { config: data || {}, source: "api" };
  } catch (error) {
    console.error("Failed to load settings from API", error);
    // Stay minimal: return empty config; inputs keep their HTML values/placeholders.
    return { config: {}, source: "api-error" };
  }
}

// Resolves to the server's reply, `{ message, settings }`, where `settings`
// is the stored result after the server merged and normalised the patch.
export async function saveConfig(config) {
  return saveStoredSettings(config);
}
