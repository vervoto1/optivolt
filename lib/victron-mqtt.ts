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
  /** Deadline for one publish/subscribe round-trip before the connection is dropped (default OP_TIMEOUT_MS). */
  opTimeoutMs?: number;
}

/**
 * Upper bound for one transport operation (a QoS-0 publish reaching the socket, a SUBACK).
 * mqtt.js parks these in its offline queue while disconnected and only settles them on the
 * next CONNACK, so an unbounded await hangs for as long as the broker stays unreachable.
 */
export const OP_TIMEOUT_MS = 10_000;

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

function normalizeSocPayload(payload: { value?: unknown } | null): number | null {
  const rawValue = payload?.value;

  // Victron sometimes sends [] when there is no SoC.
  if (rawValue === null || rawValue === undefined || Array.isArray(rawValue)) {
    return null;
  }

  const n = Number(rawValue);
  if (!Number.isFinite(n)) {
    return null;
  }

  return Math.max(0, Math.min(100, n));
}

type MessageListener = (topic: string, payload: Buffer) => void;

/** A live subscribeJson() subscription and the client it is currently attached to. */
interface JsonSubscription {
  topic: string;
  requestTopic?: string;
  listener: MessageListener;
  client: MqttClient;
}

function offMessage(client: MqttClient, listener: MessageListener): void {
  if (typeof client.off === 'function') {
    client.off('message', listener);
  /* v8 ignore start */
  } else {
    client.removeListener('message', listener);
  }
  /* v8 ignore stop */
}

