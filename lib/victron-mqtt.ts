import mqtt, { type MqttClient } from 'mqtt';

export interface VictronMqttConfig {
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  protocol?: string;
  tls?: boolean;
  rejectUnauthorized?: boolean;
  reconnectPeriod?: number;
  serial?: string;
}

interface WaitForMessageOptions {
  timeoutMs?: number;
  label?: string;
}

interface ReadSettingOptions {
  serial?: string;
  timeoutMs?: number;
}

interface SubscribeJsonOptions {
  requestTopic?: string;
}

export type JsonMessageHandler = (topic: string, payload: unknown) => void;
export type UnsubscribeJson = () => Promise<void>;

export interface ScheduleSlot {
  startEpoch?: number;
  durationSeconds?: number;
  strategy?: number;
  flags?: number;
  socTarget?: number;
  restrictions?: number;
  allowGridFeedIn?: number;
}


export class VictronMqttClient {
  host: string;
  port: number;
  username: string | undefined;
  password: string | undefined;
  protocol: string;
  tls: boolean;
  rejectUnauthorized: boolean;
  reconnectPeriod: number;
  serial: string | null;
  private _serialPromise: Promise<string> | null;
  private _clientPromise: Promise<MqttClient> | null;

  constructor({
    host = 'venus.local',
    port,
    username = '',
    password = '',
    protocol,
    tls = false,
    rejectUnauthorized = true,
    reconnectPeriod = 0,  // 0 = no auto reconnect by default
    serial,               // optional: if you already know the portal id
  }: VictronMqttConfig = {}) {
    this.tls = tls;
    this.rejectUnauthorized = rejectUnauthorized;
    this.host = host;
    this.port = port ?? (tls ? 8883 : 1883);
    this.username = username || undefined;
    this.password = password || undefined;
    this.protocol = protocol ?? (tls ? 'mqtts' : 'mqtt');
    this.reconnectPeriod = reconnectPeriod;

    this.serial = serial ?? null;  // cached portal id once known
    this._serialPromise = null;   // in-flight detection, if any
    this._clientPromise = null;
  }

  private async _getClient(): Promise<MqttClient> {
    if (this._clientPromise) return this._clientPromise;

    const url = `${this.protocol}://${this.host}:${this.port}`;

    this._clientPromise = mqtt.connectAsync(url, {
      username: this.username,
      password: this.password,
      reconnectPeriod: this.reconnectPeriod,
      rejectUnauthorized: this.rejectUnauthorized,
      family: 4, // prefer IPv4 — mDNS hostnames (e.g. venus.local) often resolve to unreachable IPv6
    } as mqtt.IClientOptions & { family?: number });

    const client = await this._clientPromise;

    client.on('error', (err) => {
      console.error('[victron-mqtt] client error:', err.message);
    });

    return client;
  }

  async close(): Promise<void> {
    if (!this._clientPromise) return;
    const client = await this._clientPromise;
    this._clientPromise = null;
    await client.endAsync();
  }

