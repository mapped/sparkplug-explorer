import React, { useEffect, useState, useLayoutEffect, useRef } from "react";
import {
  Box,
  Typography,
  ToggleButtonGroup,
  ToggleButton,
  Paper,
  Table,
  TableHead,
  TableRow,
  TableCell,
  TableBody,
} from "@mui/material";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { Tooltip as RechartsTooltipProps } from "recharts";

interface Props {
  device?: string;
  metric?: string;
}
interface ValueRow {
  ts: string;
  value: any;
  fromBirth: boolean;
}
interface CoercedPoint {
  ts: string;
  valueNum: number;
  raw: any;
  fromBirth: boolean;
}
function tryNumber(v: any): number | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const s = String(v).trim();
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}
function tryBoolean(v: any): boolean | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  if (["true", "t", "yes", "y", "on", "1"].includes(s)) return true;
  if (["false", "f", "no", "n", "off", "0"].includes(s)) return false;
  return undefined;
}

const MetricDetailPane: React.FC<Props> = ({ device, metric }) => {
  const [range, setRange] = useState<"24h" | "7d">("24h");
  const [values, setValues] = useState<ValueRow[]>([]);
  const [latest, setLatest] = useState<ValueRow | null>(null);
  const pollInterval = 5000;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [chartHeight, setChartHeight] = useState(240);

  useEffect(() => {
    // fetch history
    async function load() {
      if (!device || !metric) {
        setValues([]);
        setLatest(null);
        return;
      }
      const now = new Date();
      const to = now.toISOString();
      const from = new Date(
        now.getTime() - (range === "24h" ? 24 : 24 * 7) * 3600 * 1000
      ).toISOString();
      const r = await fetch(
        `/api/metrics/${encodeURIComponent(device)}/${encodeURIComponent(
          metric
        )}/values?from=${encodeURIComponent(from)}&to=${encodeURIComponent(
          to
        )}&limit=1000&order=desc`
      ).then((r) => r.json());
      setValues(r.items);
    }
    load();
  }, [device, metric, range]);

  useEffect(() => {
    // poll latest
    let id: any;
    async function poll() {
      if (!device || !metric) return;
      const r = await fetch(
        `/api/metrics/${encodeURIComponent(device)}/${encodeURIComponent(
          metric
        )}/latest`
      ).then((r) => r.json());
      if (r.ts)
        setLatest({ ts: r.ts, value: r.value, fromBirth: !!r.fromBirth });
      id = setTimeout(poll, pollInterval);
    }
    poll();
    return () => {
      if (id) clearTimeout(id);
    };
  }, [device, metric]);

  const chartPrep = React.useMemo(() => {
    if (!values.length) return { type: "empty", points: [] as CoercedPoint[] };
    // First attempt numeric
    const numericPoints: CoercedPoint[] = [];
    let allNumeric = true;
    for (const v of values) {
      const num = tryNumber(v.value);
      if (num === undefined) {
        allNumeric = false;
        break;
      }
      numericPoints.push({
        ts: v.ts,
        valueNum: num,
        raw: v.value,
        fromBirth: v.fromBirth,
      });
    }
    if (allNumeric) return { type: "number", points: numericPoints };
    // Attempt boolean -> map to 0/1
    const boolPoints: CoercedPoint[] = [];
    let allBool = true;
    for (const v of values) {
      const b = tryBoolean(v.value);
      if (b === undefined) {
        allBool = false;
        break;
      }
      boolPoints.push({
        ts: v.ts,
        valueNum: b ? 1 : 0,
        raw: v.value,
        fromBirth: v.fromBirth,
      });
    }
    if (allBool) return { type: "boolean", points: boolPoints };
    return { type: "string", points: [] as CoercedPoint[] };
  }, [values]);

  const chartData = React.useMemo(() => {
    if (chartPrep.type === "number" || chartPrep.type === "boolean") {
      return [...chartPrep.points]
        .reverse()
        .map((p) => ({ ts: new Date(p.ts).getTime(), value: p.valueNum }));
    }
    return [];
  }, [chartPrep]);

  // Generate ticks based on selected range
  const xTicks = React.useMemo(() => {
    if (!chartData.length) return [] as number[];
    const end = Date.now();
    const rangeMs = range === "24h" ? 24 * 3600 * 1000 : 7 * 24 * 3600 * 1000;
    const start = end - rangeMs;
    const intervalMs = range === "24h" ? 15 * 60 * 1000 : 60 * 60 * 1000;
    // align start to next interval boundary
    const startAligned = Math.ceil(start / intervalMs) * intervalMs;
    const ticks: number[] = [];
    for (let t = startAligned; t <= end; t += intervalMs) ticks.push(t);
    return ticks;
  }, [range, chartData]);

  const formatTick = React.useCallback(
    (t: number) => {
      const d = new Date(t);
      if (range === "24h") {
        return d.toLocaleTimeString(undefined, {
          hour: "2-digit",
          minute: "2-digit",
        });
      }
      return (
        d.toLocaleDateString(undefined, { month: "numeric", day: "numeric" }) +
        " " +
        d.toLocaleTimeString(undefined, { hour: "2-digit" })
      );
    },
    [range]
  );

  const showChart = chartPrep.type === "number" || chartPrep.type === "boolean";
  const latestDisplay = latest ? String(latest.value) : "";

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        // allocate roughly half the vertical space to chart (min 200)
        const h = e.contentRect.height;
        setChartHeight(Math.max(200, Math.min(400, Math.floor(h * 0.45))));
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload || !payload.length) return null;
    const tsNum = Number(label);
    const fullTs = new Date(tsNum);
    return (
      <Box sx={{ p: 1 }}>
        <Typography variant="caption" sx={{ display: "block" }}>
          {fullTs.toLocaleString()}
        </Typography>
        <Typography variant="body2" sx={{ fontWeight: 500 }}>
          Value: {payload[0].value}
        </Typography>
      </Box>
    );
  };

  return (
    <Box
      ref={containerRef}
      sx={{
        p: 1,
        display: "flex",
        flexDirection: "column",
        gap: 1,
        overflow: "hidden",
        height: "100%",
        minHeight: 0,
      }}
    >
      <Box
        sx={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <Typography variant="h6">
          {metric ? `${metric}` : "Select a metric"}
        </Typography>
        {latest && (
          <Typography variant="body2">
            Latest: {latestDisplay} {chartPrep.type === "boolean" && "(bool)"}{" "}
            <Box component="span" sx={{ opacity: 0.6 }}>
              {new Date(latest.ts).toLocaleTimeString()}
            </Box>
          </Typography>
        )}
      </Box>
      <ToggleButtonGroup
        size="small"
        value={range}
        exclusive
        onChange={(_, v) => v && setRange(v)}
      >
        <ToggleButton value="24h">24h</ToggleButton>
        <ToggleButton value="7d">7d</ToggleButton>
      </ToggleButtonGroup>
      <Paper variant="outlined" sx={{ flex: 0, minHeight: chartHeight, p: 1 }}>
        {showChart ? (
          <ResponsiveContainer width="100%" height={chartHeight - 16}>
            <LineChart
              data={chartData}
              margin={{ left: 8, right: 8, top: 4, bottom: 4 }}
            >
              <XAxis
                dataKey="ts"
                type="number"
                domain={["dataMin", "dataMax"]}
                ticks={xTicks}
                tickFormatter={formatTick}
                interval={0}
                tick={{ fontSize: 10 }}
              />
              <YAxis
                width={60}
                tickLine={false}
                domain={["auto", "auto"]}
                tick={{ fontSize: 10 }}
              />
              <Tooltip
                content={<CustomTooltip />}
                labelFormatter={(l) => formatTick(Number(l))}
                formatter={(val: any) => [val, "Value"]}
              />
              <Line
                type="monotone"
                dataKey="value"
                stroke="#1976d2"
                dot={false}
                strokeWidth={1}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <Box
            sx={{
              height: 240,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "text.secondary",
              fontSize: 12,
            }}
          >
            Non-numeric metric (chart hidden)
          </Box>
        )}
      </Paper>
      <Paper
        variant="outlined"
        sx={{ flex: 1, overflow: "auto", minHeight: 0 }}
      >
        <Table size="small" stickyHeader>
          <TableHead>
            <TableRow>
              <TableCell>Timestamp</TableCell>
              <TableCell>Value</TableCell>
              <TableCell>Birth</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {values.map((v) => (
              <TableRow key={v.ts} hover>
                <TableCell title={new Date(v.ts).toISOString()}>
                  {new Date(v.ts).toLocaleString()}
                </TableCell>
                <TableCell>{String(v.value)}</TableCell>
                <TableCell>{v.fromBirth ? "Y" : ""}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Paper>
    </Box>
  );
};
export default MetricDetailPane;
