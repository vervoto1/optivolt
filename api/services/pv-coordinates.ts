/**
 * Whether a PV config carries a usable site location.
 *
 * Missing (null/undefined), non-finite and the exact (0, 0) pair all count as
 * unset. (0, 0) is "Null Island" in the Gulf of Guinea: it is what a blank
 * coordinate field used to save as, and a PV forecast fitted to equatorial
 * irradiance there would feed a wrong PV series into every plan. No real
 * installation sits at exactly 0°, 0°.
 */
export function hasPvCoordinates(
  pvConfig: { latitude?: number | null; longitude?: number | null } | null | undefined,
): boolean {
  if (!pvConfig) return false;
  const { latitude, longitude } = pvConfig;
  if (typeof latitude !== 'number' || !Number.isFinite(latitude)) return false;
  if (typeof longitude !== 'number' || !Number.isFinite(longitude)) return false;
  return !(latitude === 0 && longitude === 0);
}

export const MISSING_PV_COORDINATES_MESSAGE =
  'Latitude and longitude must be configured for PV forecasting';
