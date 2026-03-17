#!/usr/bin/env npx tsx
/**
 * One-off script: write TargetSoc=100 to all 48 DESS schedule slots.
 * Usage: MQTT_HOST=venus.local npx tsx scripts/write-target-soc.ts
 */
import { withVictronMqtt } from '../lib/victron-mqtt.ts';

const host = process.env.MQTT_HOST ?? 'venus.local';
const tls = process.env.MQTT_TLS === 'true' || process.env.MQTT_TLS === '1';
const username = process.env.MQTT_USERNAME ?? '';
const password = process.env.MQTT_PASSWORD ?? '';

const TARGET_SOC = 100;

await withVictronMqtt({ host, tls, username, password }, async (client) => {
  const serial = await client.getSerial();
  console.log(`Connected, serial: ${serial}`);

  const tasks = [];
  for (let i = 0; i < 48; i++) {
    const base = `settings/0/Settings/DynamicEss/Schedule/${i}`;
    tasks.push(client.writeSetting(`${base}/Soc`, TARGET_SOC, { serial }));
    tasks.push(client.writeSetting(`${base}/TargetSoc`, TARGET_SOC, { serial }));
  }
  await Promise.all(tasks);
  console.log(`Wrote Soc=${TARGET_SOC} and TargetSoc=${TARGET_SOC} to all 48 slots`);
});