function portalIdFromSerialTopic(topic: string): string | undefined {
  const match = /^N\/([^/]+)\/system\/0\/Serial$/.exec(topic);
  return match?.[1];
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
  opTimeoutMs: number;
  serial: string | null;
  private _serialPromise: Promise<string> | null;
  private _clientPromise: Promise<MqttClient> | null;
  private _client: MqttClient | null;
  private _subscriptions: Set<JsonSubscription>;

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
    opTimeoutMs = OP_TIMEOUT_MS,
  }: VictronMqttConfig = {}) {
    this.tls = tls;
    this.rejectUnauthorized = rejectUnauthorized;
    this.host = host;
    this.port = port ?? (tls ? 8883 : 1883);
    this.username = username || undefined;
    this.password = password || undefined;
    this.protocol = protocol ?? (tls ? 'mqtts' : 'mqtt');
    this.reconnectPeriod = reconnectPeriod;
    this.opTimeoutMs = opTimeoutMs;

    this.serial = serial ?? null;  // cached portal id once known
    this._serialPromise = null;   // in-flight detection, if any
    this._clientPromise = null;
    this._client = null;
    this._subscriptions = new Set();
  }

  private async _getClient(): Promise<MqttClient> {
    if (this._clientPromise) return this._clientPromise;

    const url = `${this.protocol}://${this.host}:${this.port}`;

    const clientPromise = mqtt.connectAsync(url, {
      username: this.username,
      password: this.password,
      reconnectPeriod: this.reconnectPeriod,
      rejectUnauthorized: this.rejectUnauthorized,
      family: 4, // prefer IPv4 — mDNS hostnames (e.g. venus.local) often resolve to unreachable IPv6
      // mqtt >= 5.16 stops auto-reconnecting after a refused CONNACK (rc > 0, e.g. "Not
      // authorized" while a rebooting GX has not loaded its security profile yet) unless this
      // is set, which would leave the cached client dead for good.
      reconnectOnConnackError: true,
    } as mqtt.IClientOptions & { family?: number });
    this._clientPromise = clientPromise;

    let client: MqttClient;
    try {
      client = await clientPromise;
    } catch (err) {
      // Drop the rejected promise so the next call retries instead of re-awaiting it.
      // The identity guard's false arm needs the cache replaced mid-reject, which can't
      // happen: concurrent callers reuse this promise and close() re-throws it.
      /* v8 ignore next */
      if (this._clientPromise === clientPromise) this._clientPromise = null;
      throw err;
    }

    this._client = client;
    client.on('error', (err) => {
      console.error('[victron-mqtt] client error:', err.message);
    });
    // With reconnectPeriod 0 the client never reconnects on its own, so a dropped
    // connection would leave a dead client cached and time out every later call.
    // Discard it on close; when auto-reconnect is enabled mqtt.js revives this same
    // client, so keep the cache and let it recover (reconnectOnConnackError covers a
    // refused reconnect; _op() evicts a client that still stops answering).
    if (this.reconnectPeriod === 0) {
      client.on('close', () => {
        if (this._clientPromise === clientPromise) {
          this._clientPromise = null;
          this._client = null;
        }
      });
    }

    this._reattachSubscriptions(client);
    return client;
  }

  /**
   * Move live subscribeJson() subscriptions that sat on a client since evicted or dropped
   * onto this one (mqtt.js only resubscribes within the same client). Without it a
   * long-lived reader (the shore optimizer) would go silent after an eviction.
   */
  private _reattachSubscriptions(client: MqttClient): void {
    // Every live subscription sits on an older client: subscribeJson() only registers
    // one after its own _getClient() call has returned.
    for (const sub of this._subscriptions) {
      offMessage(sub.client, sub.listener);
      sub.client = client;
      client.on('message', sub.listener);
      void (async () => {
        await this._op(client, client.subscribeAsync(sub.topic), `subscribe ${sub.topic}`);
        if (sub.requestTopic) {
          await this._op(client, client.publishAsync(sub.requestTopic, ''), `publish ${sub.requestTopic}`);
        }
      })().catch((err: unknown) => {
        console.error(`[victron-mqtt] re-subscribing ${sub.topic} failed:`, (err as Error).message);
      });
    }
  }

  /**
   * Drop a client that stopped answering so the next call connects afresh. `end(true)`
   * also discards its offline queue, so stale setpoints are never sent late.
   */
  private _evict(client: MqttClient): void {
    if (this._client === client) {
      this._client = null;
      this._clientPromise = null;
    }
    client.end(true);
  }

  /** Await one transport op with a deadline; on expiry evict the client and reject. */
  private async _op<T>(client: MqttClient, op: Promise<T>, label: string): Promise<T> {
    const timeoutMs = this.opTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        console.error(`[victron-mqtt] ${label} not acknowledged within ${timeoutMs}ms; dropping connection`);
        this._evict(client);
        reject(new Error(`Timeout after ${timeoutMs}ms waiting for ${label}`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([op, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * End the connection immediately, without flushing or waiting for DISCONNECT. For
   * shutdown paths where the graceful close() may hang (broker unreachable). Never throws.
   */
  forceClose(): void {
    const pending = this._clientPromise;
    const client = this._client;
    this._clientPromise = null;
    this._client = null;
    if (client) {
      client.end(true);
    } else if (pending) {
      // Still connecting: end it once (if) the connect settles.
      pending.then((c) => { c.end(true); }, () => {});
    }
  }

  async close(): Promise<void> {
    if (!this._clientPromise) return;
    const client = await this._clientPromise;
    this._clientPromise = null;
    this._client = null;
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
   * - Otherwise subscribes once to N/+/system/0/Serial and resolves from the topic portal id.
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
      (topic) => portalIdFromSerialTopic(topic),
      { timeoutMs, label: wildcard },
    );
    // Observed below; a stalled subscribe must never leave this rejection orphaned
    // (an unhandled rejection terminates the process).
    wait.catch(() => {});

    try {
      // Settles at timeoutMs even while the subscribe itself is stalled.
      await Promise.race([this._op(client, client.subscribeAsync(wildcard), `subscribe ${wildcard}`), wait]);
      const serial = await wait;
      return serial;
    } finally {
      // Fire-and-forget: an offline client would park this until the next CONNACK.
      client.unsubscribeAsync(wildcard).catch(() => {});
    }
  }

  // ---------------------------------------------------------------------------
  // Generic helpers
  // ---------------------------------------------------------------------------

  async publishJson(topic: string, payload: unknown, { qos = 0, retain = false }: { qos?: 0 | 1 | 2; retain?: boolean } = {}): Promise<void> {
    const client = await this._getClient();
    const json = JSON.stringify(payload);
    await this._op(client, client.publishAsync(topic, json, { qos, retain }), `publish ${topic}`);
  }

  async publishRaw(topic: string, payload: string | Buffer = '', { qos = 0, retain = false }: { qos?: 0 | 1 | 2; retain?: boolean } = {}): Promise<void> {
    const client = await this._getClient();
    await this._op(client, client.publishAsync(topic, payload, { qos, retain }), `publish ${topic}`);
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
        /* v8 ignore start — v8 can't track statements inside this closure scope */
        console.warn('[victron-mqtt] ignored invalid JSON payload:', (err as Error).message);
        return;
        /* v8 ignore stop */
      }
      handler(incomingTopic, parsed);
    };

    client.on('message', wrapped);

    try {
      await this._op(client, client.subscribeAsync(topic), `subscribe ${topic}`);
      if (requestTopic) {
        await this._op(client, client.publishAsync(requestTopic, ''), `publish ${requestTopic}`);
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

    const sub: JsonSubscription = { topic, requestTopic, listener: wrapped, client };
    this._subscriptions.add(sub);

    return async () => {
      this._subscriptions.delete(sub);
      offMessage(sub.client, sub.listener);
      // Fire-and-forget: an offline client would park this until the next CONNACK.
      sub.client.unsubscribeAsync(topic).catch(() => {});
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
    // Observed below; a stalled subscribe must never leave this rejection orphaned
    // (an unhandled rejection terminates the process).
    wait.catch(() => {});

    const request = (async () => {
      await this._op(client, client.subscribeAsync(topic), `subscribe ${topic}`);
      if (requestTopic) {
        await this._op(client, client.publishAsync(requestTopic, ''), `publish ${requestTopic}`);
      }
    })();

    try {
      // Settles at timeoutMs even while the subscribe itself is stalled.
      await Promise.race([request, wait]);
      return await wait;
    } finally {
      // Fire-and-forget: an offline client would park this until the next CONNACK.
      client.unsubscribeAsync(topic).catch(() => {});
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
   * When a battery instance is configured, prefers the battery service SoC at:
   *   N/<serial>/battery/<batteryInstance>/Soc
   * Otherwise falls back to the system-level SoC at:
   *   N/<serial>/system/0/Dc/Battery/Soc
   */
  async readSocPercent({ timeoutMs = 8000, batteryInstance }: { timeoutMs?: number; batteryInstance?: number } = {}): Promise<{ soc_percent: number | null; raw: unknown }> {
    const s = await this.getSerial({ timeoutMs });

    const paths: string[] = [];
    if (batteryInstance !== undefined && Number.isFinite(batteryInstance) && batteryInstance >= 0) {
      paths.push(`battery/${Math.round(batteryInstance)}/Soc`);
    }
    paths.push('system/0/Dc/Battery/Soc');

    let raw: unknown = null;
    for (const [idx, path] of paths.entries()) {
      try {
        const payload = await this.readSetting(path, {
          serial: s,
          timeoutMs,
        }) as { value?: unknown } | null;
        raw = payload;

        const soc_percent = normalizeSocPayload(payload);
        if (soc_percent !== null) return { soc_percent, raw: payload };
      } catch (err) {
        if (idx === paths.length - 1) throw err;
      }
    }

    return { soc_percent: null, raw };
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
