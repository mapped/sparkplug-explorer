export interface Device {
  deviceName: string;
  topic: string;
  birthTimestamp?: Date; // JS Date mapped to DuckDB TIMESTAMP
}

export interface DeviceMetric {
  id: string; // deviceName/metricName
  deviceName: string;
  metricName: string;
}

export interface DeviceMetricValue {
  metricId: string;
  ts: Date; // timestamp of metric value
  value: string | number | boolean | null; // accept flexible types on write and (after parsing) on read
  fromBirth?: boolean; // indicates if this value is from a DBIRTH message
}

// CamelCase model returned by helpers (DB columns remain snake_case internally)
export interface DeviceMetricLatestRow {
  deviceName: string;
  topic: string;
  birthTimestamp: Date;
  metricId: string;
  metricName: string;
  latestTs: Date | null;
  latestValue: string | number | boolean | null; // parsed flexible type
}

export function metricId(deviceName: string, metricName: string): string {
  return `${deviceName}/${metricName}`;
}
