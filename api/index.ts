import app from './app.ts';
import { startAutoCalculate, stopAutoCalculate } from './services/auto-calculate.ts';
import { startDessPriceRefresh, stopDessPriceRefresh } from './services/dess-price-refresh.ts';
import { loadSettings } from './services/settings-store.ts';

const rawPort = Number.parseInt(process.env.PORT ?? '', 10);
const port = Number.isFinite(rawPort) ? rawPort : 3000;
const host = process.env.HOST ?? '0.0.0.0';

async function shutdown() {
  stopAutoCalculate();
  stopDessPriceRefresh();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

app.listen(port, host, () => {
  console.log(`Server listening on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
  console.log(`Node version: ${process.version}`);

  // Start timers (non-blocking)
  loadSettings()
    .then(settings => {
      startAutoCalculate(settings);
      startDessPriceRefresh(settings);
    })
    .catch(err => console.error('[boot] Failed to start timers:', err.message));
});
