/**
 * Main entrypoint: Sparkplug ingestion + API server.
 * Provides REST API only (no static asset serving).
 */
import Fastify from "fastify";
const cors = require("@fastify/cors");
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
import { readFileSync } from "fs";
import path from "path";

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
const TRACE_ENABLED = process.env.TRACE === "1" || process.env.TRACE === "true";

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
    const uiReader = await conn.runAndReadAll(`CALL start_ui_server();`);
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
// const knownMetrics = new Set<string>(); // key = metricId(device, metricName)

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

// -------------------- API Registration --------------------
const POLL_INTERVAL = parseInt(process.env.UI_POLL_INTERVAL_MS || "5000", 10);
const API_MAX_LIMIT = 10000; // unified soft max/default for list endpoints

function normalizeTs(row: any, key: string) {
  if (row[key] == null) return null;
  const v = row[key];
  if (v instanceof Date) return v.toISOString();
  return new Date(String(v).replace(" ", "T") + "Z").toISOString();
}

function coerceLimit(raw: any): number {
  const n = parseInt(raw, 10);
  if (!n || n <= 0) return API_MAX_LIMIT; // default
  return Math.min(n, API_MAX_LIMIT); // enforce upper bound
}

function coerceBigInt(v: any) {
  return typeof v === "bigint" ? Number(v) : v;
}

