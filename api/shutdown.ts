/**
 * Graceful SIGTERM/SIGINT handling, kept apart from index.ts so it can be tested.
 *
 * Budget: s6-overlay waits S6_SERVICES_GRACETIME (3 s by default) after SIGTERM and
 * then SIGKILLs, so every step is bounded and a hard-stop timer armed first
 * guarantees the exit. Order matters:
 *  1. stop the timers, so no new hardware write starts;
 *  2. restore PV curtailment (bounded; an unconfirmed restore stays persisted and is
 *     reconciled at the next boot);
 *  3. close the MQTT client (bounded; force-ended on timeout). The graceful close
 *     flushes the QoS-0 writes still corked in the socket: exiting right after an
 *     awaited publish would otherwise drop the PV restore.
 * Repeated signals share the one shutdown already in progress.
 */
export const SHUTDOWN_RESTORE_TIMEOUT_MS = 2000;
export const SHUTDOWN_MQTT_CLOSE_TIMEOUT_MS = 400;
export const SHUTDOWN_DEADLINE_MS = 2500;

export interface ShutdownDeps {
  stopTimers: () => void;
  restorePv: (timeoutMs: number) => Promise<void>;
  closeMqtt: (timeoutMs: number) => Promise<void>;
  exit: (code: number) => void;
  deadlineMs?: number;
  restoreTimeoutMs?: number;
  mqttCloseTimeoutMs?: number;
}

export function createShutdown({
  stopTimers,
  restorePv,
  closeMqtt,
  exit,
  deadlineMs = SHUTDOWN_DEADLINE_MS,
  restoreTimeoutMs = SHUTDOWN_RESTORE_TIMEOUT_MS,
  mqttCloseTimeoutMs = SHUTDOWN_MQTT_CLOSE_TIMEOUT_MS,
}: ShutdownDeps): (signal: string) => Promise<void> {
  let inProgress: Promise<void> | null = null;

  async function run(signal: string): Promise<void> {
    console.log(`[shutdown] ${signal} received`);
    const hardStop = setTimeout(() => {
      console.error(`[shutdown] did not finish within ${deadlineMs}ms; exiting`);
      exit(1);
    }, deadlineMs);
    hardStop.unref?.();

    try {
      stopTimers();
    } catch (err) {
      console.warn('[shutdown] stopping timers failed:', (err as Error).message);
    }
    try {
      await restorePv(restoreTimeoutMs);
    } catch (err) {
      console.warn('[shutdown] PV restore failed:', (err as Error).message);
    }
    try {
      await closeMqtt(mqttCloseTimeoutMs);
    } catch (err) {
      console.warn('[shutdown] MQTT close failed:', (err as Error).message);
    }
    clearTimeout(hardStop);
    exit(0);
  }

  return (signal: string) => {
    if (!inProgress) inProgress = run(signal);
    return inProgress;
  };
}
