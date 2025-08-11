# Sparkplug Explorer

A combined Sparkplug B ingestion service and interactive web UI for exploring devices, metrics, and live metric values. It connects to an MQTT broker publishing Sparkplug B payloads, persists data to DuckDB, and exposes a Fastify REST API consumed by a React (Vite) frontend.

## Quick Start

### Prerequisites

- Node.js 18+
- Yarn 1.x (or npm)
- MQTT broker emitting Sparkplug B (optional for UI-only exploration)

### 1. Install Dependencies

```
yarn install
```

### 2. Create a Config File (config.json)

```json
{
  "sparkplug": {
    "groupIds": ["sp_group"],
    "systemTopic": "spBv1.0/sp_group/STATE"
  },
  "mqtt": {
    "url": "mqtts://broker.example.com:8883",
    "protocolVersion": 5,
    "clientId": "explorer-client",
    "hostId": "explorer-host",
    "reconnectBackoffSec": 5,
    "keepaliveSec": 30
  },
  "advanced": { "disableTimeseries": false },
  "secrets": { "credentials": { "username": "user", "password": "pass" } }
}
```

(Only the MQTT section + secrets credentials are strictly consumed by current code; unused advanced keys are placeholders.)

### 3. Run in Development (API + UI middleware)

```
yarn dev config.json
```

Or:

```
CONFIG_PATH=./config.json yarn dev
```

Visit: http://localhost:3000

Disable ingestion (UI/API only):

```
DISABLE_SPARKPLUG=1 yarn dev config.json
```

### 4. Production Build & Run

```
yarn build
CONFIG_PATH=./config.json yarn start
```

Artifacts:

- dist/index.js (server)
- dist/ui (built React app)

### 5. Minimal Environment Variables

| Variable          | Typical Value     |
| ----------------- | ----------------- |
| CONFIG_PATH       | ./config.json     |
| PORT              | 3000              |
| DUCKDB_PATH       | ./data/iot.duckdb |
| GLOBAL_LOG_LEVEL  | INFO              |
| DISABLE_SPARKPLUG | 1 (optional)      |

Full list shown later.

## API Summary

Base path: `/api`

- GET /api/health
- GET /api/config
- GET /api/devices?cursor&limit
- GET /api/devices/count
- GET /api/devices/index?device=NAME
- GET /api/devices/:device/metrics?cursor&limit
- GET /api/devices/:device/metrics/count
- GET /api/devices/:device/metrics/index?metric=NAME
- GET /api/metrics/:device/:metric/latest
- GET /api/metrics/:device/:metric/values?from&to&limit&order=asc|desc
- GET /api/search?q&limit (case‑insensitive prefix search)
- GET /api/devices/status?devices=a,b
- GET /api/devices/:device/metrics/status?metrics=x,y

Status response:

```
{ "statuses": [ { "name": "DeviceOrMetric", "status": "green|yellow|red|grey" } ] }
```

Search response:

```
{ "query":"q", "limit":25, "count":N, "truncated":false, "results":[ ... ] }
```

## Features

- Sparkplug B host application MQTT client (subscribe to all topics) with birth message support
- Batched ingestion of DBIRTH & DDATA (micro-batching + rollback on failure)
- Device / metric schema with latest + historical queries
- Fast in-process DuckDB persistence (file-backed)
- REST API with pagination, search, status classification
- React + Vite UI with:
  - Virtualized lists (react-window)
  - Loading glow (animated) until status known (grey suppressed)
  - Debounced search & stable status indicators (flicker-free)
  - Metric detail pane (numeric/boolean chart or table-only)
  - Light/dark theme, persisted state, deep-linking via query params

## UI Behavior Notes

- Pages of 500 items for devices/metrics, virtualized rendering
- Forced metrics reload on device selection (reloadSeq)
- Polling continues for visible unresolved statuses (every 3s)
- Stable status maps prevent reverting to glow once color known
- Chart shown only for numeric or coercible boolean series

## Environment Variables (Complete)