function registerApi(app: any) {
  app.get("/api/health", async () => ({ ok: true }));
  app.get("/api/config", async () => ({
    pollIntervalMs: POLL_INTERVAL,
    searchLimit: API_MAX_LIMIT,
  }));
  // Devices listing (cursor pagination)
  app.get("/api/devices", async (req: any) => {
    const { cursor, limit } = req.query;
    const lim = coerceLimit(limit);
    const conn = await getConnection();
    const sql = `select device_name, topic, birth_timestamp from devices\n      where ($cursor is null or device_name > $cursor)\n      order by device_name limit $limit`;
    const reader = await conn.runAndReadAll(sql, {
      cursor: cursor || null,
      limit: lim,
    });
    const rows = reader.getRowObjects();
    return {
      items: rows.map((r) => ({
        deviceName: r.device_name,
        topic: r.topic,
        birthTimestamp: normalizeTs(r, "birth_timestamp"),
      })),
      count: rows.length,
      nextCursor:
        rows.length === lim ? rows[rows.length - 1].device_name : null,
      limit: lim,
    };
  });
  // Devices count
  app.get("/api/devices/count", async () => {
    const conn = await getConnection();
    const reader = await conn.runAndReadAll(
      `select count(*) as c from devices`
    );
    const rows = reader.getRowObjects();
    return { count: coerceBigInt(rows[0]?.c) ?? 0 };
  });
  // Device index (zero-based position by lexical order). Query param: device
  app.get("/api/devices/index", async (req: any, reply: any) => {
    const { device } = req.query;
    if (!device)
      return reply.code(400).send({ error: "device query param required" });
    const conn = await getConnection();
    const reader = await conn.runAndReadAll(
      `select
      (select count(*) from devices where device_name < $d) as idx,
      (select count(*) from devices where device_name = $d) as exists
    `,
      { d: device }
    );
    const r = reader.getRowObjects()[0];
    if (!r || r.exists === 0)
      return reply.code(404).send({ error: "Not Found" });
    return { index: coerceBigInt(r.idx) };
  });
  // Metrics listing
  app.get("/api/devices/:device/metrics", async (req: any) => {
    const { cursor, limit } = req.query;
    const { device } = req.params;
    const lim = coerceLimit(limit);
    const conn = await getConnection();
    const sql = `select metric_name, id from device_metrics\n      where device_name = $device and ($cursor is null or metric_name > $cursor)\n      order by metric_name limit $limit`;
    const reader = await conn.runAndReadAll(sql, {
      device,
      cursor: cursor || null,
      limit: lim,
    });
    const rows = reader.getRowObjects();
    return {
      items: rows.map((r) => ({ metricName: r.metric_name, id: r.id })),
      count: rows.length,
      nextCursor:
        rows.length === lim ? rows[rows.length - 1].metric_name : null,
      limit: lim,
    };
  });
  // Metrics count for a device
  app.get(
    "/api/devices/:device/metrics/count",
    async (req: any, reply: any) => {
      const { device } = req.params;
      const conn = await getConnection();
      const reader = await conn.runAndReadAll(
        `select count(*) as c from device_metrics where device_name=$d`,
        { d: device }
      );
      const rows = reader.getRowObjects();
      return { count: coerceBigInt(rows[0]?.c) ?? 0 };
    }
  );
  // Metric index within a device
  app.get(
    "/api/devices/:device/metrics/index",
    async (req: any, reply: any) => {
      const { device } = req.params;
      const { metric } = req.query;
      if (!metric)
        return reply.code(400).send({ error: "metric query param required" });
      const conn = await getConnection();
      const reader = await conn.runAndReadAll(
        `select
      (select count(*) from device_metrics where device_name=$d and metric_name < $m) as idx,
      (select count(*) from device_metrics where device_name=$d and metric_name=$m) as exists
    `,
        { d: device, m: metric }
      );
      const r = reader.getRowObjects()[0];
      if (!r || r.exists === 0)
        return reply.code(404).send({ error: "Not Found" });
      return { index: coerceBigInt(r.idx) };
    }
  );
  // Latest metric value (no limit param)
  app.get("/api/metrics/:device/:metric/latest", async (req: any) => {
    const { device, metric } = req.params;
    const conn = await getConnection();
    const sql = `select v.ts, v.value, v.from_birth from device_metric_values v\n      join device_metrics m on m.id = v.metric_id\n      where m.device_name=$device and m.metric_name=$metric\n      order by v.ts desc limit 1`;
    const reader = await conn.runAndReadAll(sql, { device, metric });
    const rows = reader.getRowObjects();
    if (!rows.length) return { ts: null, value: null };
    const r = rows[0];
    return {
      ts: normalizeTs(r, "ts"),
      value: r.value,
      fromBirth: !!r.from_birth,
    };
  });
  // Metric value series
  app.get("/api/metrics/:device/:metric/values", async (req: any) => {
    const { device, metric } = req.params;
    const { from, to, limit, order = "desc" } = req.query;
    const lim = coerceLimit(limit);
    const conn = await getConnection();
    const now = new Date();
    const toTs = to ? to : now.toISOString();
    const fromTs = from
      ? from
      : new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString();
    const ord = String(order).toLowerCase() === "asc" ? "asc" : "desc";
    const sql = `select v.ts, v.value, v.from_birth from device_metric_values v\n      join device_metrics m on m.id = v.metric_id\n      where m.device_name=$device and m.metric_name=$metric\n        and v.ts between $from and $to\n      order by v.ts ${ord} limit $limit`;
    const reader = await conn.runAndReadAll(sql, {
      device,
      metric,
      from: fromTs.replace("T", " ").replace("Z", ""),
      to: toTs.replace("T", " ").replace("Z", ""),
      limit: lim,
    });
    const rows = reader.getRowObjects();
    return {
      device,
      metric,
      from: fromTs,
      to: toTs,
      count: rows.length,
      truncated: rows.length === lim, // indicates there may be more
      limit: lim,
      items: rows.map((r) => ({
        ts: normalizeTs(r, "ts"),
        value: r.value,
        fromBirth: !!r.from_birth,
      })),
    };
  });
  // Search (devices + metrics)
  app.get("/api/search", async (req: any) => {
    const { q = "", limit } = req.query;
    const lim = coerceLimit(limit);
    const conn = await getConnection();
    const pattern = q === "" ? "" : q;
    const sql = `select * from (
      select device_name as name, 'device' as type, device_name as device_name, NULL as metric_name from devices where $pattern='' or device_name ilike $pattern||'%'
      union all
      select metric_name as name, 'metric' as type, device_name as device_name, metric_name as metric_name from device_metrics where $pattern='' or metric_name ilike $pattern||'%'
    ) order by name asc, type asc limit $limit`;
    const reader = await conn.runAndReadAll(sql, { pattern, limit: lim });
    const rows = reader.getRowObjects();
    return {
      query: q,
      limit: lim,
      count: rows.length,
      truncated: rows.length === lim,
      results: rows.map((r) =>
        r.type === "device"
          ? { type: "device", deviceName: r.device_name }
          : {
              type: "metric",
              deviceName: r.device_name,
              metricName: r.metric_name,
            }
      ),
    };
  });
  app.get("/api/devices/status", async (req: any, reply: any) => {
    const list = String(req.query.devices || "")
      .split(",")
      .map((s: string) => s.trim())
      .filter((s: string) => s.length);
    if (TRACE_ENABLED)
      logger
        .with()
        .any?.("devices", list)
        .logger()
        .info("trace devices/status request list");
    if (!list.length) return { statuses: [] };
    const valuesClause = list.map((_, i) => `($d${i})`).join(",");
    const params: Record<string, any> = {};
    list.forEach((d, i) => (params[`d${i}`] = d));
    const sql = `with input(device_name) as (values ${valuesClause})
      select i.device_name,
             max(v.ts) as last_ts,
             case
               when max(v.ts) is null then 'grey'
               when max(v.ts) >= current_timestamp - interval '1 day' then 'green'
               when max(v.ts) >= current_timestamp - interval '7 day' then 'yellow'
               else 'red'
             end as status
      from input i
      left join device_metrics m on m.device_name = i.device_name
      left join device_metric_values v on v.metric_id = m.id
      group by i.device_name`;
    if (TRACE_ENABLED)
      logger.with().str?.("sql", sql).logger().info("trace devices/status sql");
    const conn = await getConnection();
    const reader = await conn.runAndReadAll(sql, params);
    const rows = reader.getRowObjects();
    if (TRACE_ENABLED)
      logger
        .with()
        .any?.("rows", rows)
        .logger()
        .info("trace devices/status raw rows");
    const statuses = rows.map((r: any) => ({
      name: r.device_name,
      status: r.status,
    }));
    if (TRACE_ENABLED)
      logger
        .with()
        .any?.("statuses", statuses)
        .logger()
        .info("trace devices/status result");
    return { statuses };
  });
  app.get(
    "/api/devices/:device/metrics/status",
    async (req: any, reply: any) => {
      const { device } = req.params;
      const list = String(req.query.metrics || "")
        .split(",")
        .map((s: string) => s.trim())
        .filter((s: string) => s.length);
      if (TRACE_ENABLED)
        logger
          .with()
          .str?.("device", device)
          .array?.("metrics", list)
          .logger()
          .info("trace metrics/status request list");
      if (!list.length) return { statuses: [] };
      const valuesClause = list.map((_, i) => `($m${i})`).join(",");
      const params: Record<string, any> = { device };
      list.forEach((m, i) => (params[`m${i}`] = m));
      const sql = `with input(metric_name) as (values ${valuesClause})
      select i.metric_name,
             max(v.ts) as last_ts,
             case
               when max(v.ts) is null then 'grey'
               when max(v.ts) >= current_timestamp - interval '1 day' then 'green'
               when max(v.ts) >= current_timestamp - interval '7 day' then 'yellow'
               else 'red'
             end as status
      from input i
      left join device_metrics dm on dm.device_name=$device and dm.metric_name = i.metric_name
      left join device_metric_values v on v.metric_id = dm.id
      group by i.metric_name`;
      if (TRACE_ENABLED)
        logger
          .with()
          .str?.("sql", sql)
          .logger()
          .info("trace metrics/status sql");
      const conn = await getConnection();
      const reader = await conn.runAndReadAll(sql, params);
      const rows = reader.getRowObjects();
      if (TRACE_ENABLED)
        logger
          .with()
          .any?.("rows", rows)
          .logger()
          .info("trace metrics/status raw rows");
      const statuses = rows.map((r: any) => ({
        name: r.metric_name,
        status: r.status,
      }));
      if (TRACE_ENABLED)
        logger
          .with()
          .any?.("statuses", statuses)
          .logger()
          .info("trace metrics/status result");
      return { statuses };
    }
  );
}

