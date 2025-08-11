import { DuckDBConnection } from "@duckdb/node-api";
import {
  Device,
  DeviceMetric,
  DeviceMetricLatestRow,
  DeviceMetricValue,
  metricId,
} from "../types";

// Utility to normalize a DuckDB timestamp value (object or string) to JS Date
function toDate(val: any): Date {
  if (val == null) return new Date(NaN);
  if (val instanceof Date) return val;
  if (typeof val === "string") return new Date(val.replace(" ", "T") + "Z");
  if (typeof val.toString === "function") {
    const s = val.toString();
    return new Date(s.replace(" ", "T") + "Z");
  }
  return new Date(NaN);
}

function toStoredValue(v: string | number | boolean | null): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function parseStoredValue(v: any): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return v as any;
  const s = v.trim();
  if (s === "true") return true;
  if (s === "false") return false;
  // numeric? allow integer or float
  if (/^[+-]?\d+(?:\.\d+)?$/.test(s)) {
    const num = Number(s);
    if (!Number.isNaN(num)) return num;
  }
  return s; // fallback to raw string
}

// Simplified repositories assuming DuckDB supports full ON CONFLICT DO UPDATE syntax.
export class DeviceRepository {
  constructor(private conn: DuckDBConnection) {}

  async upsert(device: Device): Promise<void> {
    // Idempotent upsert using ON CONFLICT
    await this.conn.run(
      `insert into devices(device_name, topic, birth_timestamp)
       values($device_name, $topic, $birth_timestamp)
       on conflict(device_name) do update set
         topic=excluded.topic,
         birth_timestamp=coalesce(excluded.birth_timestamp, devices.birth_timestamp)`,
      {
        device_name: device.deviceName,
        topic: device.topic,
        birth_timestamp: device.birthTimestamp
          ? device.birthTimestamp
              ?.toISOString()
              .replace("T", " ")
              .replace("Z", "")
          : null,
      }
    );
  }

  async getAll(): Promise<Device[]> {
    const reader = await this.conn.runAndReadAll(
      `select device_name, topic, birth_timestamp from devices`
    );
    return reader.getRowObjects().map((r: any) => ({
      deviceName: String(r.device_name),
      topic: String(r.topic),
      birthTimestamp: toDate(r.birth_timestamp),
    }));
  }
}

export class DeviceMetricRepository {
  constructor(private conn: DuckDBConnection) {}

  async upsert(deviceName: string, metricName: string): Promise<DeviceMetric> {
    const id = metricId(deviceName, metricName);
    await this.conn.run(
      `insert into device_metrics(id, device_name, metric_name) values($id,$device_name,$metric_name)
       on conflict(id) do nothing`,
      { id, device_name: deviceName, metric_name: metricName }
    );
    return { id, deviceName, metricName };
  }

  async insertMany(
    records: { deviceName: string; metricName: string }[]
  ): Promise<DeviceMetric[]> {
    if (!records.length) return [];
    // Deduplicate incoming list (since caller already filtered known ones, this is defensive)
    const seen = new Set<string>();
    const rows: string[] = [];
    function esc(s: string) {
      return s.replace(/'/g, "''");
    }
    for (const r of records) {
      const id = metricId(r.deviceName, r.metricName);
      if (seen.has(id)) continue;
      seen.add(id);
      rows.push(`('${esc(id)}','${esc(r.deviceName)}','${esc(r.metricName)}')`);
    }
    if (!rows.length) return [];
    const sql = `insert into device_metrics(id, device_name, metric_name) values ${rows.join(
      ","
    )} on conflict(id) do nothing`;
    await this.conn.run(sql);
    return Array.from(seen).map((id) => {
      const [deviceName, metricName] = id.split(":", 2); // metricId format assumed deviceName:metricName
      return { id, deviceName, metricName } as DeviceMetric;
    });
  }

  async listByDevice(deviceName: string): Promise<DeviceMetric[]> {
    const reader = await this.conn.runAndReadAll(
      `select id, device_name, metric_name from device_metrics where device_name=$d`,
      { d: deviceName }
    );
    return reader.getRowObjects().map((r: any) => ({
      id: String(r.id),
      deviceName: String(r.device_name),
      metricName: String(r.metric_name),
    }));
  }
}

export class DeviceMetricValueRepository {
  constructor(private conn: DuckDBConnection) {}

