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

// react-window types sometimes conflict with React 18 in strict settings; alias to generic component type
const VList: React.ComponentType<any> = FixedSizeList as any;

interface Device {
  deviceName: string;
  topic: string;
  birthTimestamp?: string | null;
}
interface Props {
  selectedDevice?: string;
  onSelect(d: string): void;
}

interface DeviceStatusMap {
  [name: string]: "green" | "yellow" | "red" | undefined;
}

const PAGE_SIZE = 500; // large chunk for fewer round trips
const ITEM_HEIGHT = 48;
const PREFETCH_THRESHOLD = 50; // when within last N loaded rows, fetch next page

const pulse = keyframes`
  0% { transform: scale(.6); opacity: .4; }
  50% { transform: scale(1); opacity: 1; }
  100% { transform: scale(.6); opacity: .4; }
`;

const DevicesPane: React.FC<Props> = ({ selectedDevice, onSelect }) => {
  const [devices, setDevices] = useState<Device[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState<number | undefined>();
  const [statuses, setStatuses] = useState<DeviceStatusMap>({});
  const pendingStatusFetch = useRef<number | null>(null);
  const visibleRangeRef = useRef<{ start: number; stop: number }>({
    start: 0,
    stop: 0,
  });
  const listRef = useRef<any>(null); // react-window list ref
  const fetchingRef = useRef(false);
  const prevSelectedRef = useRef<string | undefined>();
  const targetIndexRef = useRef<number | undefined>();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerHeight, setContainerHeight] = useState<number>(0);

  const fetchTotal = useCallback(async () => {
    if (total !== undefined) return;
    const r = await fetch("/api/devices/count").then((r) => r.json());
    setTotal(r.count);
  }, [total]);

  const loadMore = useCallback(async () => {
    if (loading || fetchingRef.current) return;
    if (
      cursor === undefined &&
      devices.length &&
      total !== undefined &&
      devices.length >= total
    )
      return;
    fetchingRef.current = true;
    setLoading(true);
    const params = new URLSearchParams();
    params.set("limit", String(PAGE_SIZE));
    if (cursor) params.set("cursor", cursor);
    const r = await fetch(`/api/devices?${params.toString()}`).then((r) =>
      r.json()
    );
    setDevices((prev) => [...prev, ...r.items]);
    if (r.nextCursor) setCursor(r.nextCursor);
    else setCursor(undefined);
    setLoading(false);
    fetchingRef.current = false;
  }, [cursor, loading, devices.length, total]);

  useEffect(() => {
    void fetchTotal();
  }, [fetchTotal]);
  useEffect(() => {
    if (devices.length === 0) void loadMore();
  }, [devices.length, loadMore]);
  useEffect(() => {
    if (!selectedDevice) return;
    const localIdx = devices.findIndex((d) => d.deviceName === selectedDevice);
    if (localIdx >= 0) {
      if (prevSelectedRef.current !== selectedDevice && listRef.current) {
        listRef.current.scrollToItem(localIdx, "smart");
      }
      prevSelectedRef.current = selectedDevice;
      targetIndexRef.current = undefined;
      return;
    }
    // Not yet loaded; fetch index and begin loading pages until we reach it
    (async () => {
      try {
        const r = await fetch(
          `/api/devices/index?device=${encodeURIComponent(selectedDevice)}`
        ).then((res) => res.json());
        if (typeof r.index === "number") {
          targetIndexRef.current = r.index;
          // Trigger incremental loading if we still have a cursor
          if (cursor && !fetchingRef.current) void loadMore();
        }
      } catch {
        /* ignore */
      }
    })();
  }, [selectedDevice, devices, cursor, loadMore]);

  // When devices array grows, check if we have reached target index to scroll
  useEffect(() => {
    if (targetIndexRef.current === undefined) return;
    if (devices.length > targetIndexRef.current) {
      if (listRef.current)
        listRef.current.scrollToItem(targetIndexRef.current, "start");
      targetIndexRef.current = undefined;
    } else if (cursor && !fetchingRef.current) {
      // Need more pages
      void loadMore();
    }
  }, [devices.length, cursor, loadMore]);

  const fetchStatuses = useCallback(
    (names: string[]) => {
      const uniq = Array.from(new Set(names.filter((n) => !!n)));
      if (!uniq.length) return;
      fetch(`/api/devices/status?devices=${encodeURIComponent(uniq.join(","))}`)
        .then((r) => r.json())
        .then((data) => {
          const next: DeviceStatusMap = { ...statuses };
          (data.statuses || []).forEach((s: any) => {
            // Treat 'grey' as not yet loaded (leave undefined) so UI shows loading glow
            if (s.status === "grey") return;
            next[s.name] = s.status;
          });
          setStatuses(next);
        })
        .catch(() => {});
    },
    [statuses]
  );

  const scheduleStatusFetch = useCallback(() => {
    if (pendingStatusFetch.current)
      window.clearTimeout(pendingStatusFetch.current);
    pendingStatusFetch.current = window.setTimeout(() => {
      const { start, stop } = visibleRangeRef.current;
      const slice = devices.slice(start, Math.min(stop + 1, devices.length));
      fetchStatuses(slice.map((d) => d.deviceName));
    }, 150);
  }, [devices, fetchStatuses]);

  const handleItemsRendered = ({
    visibleStopIndex,
    visibleStartIndex,
  }: {
    visibleStopIndex: number;
    visibleStartIndex: number;
  }) => {
    visibleRangeRef.current = {
      start: visibleStartIndex,
      stop: visibleStopIndex,
    };
    scheduleStatusFetch();
    if (
      cursor &&
      devices.length > 0 &&
      visibleStopIndex >= devices.length - PREFETCH_THRESHOLD &&
      !fetchingRef.current
    ) {
      void loadMore();
    }
  };

  const Row = ({
    index,
    style,
  }: {
    index: number;
    style: React.CSSProperties;
  }) => {
    if (index >= devices.length) {
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
    const d = devices[index];
    const status = statuses[d.deviceName];
    const loading = status === undefined; // grey treated as undefined/loading
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
          selected={d.deviceName === selectedDevice}
          onClick={() => onSelect(d.deviceName)}
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
          <ListItemText
            primary={d.deviceName}
            secondary={
              d.birthTimestamp
                ? new Date(d.birthTimestamp).toLocaleString()
                : ""
            }
          />
        </ListItemButton>
      </Box>
    );
  };

  const itemCount =
    total !== undefined ? total : devices.length + (cursor ? 1 : 0);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        setContainerHeight(e.contentRect.height);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    // Periodic refetch while any visible item is still loading
    const { start, stop } = visibleRangeRef.current;
    const slice = devices.slice(start, Math.min(stop + 1, devices.length));
    const hasLoading = slice.some((d) => statuses[d.deviceName] === undefined);
    if (!hasLoading) return;
    const id = window.setInterval(() => {
      fetchStatuses(slice.map((d) => d.deviceName));
    }, 3000);
    return () => window.clearInterval(id);
  }, [devices, statuses, fetchStatuses]);

  return (
    <Box
      ref={containerRef}
      sx={{
        borderRight: 1,
        borderColor: "divider",
        height: "100%",
        position: "relative",
        minHeight: 0,
      }}
    >
      {containerHeight > 0 && (
        <VList
          height={containerHeight}
          width={280}
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
    </Box>
  );
};
export default DevicesPane;