| Variable                      | Purpose                        | Default                     |
| ----------------------------- | ------------------------------ | --------------------------- |
| CONFIG_PATH                   | Path to JSON config            | (required if no CLI arg)    |
| PORT                          | HTTP port                      | 3000                        |
| DUCKDB_PATH                   | DuckDB file path               | ./data/iot.duckdb           |
| DUCKDB_THREADS                | DuckDB threads                 | 4                           |
| DUCKDB_STARTUP_MEMORY         | DuckDB initial memory limit    | 4GB                         |
| GLOBAL_LOG_LEVEL              | TRACE/DEBUG/INFO/WARN/ERROR    | INFO                        |
| GLOBAL_LOG_FORMAT             | json                           | simple                      |
| GLOBAL_LOG_TIMESTAMP          | Include timestamp if set       | (off)                       |
| GLOBAL_LOG_CONTEXT_FOR_LEVELS | Levels with context logging    | trace,debug,info,warn,error |
| TRACE                         | Extra trace for status SQL     | (off)                       |
| UI_POLL_INTERVAL_MS           | Value surfaced via /api/config | 5000                        |
| LOG_REQUESTS                  | Log all HTTP requests          | (off)                       |
| LOG_SLOW_MS                   | Log slow requests >= ms        | (off)                       |
| DISABLE_SPARKPLUG             | Skip MQTT ingestion            | (off)                       |
| DISABLE_VITE                  | Disable dev middleware         | (off)                       |
| VITE_DISABLE_HMR              | Disable HMR in middleware mode | (off)                       |
| NODE_ENV                      | Node environment               | development                 |

## Architecture Overview

```
+------------------+        MQTT (Sparkplug B)        +---------------------+
|   MQTT Broker    |  <-----------------------------> | Sparkplug Explorer  |
+------------------+                                   |  (Fastify + DuckDB) |
                                                       |  Ingestion + API    |
                                                       +----------+---------+
                                                                  |
                                                     HTTP / JSON  |
                                                                  v
                                                       +--------------------+
                                                       | React UI (Vite)    |
                                                       +--------------------+
```

## Data Model

Tables:

- devices(device_name PK, topic, birth_timestamp)
- device_metrics(id PK, device_name, metric_name, UNIQUE(device_name,metric_name))
- device_metric_values(metric_id, ts, ingested_at, value, from_birth)
  Indexes: idx_devices_name, idx_device_metrics_metric_name, idx_device_metrics_dev_metric, idx_metric_values_id_ts

## Status Classification

SQL CASE on max(ts):

- green: within 1 day
- yellow: within 7 days
- red: older
- grey: none yet (UI shows loading glow)

## Logging

Custom logger (JSON or color simple). Use GLOBAL_LOG_LEVEL & TRACE for deep debugging.

## Persistence & Performance

- DuckDB file (auto-created) at DUCKDB_PATH
- Micro-batch up to 500 messages per transaction (DBIRTH priority over DDATA)
- Bulk insert for metrics & values

## Extensibility Ideas

- Retention / downsampling
- Static file serving in production (add @fastify/static)
- Authentication / multi-tenancy
- Aggregation & rollups
- WebSockets / SSE for push updates

## Troubleshooting

| Symptom                    | Cause                        | Fix                                     |
| -------------------------- | ---------------------------- | --------------------------------------- |
| Pulsing dots forever       | No data / ingestion disabled | Ensure broker & unset DISABLE_SPARKPLUG |
| Status flicker             | (Mitigated) state overwrite  | Reload; stable maps keep first color    |
| High memory                | Large working set            | Tune DUCKDB_STARTUP_MEMORY / prune data |
| Missing first metrics page | Old race (fixed)             | Confirm reloadSeq increments            |

## Development Tips

- DuckDB UI extension attempts to start; logs success/failure
- GLOBAL_LOG_FORMAT=simple for readable console
- TRACE=1 to inspect status SQL & rows

## License

MIT. See [LICENSE](./LICENSE).

---

(README generated; adjust as project evolves.)
