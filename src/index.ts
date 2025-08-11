/**
 * report.ts
 *
 * Database-backed Sparkplug observer that incrementally persists:
 *  - Devices upon DBIRTH (immediately) and on DDATA (safe re-upsert)
 *  - Metric definitions as encountered
 *  - Metric values for DBIRTH and DDATA messages
 *
 * Simplified version: no batching appender; per-row helpers for clarity.
 */
import { readFileSync } from "node:fs";
import { DuckDBConnection } from "@duckdb/node-api";
import { getConnection, closeConnection } from "./db/connection";
import { createSchema, loadExtensions } from "./db/schema";
import {
  DeviceRepository,
  DeviceMetricRepository,
  DeviceMetricValueRepository,
} from "./db/repositories";
import { metricId } from "./types";
import {
  newClient,
  parseCertificateTopic,
  parseTopic,
  UPayload,
} from "./clients/sparkplug";
import {
  getMetricValue,
  resolveMetricName,
  ts,
  ts as tsHelper,
} from "./common/metrics";
import { getLogger, MappedLogger } from "./common/logger";

// -------------------- Config Types --------------------
interface Config {
  sparkplug: {
    groupIds: string[];
    systemTopic: string; // e.g. spBv1.0/{groupId}/STATE
  };
  mqtt: {
    url: string;
    protocolVersion?: 3 | 4 | 5;
    clientId?: string;
    hostId?: string;
    reconnectBackoffSec?: number;
    keepaliveSec?: number;
  };
  advanced?: {
    disableTimeseries?: boolean;
    tsFlushIntervalSec?: number;
    birthFlushIntervalSec?: number;
    birthProcessingBatchSize?: number;
    tsDownsamplingPeriodSec?: number;
  };
  secrets: {
    credentials: {
      username: string;
      password: string;
    };
    key?: string;
    passphrase?: string;
    cert?: string;
    ca?: string;
  };
}

// -------------------- Initialization --------------------
const logger = getLogger();

// Load config from environment variable or command line argument
const configPath = process.env.CONFIG_PATH || process.argv[2];

if (!configPath) {
  console.error(
    "Please provide the path to the configuration file as an argument."
  );
  process.exit(1);
}
const config = JSON.parse(readFileSync(configPath, "utf8")) as Config;

// -------------------- Repositories (lazy init) --------------------
let deviceRepo: DeviceRepository;
let metricRepo: DeviceMetricRepository;
let metricValueRepo: DeviceMetricValueRepository;
let connRef: DuckDBConnection; // hold raw connection for explicit transactions

async function initDb() {
  const conn = await getConnection();
  connRef = conn;
  // Increase DuckDB memory limit
  try {
    await conn.run("PRAGMA memory_limit='4GB'");
    const ml = await conn.runAndReadAll("PRAGMA memory_limit");
    logger.info(
      `DuckDB memory_limit set to: ${ml.getRowObjects()[0].memory_limit}`
    );
  } catch (e) {
    logger.with().error(e).logger().warn("Failed setting memory_limit");
  }
  await loadExtensions(conn); // optional UI extension
  await createSchema(conn);
  // Start DuckDB UI for interactive inspection
  try {
    const uiReader = await conn.runAndReadAll(`CALL start_ui();`);
    const rows = uiReader.getRowObjects();
    logger.info(`DuckDB UI started: ${JSON.stringify(rows)}`);
  } catch (e) {
    logger.with().error(e).logger().warn("Failed to start DuckDB UI");
  }
  deviceRepo = new DeviceRepository(conn);
  metricRepo = new DeviceMetricRepository(conn);
  metricValueRepo = new DeviceMetricValueRepository(conn);
}

// ---- Queued Event Processing (priority: DBIRTH before DDATA) ----
// In-memory caches to avoid duplicate device & metric inserts (since no ON CONFLICT now)
const knownMetrics = new Set<string>(); // key = metricId(device, metricName)

type InboundEvent = {
  type: "DBIRTH" | "DDATA";
  topic: string;
  payload: any;
  receivedAt: number;
};
const birthQueue: InboundEvent[] = [];
const dataQueue: InboundEvent[] = [];
let drainScheduled = false;
let timer: NodeJS.Timeout | null = null;
let draining = false;
const MAX_BATCH_MESSAGES = 500; // process up to this many messages per transaction
const MAX_BATCH_DELAY_MS = 1000; // micro-batch window

function scheduleDrain() {
  if (drainScheduled) return;
  drainScheduled = true;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    drainScheduled = false;
    void drainQueues();
  }, MAX_BATCH_DELAY_MS);
}

