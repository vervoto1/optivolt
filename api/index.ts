import app from './app.ts';
import { startAutoCalculate, stopAutoCalculate } from './services/auto-calculate.ts';
import { startDessPriceRefresh, stopDessPriceRefresh } from './services/dess-price-refresh.ts';
import { reconcilePvCurtailmentAtBoot, startPvCurtailment, stopPvCurtailment } from './services/pv-curtailment.ts';
import { startShoreOptimizer, stopShoreOptimizer } from './services/shore-optimizer.ts';
import { startEvActuator, stopEvActuator } from './services/ev-actuator-service.ts';
import { startBatteryChargeController, stopBatteryChargeController } from './services/battery-charge-controller.ts';
import { startBalanceTuner, stopBalanceTuner } from './services/balance-tuner.ts';
import { startPredictionAutoSelect, stopPredictionAutoSelect } from './services/prediction-auto-select.ts';
import { shutdownVictronClient } from './services/mqtt-service.ts';
import { loadSettings } from './services/settings-store.ts';
import { resolveDataDir, sweepTempFiles } from './services/json-store.ts';
import { createShutdown } from './shutdown.ts';

const rawPort = Number.parseInt(process.env.PORT ?? '', 10);
const port = Number.isFinite(rawPort) ? rawPort : 3000;
const host = process.env.HOST ?? '0.0.0.0';

const shutdown = createShutdown({
  stopTimers: () => {
    stopAutoCalculate();
    stopDessPriceRefresh();
    stopShoreOptimizer();
    stopEvActuator();
    stopBatteryChargeController();
    stopBalanceTuner();
    stopPredictionAutoSelect();
  },
  restorePv: (restoreTimeoutMs) => stopPvCurtailment({ restoreTimeoutMs }),
  closeMqtt: (timeoutMs) => shutdownVictronClient({ timeoutMs }),
  exit: (code) => process.exit(code),
});
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });

app.listen(port, host, () => {
  console.log(`Server listening on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
  console.log(`Node version: ${process.version}`);

  // Temp files left by a write that a hard kill interrupted (non-blocking).
  void sweepTempFiles(resolveDataDir());

  // Start timers (non-blocking)
  loadSettings()
    .then(settings => {
      startAutoCalculate(settings);
      startDessPriceRefresh(settings);
      startPvCurtailment(settings);
      // Undo a PV disable that an earlier process left behind (killed, crashed, power loss).
      reconcilePvCurtailmentAtBoot()
        .catch(err => console.error('[boot] PV curtailment reconcile failed:', (err as Error).message));
      startShoreOptimizer(settings);
      startEvActuator(settings);
      startBatteryChargeController(settings);
      startBalanceTuner(settings);
      // Only the boot path arms the catch-up run (see startPredictionAutoSelect).
      startPredictionAutoSelect(settings, { runCatchUp: true });
    })
    .catch(err => console.error('[boot] Failed to start timers:', err.message));
});
