import { DuckDBConnection } from "@duckdb/node-api";

export async function createSchema(
  connection: DuckDBConnection
): Promise<void> {
  // devices table
  await connection.run(`create table if not exists devices (
    device_name text,
    topic text not null,
    birth_timestamp timestamp
  )`);

  // device_metrics table
  await connection.run(`create table if not exists device_metrics (
    id text,
    device_name text not null,
    metric_name text not null
  )`);

  // device_metric_values table (value stored as string for flexible reporting)
  await connection.run(`create table if not exists device_metric_values (
    metric_id text not null,
    ts timestamp not null,
    ingested_at timestamp not null default current_timestamp,
    value varchar(256),
    from_birth boolean default false, -- indicates if this value is from a DBIRTH message
  )`);
}

export async function loadExtensions(
  connection: DuckDBConnection
): Promise<void> {
  // Attempt to install and load UI extension (idempotent)
  try {
    await connection.run(`install 'ui'`);
  } catch (e) {
    // Ignore if already installed or unavailable
    console.warn("UI extension install warning:", (e as Error).message);
  }
  try {
    await connection.run(`load 'ui'`);
  } catch (e) {
    console.warn("UI extension load warning:", (e as Error).message);
  }
}