// -------------------- Web Server (API only) --------------------
async function startWebServer() {
  const app = Fastify({ logger: true });
  app.register(cors, { origin: true });

  // ---- Global request/response instrumentation ----
  app.addHook("onRequest", (req: any, _reply, done) => {
    (req as any)._startHrTime = process.hrtime.bigint();
    done();
  });
  app.addHook("onResponse", (req: any, reply: any, done) => {
    try {
      const start = (req as any)._startHrTime as bigint | undefined;
      const durMs = start
        ? Number((process.hrtime.bigint() - start) / BigInt(1_000_000))
        : undefined;
      const sc = reply.statusCode;
      if (
        sc >= 500 ||
        process.env.LOG_REQUESTS === "1" ||
        (process.env.LOG_SLOW_MS &&
          durMs &&
          durMs >= parseInt(process.env.LOG_SLOW_MS, 10))
      ) {
        logger
          .with()
          .str?.("method", req.method)
          .str?.("url", req.url)
          .num?.("status", sc)
          .num?.("ms", durMs || 0)
          .logger()
          .info("request");
      }
    } catch (e) {
      logger.with().error(e).logger().warn("onResponse hook failed");
    }
    done();
  });

  // ---- Central error handler (before route registration optional) ----
  app.setErrorHandler((err, req, reply) => {
    logger
      .with()
      .error(err)
      .str?.("method", req.method)
      .str?.("url", req.url)
      .logger()
      .error("unhandled");
    if (!reply.sent) {
      reply
        .code(500)
        .send({ error: "Internal Server Error", message: err.message });
    }
  });

  registerApi(app);
  const isDev = process.env.NODE_ENV !== "production";
  let viteFailed = false;
  if (isDev && process.env.DISABLE_VITE !== "1") {
    process.env.VITE_MIDDLEWARE = "1"; // signal to vite.config.ts to disable /api proxy
    try {
      await app.register(require("@fastify/middie"));
      const { createServer } = await import("vite");
      const vite = await createServer({
        server: {
          middlewareMode: true,
          hmr: process.env.VITE_DISABLE_HMR === "1" ? false : undefined,
        },
        appType: "custom",
      });
      (app as any).use((req: any, res: any, next: any) => {
        if (viteFailed) {
          res.statusCode = 503;
          res.end("Vite disabled after previous failure");
          return;
        }
        vite.middlewares(req, res, next);
      });
      // Root HTML (and any non-API path) -> Vite index.html
      app.get("/*", async (req: any, reply: any) => {
        if (req.url.startsWith("/api/")) return reply.callNotFound();
        if (viteFailed) return reply.code(503).send("Vite disabled");
        const indexPath = path.resolve(process.cwd(), "index.html");
        try {
          const rawHtml = readFileSync(indexPath, "utf8");
          const html = await vite.transformIndexHtml(req.url, rawHtml);
          reply.type("text/html").send(html);
        } catch (e) {
          viteFailed = true; // fail fast: stop repeated transform attempts
          logger
            .with()
            .error(e)
            .logger()
            .error("Vite transform failed; disabling Vite middleware");
          reply.code(500).send("Vite transform failed");
        }
      });
      logger.info("Vite dev middleware enabled");
    } catch (e) {
      viteFailed = true;
      logger
        .with()
        .error(e)
        .logger()
        .warn("Failed to start Vite dev server; continuing without it");
    }
  } else if (isDev) {
    logger.warn("Vite dev middleware disabled via DISABLE_VITE=1");
  }
  await app.listen({
    port: parseInt(process.env.PORT || "3000", 10),
    host: "0.0.0.0",
  });
  logger.info(
    "API server started" +
      (isDev && !viteFailed && process.env.DISABLE_VITE !== "1"
        ? " (with Vite)"
        : "")
  );
  return app;
}

// -------------------- Main Flow --------------------
async function main() {
  await initDb();
  if (process.env.DISABLE_SPARKPLUG !== "1") {
    // start sparkplug client ingestion
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
  }
  await startWebServer();

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
