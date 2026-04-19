/**
 * Small retry helper for transient network failures (VRM, HA, Open-Meteo, …).
 * Uses exponential backoff so a brief outage doesn't leave the caller with
 * stale data for the whole auto-calc interval.
 */
export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  label?: string;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  { attempts = 3, baseDelayMs = 500, label = 'op' }: RetryOptions = {},
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        const delay = baseDelayMs * Math.pow(3, i);
        console.warn(
          `[retry] ${label} attempt ${i + 1}/${attempts} failed: ${(err as Error).message}. Retrying in ${delay}ms…`,
        );
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}