  async insert(value: DeviceMetricValue): Promise<void> {
    await this.conn.run(
      `insert into device_metric_values(metric_id, ts, value) values($metric_id,$ts,$value)`,
      {
        metric_id: value.metricId,
        ts: value.ts.toISOString().replace("T", " ").replace("Z", ""),
        value: toStoredValue(value.value),
      }
    );
  }

  async insertMany(values: DeviceMetricValue[]): Promise<void> {
    if (!values.length) return;
    function esc(s: string) {
      return s.replace(/'/g, "''");
    }
    const rows: string[] = [];
    for (const v of values) {
      const tsStr = v.ts.toISOString().replace("T", " ").replace("Z", "");
      const val = toStoredValue(v.value);
      rows.push(
        `('${esc(v.metricId)}','${esc(tsStr)}',${
          val == null ? "NULL" : `'${esc(String(val))}'`
        }, ${v.fromBirth ? "TRUE" : "FALSE"})`
      );
    }
    const sql = `insert into device_metric_values(metric_id, ts, value, from_birth) values ${rows.join(
      ","
    )}`;
    await this.conn.run(sql);
  }

  async range(
    metricId: string,
    from?: Date,
    to?: Date
  ): Promise<DeviceMetricValue[]> {
    const conditions: string[] = ["metric_id=$m"];
    const params: any = { m: metricId };
    if (from) {
      conditions.push("ts >= $from");
      params.from = from.toISOString().replace("T", " ").replace("Z", "");
    }
    if (to) {
      conditions.push("ts <= $to");
      params.to = to.toISOString().replace("T", " ").replace("Z", "");
    }
    const where = conditions.join(" and ");
    const reader = await this.conn.runAndReadAll(
      `select metric_id, ts, value from device_metric_values where ${where} order by ts`,
      params
    );
    return reader.getRowObjects().map((r: any) => ({
      metricId: String(r.metric_id),
      ts: toDate(r.ts),
      value: parseStoredValue(r.value),
    }));
  }

  async latest(metricId: string): Promise<DeviceMetricValue | null> {
    const reader = await this.conn.runAndReadAll(
      `select metric_id, ts, value from device_metric_values where metric_id=$m order by ts desc limit 1`,
      { m: metricId }
    );
    const rows = reader.getRowObjects();
    if (!rows.length) return null;
    const r: any = rows[0];
    return {
      metricId: String(r.metric_id),
      ts: toDate(r.ts),
      value: parseStoredValue(r.value),
    };
  }

  // Stream all devices with their metrics and the latest metric value & timestamp.
  // Returns an async iterator yielding DeviceMetricLatestRow objects.
  async *streamLatestByDevice(): AsyncGenerator<DeviceMetricLatestRow> {
    const sql = `with latest as (
      select metric_id, max(ts) as latest_ts
      from device_metric_values
      group by metric_id
    )
    select d.device_name, d.topic, d.birth_timestamp,
           m.id as metric_id, m.metric_name,
           v.ts as latest_ts, v.value as latest_value
    from devices d
    join device_metrics m on m.device_name = d.device_name
    left join latest l on l.metric_id = m.id
    left join device_metric_values v
      on v.metric_id = l.metric_id and v.ts = l.latest_ts
    order by d.device_name, m.metric_name`;

    const result = await this.conn.stream(sql);
    while (true) {
      const chunk = await result.fetchChunk();
      if (!chunk || chunk.rowCount === 0) break;
      const rows = chunk.getRowObjects(
        result.deduplicatedColumnNames()
      ) as any[];
      for (const row of rows) {
        yield {
          deviceName: String(row.device_name),
          topic: String(row.topic),
          birthTimestamp: toDate(row.birth_timestamp),
          metricId: String(row.metric_id),
          metricName: String(row.metric_name),
          latestTs: row.latest_ts ? toDate(row.latest_ts) : null,
          latestValue: parseStoredValue(row.latest_value),
        };
      }
    }
  }
}