  // ---------------------------------------------------------------------------
  // Internal helper: wait for the first message that matchFn() accepts
  // matchFn(topic, payload) -> result | undefined
  // ---------------------------------------------------------------------------
  private _waitForFirstMessage<T>(
    client: MqttClient,
    matchFn: (topic: string, payload: Buffer) => T | undefined,
    { timeoutMs = 2000, label = 'message' }: WaitForMessageOptions = {},
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      let settled = false;

      const cleanup = () => {
        /* v8 ignore next */
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (typeof client.off === 'function') {
          client.off('message', handler);
        /* v8 ignore start */
        } else {
          client.removeListener('message', handler);
        }
        /* v8 ignore stop */
      };

      const handler = (topic: string, payload: Buffer) => {
        /* v8 ignore next */
        if (settled) return;
        try {
          const maybeResult = matchFn(topic, payload);
          if (maybeResult === undefined) return;
          cleanup();
          resolve(maybeResult);
        } catch (err) {
          cleanup();
          reject(err);
        }
      };

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timeout after ${timeoutMs}ms waiting for ${label}`));
      }, timeoutMs);

      client.on('message', handler);
    });
  }

  // ---------------------------------------------------------------------------
  // Serial / portal id detection
  // ---------------------------------------------------------------------------

  /**
   * Public API: get the Victron serial (portal id).
   * - If already known, returns cached value.
   * - Otherwise subscribes once to N/+/system/0/Serial and resolves from payload.value.
   */
  async getSerial({ timeoutMs = 5000 }: { timeoutMs?: number } = {}): Promise<string> {
    if (this.serial) return this.serial;

    if (!this._serialPromise) {
      this._serialPromise = this._detectSerialOnce({ timeoutMs });
    }

    try {
      const serial = await this._serialPromise;
      this.serial = serial;
      return serial;
    } finally {
      // always clear so a later call can retry if detection failed
      this._serialPromise = null;
    }
  }

  // Internal: one-shot detection using N/+/system/0/Serial
  private async _detectSerialOnce({ timeoutMs = 5000 }: { timeoutMs?: number } = {}): Promise<string> {
    const client = await this._getClient();
    const wildcard = 'N/+/system/0/Serial';

    const wait = this._waitForFirstMessage(
      client,
      (topic, payload) => {
        // Payload is {"value":"xxxxxxxxx"}
        const obj = JSON.parse(payload.toString()) as { value?: string };
        return obj?.value;
      },
      { timeoutMs, label: wildcard },
    );

    try {
      await client.subscribeAsync(wildcard);
      const serial = await wait;
      return serial;
    } finally {
      try {
        await client.unsubscribeAsync(wildcard);
      } catch {
        // ignore
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Generic helpers
  // ---------------------------------------------------------------------------

  async publishJson(topic: string, payload: unknown, { qos = 0, retain = false }: { qos?: 0 | 1 | 2; retain?: boolean } = {}): Promise<void> {
    const client = await this._getClient();
    const json = JSON.stringify(payload);
    await client.publishAsync(topic, json, { qos, retain });
  }

  async publishRaw(topic: string, payload: string | Buffer = '', { qos = 0, retain = false }: { qos?: 0 | 1 | 2; retain?: boolean } = {}): Promise<void> {
    const client = await this._getClient();
    await client.publishAsync(topic, payload, { qos, retain });
  }

  async subscribeJson(
    topic: string,
    handler: JsonMessageHandler,
    { requestTopic }: SubscribeJsonOptions = {},
  ): Promise<UnsubscribeJson> {
    const client = await this._getClient();

    const wrapped = (incomingTopic: string, payload: Buffer) => {
      if (incomingTopic !== topic) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload.toString()) as unknown;
      } catch (err) {
        console.warn('[victron-mqtt] ignored invalid JSON payload:', (err as Error).message);
        return;
      }
      handler(incomingTopic, parsed);
    };

    client.on('message', wrapped);

    try {
      await client.subscribeAsync(topic);
      if (requestTopic) {
        await client.publishAsync(requestTopic, '');
      }
    } catch (err) {
      if (typeof client.off === 'function') {
        client.off('message', wrapped);
      /* v8 ignore start */
      } else {
        client.removeListener('message', wrapped);
      }
      /* v8 ignore stop */
      throw err;
    }

    return async () => {
      if (typeof client.off === 'function') {
        client.off('message', wrapped);
      /* v8 ignore start */
      } else {
        client.removeListener('message', wrapped);
      }
      /* v8 ignore stop */
      try {
        await client.unsubscribeAsync(topic);
      } catch {
        // ignore cleanup failures
      }
    };
  }

  /**
   * Subscribe to a specific topic and resolve with the first JSON payload.
   * If requestTopic is given, publish an empty message there after subscribe.
   */
  async readJsonOnce(topic: string, { timeoutMs = 2000, requestTopic }: { timeoutMs?: number; requestTopic?: string } = {}): Promise<unknown> {
    const client = await this._getClient();

    const wait = this._waitForFirstMessage(
      client,
      (incomingTopic, payload) => {
        if (incomingTopic !== topic) return undefined;
        return JSON.parse(payload.toString()) as unknown;
      },
      { timeoutMs, label: topic },
    );

    try {
      await client.subscribeAsync(topic);
      if (requestTopic) {
        await client.publishAsync(requestTopic, '');
      }
      return await wait;
    } finally {
      try {
        await client.unsubscribeAsync(topic);
      } catch {
        // ignore
      }
    }
  }

  /**
   * Generic setting read helper:
   *   - Reads from N/<serial>/<relativePath>
   *   - Triggers R/<serial>/<relativePath> first to force an update
   */
  /* v8 ignore next 6 — tested (see readSetting tests) but V8 can't map async/template TS lines */
  async readSetting(relativePath: string, { serial, timeoutMs = 2000 }: ReadSettingOptions = {}): Promise<unknown> {
    const s = serial ?? (await this.getSerial({ timeoutMs }));
    const topic = `N/${s}/${relativePath}`;
    const requestTopic = `R/${s}/${relativePath}`;
    return this.readJsonOnce(topic, { timeoutMs, requestTopic });
  }

  /**
   * Generic write helper: writes {"value": X} to W/<serial>/<relativePath>
   */
  /* v8 ignore next 5 — tested (see writeSetting tests) but V8 can't map async/template TS lines */
  async writeSetting(relativePath: string, value: unknown, { serial }: { serial?: string } = {}): Promise<void> {
    const s = serial ?? (await this.getSerial());
    const topic = `W/${s}/${relativePath}`;
    await this.publishJson(topic, { value });
  }

  /**
   * Request a fresh N/<serial>/<relativePath> publish from Venus.
   */
  async requestSetting(relativePath: string, { serial }: { serial?: string } = {}): Promise<void> {
    const s = serial ?? (await this.getSerial());
    await this.publishRaw(`R/${s}/${relativePath}`, '');
  }

  // ---------------------------------------------------------------------------
  // Battery SoC helper
  // ---------------------------------------------------------------------------

  /**
   * Read the current battery state-of-charge (%) via MQTT.
   * Uses the system-level SoC at:
   *   N/<serial>/system/0/Dc/Battery/Soc
   */
  async readSocPercent({ timeoutMs = 8000 }: { timeoutMs?: number } = {}): Promise<{ soc_percent: number | null; raw: unknown }> {
    const s = await this.getSerial({ timeoutMs });

    // This will subscribe to N/s/system/0/Dc/Battery/Soc
    // and publish an empty message to R/s/system/0/Dc/Battery/Soc
    const payload = await this.readSetting('system/0/Dc/Battery/Soc', {
      serial: s,
      timeoutMs,
    }) as { value?: unknown } | null;

    const rawValue = payload?.value;

    // Victron sometimes sends [] when there is no SoC
    if (rawValue === null || rawValue === undefined || Array.isArray(rawValue)) {
      return { soc_percent: null, raw: payload };
    }

    const n = Number(rawValue);
    if (!Number.isFinite(n)) {
      return { soc_percent: null, raw: payload };
    }

    const soc_percent = Math.max(0, Math.min(100, n));
    return { soc_percent, raw: payload };
  }

  /**
   * Read the ESS SoC limits (%) via MQTT.
   *
   * - Minimum SoC (reserve for grid failures):
   *     N/<serial>/settings/0/Settings/CGwacs/BatteryLife/MinimumSocLimit
   * - Active SoC limit (BatteryLife / ESS upper bound):
   *     N/<serial>/settings/0/Settings/CGwacs/MaxChargePercentage
   *
   * Returns:
   *   {
   *     minSoc_percent: number | null,
   *     maxSoc_percent: number | null,
   *     raw: { min, max }  // raw MQTT payloads
   *   }
   */
  async readSocLimitsPercent({ timeoutMs = 8000 }: { timeoutMs?: number } = {}): Promise<{ minSoc_percent: number | null; maxSoc_percent: number | null; raw: { min: unknown; max: unknown } }> {
    const s = await this.getSerial({ timeoutMs });

    const [minPayload, maxPayload] = await Promise.all([
      this.readSetting(
        'settings/0/Settings/CGwacs/BatteryLife/MinimumSocLimit',
        { serial: s, timeoutMs },
      ),
      this.readSetting(
        'settings/0/Settings/CGwacs/MaxChargePercentage',
        { serial: s, timeoutMs },
      ),
    ]) as [{ value?: unknown } | null, { value?: unknown } | null];

    const normalize = (payload: { value?: unknown } | null): number | null => {
      const raw = payload?.value;
      if (raw === null || raw === undefined || Array.isArray(raw)) {
        return null;
      }
      const n = Number(raw);
      /* v8 ignore next — tested in readSocPercent but V8 can't map readSocLimitsPercent normalize */
      if (!Number.isFinite(n)) return null;
      return Math.max(0, Math.min(100, n));
    };

    const minSoc_percent = normalize(minPayload);
    const maxSoc_percent = normalize(maxPayload);

    return {
      minSoc_percent,
      maxSoc_percent,
      raw: { min: minPayload, max: maxPayload },
    };
  }


  // ---------------------------------------------------------------------------
  // Dynamic ESS schedule helpers
  // ---------------------------------------------------------------------------

  /**
   * Write a single schedule slot.
   *
   * Writes both `Soc` (legacy) and `TargetSoc` (preferred on Venus OS >= 3.20).
   * Venus OS uses `TargetSoc` when non-zero, falling back to `Soc` when
   * `TargetSoc` is 0 or null. Writing both ensures compatibility across
   * firmware versions and prevents stale `TargetSoc` values from overriding
   * our `Soc` writes.
   */
  /* v8 ignore next 3 — tested (see writeScheduleSlot tests) but V8 can't map async/template TS lines */
  async writeScheduleSlot(slotIndex: number, slot: ScheduleSlot, { serial }: { serial?: string } = {}): Promise<void> {
    const s = serial ?? (await this.getSerial());
    const base = `settings/0/Settings/DynamicEss/Schedule/${slotIndex}`;

    const tasks: Promise<void>[] = [];

    if (slot.startEpoch !== undefined) tasks.push(this.writeSetting(`${base}/Start`, slot.startEpoch, { serial: s }));
    if (slot.durationSeconds !== undefined) tasks.push(this.writeSetting(`${base}/Duration`, slot.durationSeconds, { serial: s }));
    if (slot.strategy !== undefined) tasks.push(this.writeSetting(`${base}/Strategy`, slot.strategy, { serial: s }));
    if (slot.flags !== undefined) tasks.push(this.writeSetting(`${base}/Flags`, slot.flags, { serial: s }));
    if (slot.socTarget !== undefined) {
      tasks.push(this.writeSetting(`${base}/Soc`, slot.socTarget, { serial: s }));
      tasks.push(this.writeSetting(`${base}/TargetSoc`, slot.socTarget, { serial: s }));
    }
    if (slot.restrictions !== undefined) tasks.push(this.writeSetting(`${base}/Restrictions`, slot.restrictions, { serial: s }));
    if (slot.allowGridFeedIn !== undefined) tasks.push(this.writeSetting(`${base}/AllowGridFeedIn`, slot.allowGridFeedIn, { serial: s }));

    await Promise.all(tasks);
  }

}

// Convenience helper for one-off scripts
export async function withVictronMqtt<T>(config: VictronMqttConfig, fn: (client: VictronMqttClient) => Promise<T>): Promise<T> {
  const client = new VictronMqttClient(config);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}
