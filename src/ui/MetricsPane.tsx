import React, {
  useEffect,
  useState,
  useRef,
  useCallback,
  useLayoutEffect,
} from "react";
import { Box, ListItemButton, ListItemText } from "@mui/material";
import { FixedSizeList } from "react-window";
import { keyframes } from "@emotion/react";

// Alias to avoid react-window type incompatibilities
const VList: React.ComponentType<any> = FixedSizeList as any;

interface Metric {
  metricName: string;
  id: string;
}
interface Props {
  device?: string;
  selectedMetric?: string;
  onSelect(m: string): void;
  reloadSeq?: number; // increments to force reload
}

interface MetricStatusMap {
  [name: string]: "green" | "yellow" | "red" | undefined;
}

const PAGE_SIZE = 500;
const ITEM_HEIGHT = 40;
const PREFETCH_THRESHOLD = 50;
const FOOTER_HEIGHT = 28;

const pulse = keyframes`
  0% { transform: scale(.6); opacity: .4; }
  50% { transform: scale(1); opacity: 1; }
  100% { transform: scale(.6); opacity: .4; }
`;

const MetricsPane: React.FC<Props> = ({
  device,
  selectedMetric,
  onSelect,
  reloadSeq,
}) => {
  const [metrics, setMetrics] = useState<Metric[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [lastDevice, setLastDevice] = useState<string | undefined>();
  const [total, setTotal] = useState<number | undefined>();
  const [statuses, setStatuses] = useState<MetricStatusMap>({});
  const pendingStatusFetch = useRef<number | null>(null);
  const visibleRangeRef = useRef<{ start: number; stop: number }>({
    start: 0,
    stop: 0,
  });
  const listRef = useRef<any>(null);
  const fetchingRef = useRef(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerHeight, setContainerHeight] = useState(0);

  const fetchTotal = useCallback(async (dev?: string) => {
    if (!dev) return;
    setTotal(undefined);
    try {
      const r = await fetch(
        `/api/devices/${encodeURIComponent(dev)}/metrics/count`
      ).then((r) => r.json());
      setTotal(r.count);
    } catch {
      /* ignore */
    }
  }, []);

  const loadMore = useCallback(
    async (force: boolean = false) => {
      if (!device || loading || fetchingRef.current) return;
      if (!force) {
        if (
          cursor === undefined &&
          metrics.length &&
          total !== undefined &&
          metrics.length >= total
        )
          return;
      }
      fetchingRef.current = true;
      setLoading(true);
      const params = new URLSearchParams();
      params.set("limit", String(PAGE_SIZE));
      if (cursor) params.set("cursor", cursor);
      const r = await fetch(
        `/api/devices/${encodeURIComponent(
          device
        )}/metrics?${params.toString()}`
      ).then((r) => r.json());
      setMetrics((prev) => [...prev, ...r.items]);
      if (r.nextCursor) setCursor(r.nextCursor);
      else setCursor(undefined);
      setLoading(false);
      fetchingRef.current = false;
    },
    [device, cursor, loading, metrics.length, total]
  );

  // Reset when device changes or reloadSeq increments (force refresh)
  useEffect(() => {
    setMetrics([]);
    setCursor(undefined);
    setStatuses({});
    setLastDevice(device);
    setTotal(undefined);
    fetchingRef.current = false;
    if (device) {
      void fetchTotal(device);
      // Force first page load even if old metrics length was cached in closure
      void loadMore(true);
    }
  }, [device, reloadSeq]);

  // Scroll selected metric into view
  useEffect(() => {
    if (!selectedMetric) return;
    const idx = metrics.findIndex((m) => m.metricName === selectedMetric);
    if (idx >= 0 && listRef.current) listRef.current.scrollToItem(idx, "smart");
  }, [selectedMetric, metrics]);

  const fetchStatuses = useCallback(
    (names: string[]) => {
      if (!device) return;
      const uniq = Array.from(new Set(names.filter((n) => !!n)));
      if (!uniq.length) return;
      fetch(
        `/api/devices/${encodeURIComponent(
          device
        )}/metrics/status?metrics=${encodeURIComponent(uniq.join(","))}`
      )
        .then((r) => r.json())
        .then((data) => {
          const next: MetricStatusMap = { ...statuses };
          (data.statuses || []).forEach((s: any) => {
            if (s.status === "grey") return; // keep loading state
            next[s.name] = s.status;
          });
          setStatuses(next);
        })
        .catch(() => {});
    },
    [device, statuses]
  );

  const scheduleStatusFetch = useCallback(() => {
    if (pendingStatusFetch.current)
      window.clearTimeout(pendingStatusFetch.current);
    pendingStatusFetch.current = window.setTimeout(() => {
      const { start, stop } = visibleRangeRef.current;
      const slice = metrics.slice(start, Math.min(stop + 1, metrics.length));
      fetchStatuses(slice.map((m) => m.metricName));
    }, 150);
  }, [metrics, fetchStatuses]);

  const handleItemsRendered = ({
    visibleStopIndex,
    visibleStartIndex,
  }: any) => {
    visibleRangeRef.current = {
      start: visibleStartIndex,
      stop: visibleStopIndex,
    };
    scheduleStatusFetch();
    const loaded = metrics.length;
    if (cursor && loaded - visibleStopIndex <= 50) void loadMore();
  };

  const Row = ({
    index,
    style,
  }: {
    index: number;
    style: React.CSSProperties;
  }) => {
    if (index >= metrics.length) {
      return (
        <Box
          style={style}
          sx={{
            px: 2,
            display: "flex",
            alignItems: "center",
            color: "text.disabled",
            fontSize: 12,
          }}
        />
      );
    }
    const m = metrics[index];
    const status = statuses[m.metricName];
    const loading = status === undefined;
    const color =
      !loading && status === "green"
        ? "success.main"
        : !loading && status === "yellow"
        ? "warning.main"
        : !loading && status === "red"
        ? "error.main"
        : "info.main";
    return (
      <Box style={style}>
        <ListItemButton
          selected={m.metricName === selectedMetric}
          onClick={() => onSelect(m.metricName)}
          dense
        >
          <Box
            sx={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              bgcolor: color,
              mr: 1,
              flexShrink: 0,
              ...(loading && {
                animation: `${pulse} 1.2s ease-in-out infinite`,
                boxShadow: (theme: any) =>
                  `0 0 4px 2px ${theme.palette.info.light}`,
              }),
            }}
          />
          <ListItemText primary={m.metricName} />
        </ListItemButton>
      </Box>
    );
  };

  const itemCount =
    total !== undefined ? total : metrics.length + (cursor ? 1 : 0);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setContainerHeight(e.contentRect.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const { start, stop } = visibleRangeRef.current;
    const slice = metrics.slice(start, Math.min(stop + 1, metrics.length));
    const hasLoading = slice.some((m) => statuses[m.metricName] === undefined);
    if (!hasLoading) return;
    const id = window.setInterval(() => {
      fetchStatuses(slice.map((m) => m.metricName));
    }, 2000);
    return () => window.clearInterval(id);
  }, [metrics, statuses, fetchStatuses]);

  return (
    <Box
      sx={{
        borderRight: 1,
        borderColor: "divider",
        height: "100%",
        position: "relative",
      }}
      ref={containerRef}
    >
      {containerHeight > 0 && (
        <VList
          height={Math.max(0, containerHeight - FOOTER_HEIGHT)}
          width={340}
          itemCount={itemCount}
          itemSize={ITEM_HEIGHT}
          ref={listRef}
          overscanCount={10}
          onItemsRendered={({ visibleStopIndex, visibleStartIndex }: any) =>
            handleItemsRendered({ visibleStopIndex, visibleStartIndex })
          }
        >
          {({ index, style }: any) => <Row index={index} style={style} />}
        </VList>
      )}
      <Box
        sx={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          height: FOOTER_HEIGHT,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          px: 1,
          borderTop: 1,
          borderColor: "divider",
          bgcolor: "background.paper",
          fontSize: 12,
          color: "text.secondary",
        }}
      >
        <span>Total metrics: {total ?? (device ? "…" : 0)}</span>
        <span>Loaded: {metrics.length}</span>
      </Box>
    </Box>
  );
};
export default MetricsPane;
