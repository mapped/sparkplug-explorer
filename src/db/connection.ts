import { DuckDBInstance, DuckDBConnection } from "@duckdb/node-api";
import { mkdirSync, existsSync } from "fs";
import { dirname } from "path";

const DEFAULT_DB_PATH = process.env.DUCKDB_PATH || "./data/iot.duckdb"; // file-backed persistence

let instancePromise: Promise<DuckDBInstance> | null = null;

export async function getInstance(
  dbPath: string = DEFAULT_DB_PATH
): Promise<DuckDBInstance> {
  if (!instancePromise) {
    if (dbPath !== ":memory:") {
      const dir = dirname(dbPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    instancePromise = DuckDBInstance.create(dbPath, {
      threads: process.env.DUCKDB_THREADS || "4",
      memory_limit: process.env.DUCKDB_STARTUP_MEMORY || "4GB",
    });
  }
  return instancePromise;
}

let connectionPromise: Promise<DuckDBConnection> | null = null;

export async function getConnection(
  dbPath?: string
): Promise<DuckDBConnection> {
  if (!connectionPromise) {
    const inst = await getInstance(dbPath || DEFAULT_DB_PATH);
    connectionPromise = inst.connect();
  }
  return connectionPromise;
}

export async function closeConnection(): Promise<void> {
  if (connectionPromise) {
    const conn = await connectionPromise;
    conn.closeSync();
    connectionPromise = null;
  }
  if (instancePromise) {
    const inst = await instancePromise;
    inst.closeSync?.();
    instancePromise = null;
  }
}