async function drainQueues() {
  if (draining) return; // prevent re-entry
  draining = true;
  try {
    while (birthQueue.length || dataQueue.length) {
      const processingBirth = birthQueue.length > 0; // only process DDATA when no DBIRTH pending
      const activeQueue = processingBirth ? birthQueue : dataQueue;
      const queueSnapshotBirth = birthQueue.length;
      const queueSnapshotData = dataQueue.length;
      const batchStartWall = Date.now();
      let metricsInBatch = 0;
      const batch: InboundEvent[] = [];

      while (batch.length < MAX_BATCH_MESSAGES && activeQueue.length) {
        batch.push(activeQueue.shift()!);
      }
      if (!batch.length) break;

      // Stage new devices & metrics & metric values for bulk insert
      const newMetrics: { deviceName: string; metricName: string }[] = [];
      const metricValues: {
        metricId: string;
        ts: Date;
        value: any;
        fromBirth: boolean;
      }[] = [];
      const newDevices: {
        deviceName: string;
        topic: string;
        birthTimestamp?: Date | null;
      }[] = [];

      for (const evt of batch) {
        if (evt.type === "DBIRTH") {
          const { deviceId } = parseCertificateTopic(evt.topic);
          if (!deviceId) continue;
          newDevices.push({
            deviceName: deviceId,
            topic: evt.topic,
            birthTimestamp: ts(evt.payload.timestamp),
          });
          logger.info(`Processing DBIRTH for device: ${deviceId}`);
          for (const m of evt.payload.metrics || []) {
            const name = resolveMetricName(m);
            if (!name) continue;
            const id = metricId(deviceId, name);
            const val = getMetricValue(m, logger);
            // This must go above the newMetrics.push to avoid undsired metrics
            if (val === null || val === undefined) continue;
            newMetrics.push({ deviceName: deviceId, metricName: name });
            const tstamp = tsHelper(m.timestamp);
            metricValues.push({
              metricId: id,
              ts: tstamp,
              value: val,
              fromBirth: true,
            });
            metricsInBatch++;
          }
        } else {
          // DDATA
          const t = parseTopic(evt.topic);
          const deviceId = t.deviceId;
          if (!deviceId) continue;
          for (const m of evt.payload.metrics || []) {
            const name = m.name;
            if (!name) continue;
            const id = metricId(deviceId, name);
            const val = getMetricValue(m, logger);
            if (val === null || val === undefined) continue;
            const tstamp = tsHelper(m.timestamp);
            metricValues.push({
              metricId: id,
              ts: tstamp,
              value: val,
              fromBirth: false,
            });
            metricsInBatch++;
          }
        }
      }

      await connRef.run("BEGIN TRANSACTION");
      let failed = false;
      try {
        // Bulk insert devices (still one-by-one since deviceRepo lacks bulk; could optimize later)
        for (const d of newDevices) {
          await deviceRepo.upsert({
            deviceName: d.deviceName,
            topic: d.topic,
            birthTimestamp: d.birthTimestamp || null,
          });
        }
        // Bulk insert metrics
        await metricRepo.insertMany(newMetrics);
        // Bulk insert metric values
        await metricValueRepo.insertMany(metricValues);
        await connRef.run("COMMIT");
      } catch (err) {
        failed = true;
        await connRef.run("ROLLBACK").catch(() => {});
        logger
          .with()
          .error(err)
          .logger()
          .error("Batch processing failed; rolled back");
      }

      const duration = Date.now() - batchStartWall;
      logger
        .with()
        .bool?.("processingBirth", processingBirth)
        .num("batchMessages", batch.length)
        .num("metrics", metricsInBatch)
        .num("queueBirthRemaining", birthQueue.length)
        .num("queueDataRemaining", dataQueue.length)
        .num("queueBirthStart", queueSnapshotBirth)
        .num("queueDataStart", queueSnapshotData)
        .num("newDevices", newDevices.length)
        .num("newMetrics", newMetrics.length)
        .num("metricValues", metricValues.length)
        .num("ms", duration)
        .bool?.("failed", failed)
        .logger()
        .info("Batch committed");
    }
  } finally {
    draining = false;
  }
}

function enqueueEvent(e: InboundEvent) {
  if (e.type === "DBIRTH") birthQueue.push(e);
  else dataQueue.push(e);
  // Immediate drain if threshold reached
  if (birthQueue.length + dataQueue.length >= MAX_BATCH_MESSAGES) {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    drainScheduled = false;
    void drainQueues();
  } else {
    scheduleDrain();
  }
}

// -------------------- Main Flow --------------------
async function main() {
  await initDb();

  const client = newClient({
    clientId: config.mqtt.clientId!,
    hostId: config.mqtt.hostId!,
    serverUrl: config.mqtt.url,
    username: config.secrets.credentials.username,
    password: config.secrets.credentials.password,
    logger,
    keepalive: config.mqtt.keepaliveSec || 30,
    mqttOptions: {
      protocolVersion: config.mqtt.protocolVersion,
      rejectUnauthorized: false,
      key: config.secrets.key,
      cert: config.secrets.cert,
      ca: config.secrets.ca,
      passphrase: config.secrets.passphrase,
      keepalive: config.mqtt.keepaliveSec || 30,
    } as any,
  });

  client.on("connect", () => logger.info("✅ Connected"));
  client.on("reconnect", () => logger.info("🔄 Reconnecting"));
  client.on("close", () => logger.info("🔄 Closed"));
  client.on("offline", () => logger.info("🔌 Offline"));
  client.on("birth", () => logger.info("👶 MQTT client birthed"));
  client.on("disconnect", (p) =>
    logger.with().num("reason", p.reasonCode).logger().info("🔌 Disconnect")
  );
  client.on("error", (e) =>
    logger.with().error(e).logger().error("❌ MQTT error")
  );

  client.on("message", (topic: string, payload: any) => {
    try {
      if (topic.startsWith(config.sparkplug.systemTopic)) {
        const t = parseCertificateTopic(topic);
        if (t.otherParts.length === 0 && t.messageType === "DBIRTH") {
          enqueueEvent({
            type: "DBIRTH",
            topic,
            payload,
            receivedAt: Date.now(),
          });
        }
      } else if (topic.startsWith("spBv1.0/")) {
        const t = parseTopic(topic);
        if (t.messageType === "DDATA") {
          enqueueEvent({
            type: "DDATA",
            topic,
            payload,
            receivedAt: Date.now(),
          });
        }
      }
    } catch (err) {
      logger.with().error(err).logger().error("Enqueue error");
    }
  });

  // Graceful shutdown
  function shutdown(sig: string) {
    logger.info(`Received ${sig}, shutting down...`);
    closeConnection().finally(() => process.exit(0));
  }
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.with().error(err).logger().error("Fatal startup error");
  process.exit(1);
});
