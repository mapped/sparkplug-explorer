import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  Box,
  TextField,
  Paper,
  List,
  ListItemButton,
  ListItemText,
  Typography,
  Chip,
} from "@mui/material";
import ClickAwayListener from "@mui/material/ClickAwayListener";
import { SearchResult } from "./App";
import { keyframes } from "@emotion/react";

interface Props {
  onSelect(r: SearchResult): void;
  open: boolean;
  setOpen(v: boolean): void;
}
const DEBOUNCE_MS = 150;

const pulse = keyframes`
  0% { transform: scale(.6); opacity: .4; }
  50% { transform: scale(1); opacity: 1; }
  100% { transform: scale(.6); opacity: .4; }
`;

const SearchBar: React.FC<Props> = ({ onSelect, open, setOpen }) => {
  const [value, setValue] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [deviceStatuses, setDeviceStatuses] = useState<Record<string, string>>(
    {}
  );
  const [metricStatuses, setMetricStatuses] = useState<Record<string, string>>(
    {}
  );
  const [stableDeviceStatuses, setStableDeviceStatuses] = useState<
    Record<string, string>
  >({});
  const [stableMetricStatuses, setStableMetricStatuses] = useState<
    Record<string, string>
  >({});
  const timer = useRef<number | undefined>();
  const suppressNextSearch = useRef(false); // suppress debounce after programmatic selection
  const statusTimer = useRef<number | undefined>();

  const fetchStatuses = useCallback(() => {
    const deviceNames = Array.from(
      new Set(
        results.filter((r) => r.type === "device").map((r) => r.deviceName)
      )
    );
    if (deviceNames.length) {
      fetch(
        `/api/devices/status?devices=${encodeURIComponent(
          deviceNames.join(",")
        )}`
      )
        .then((r) => r.json())
        .then((data) => {
          setDeviceStatuses((prev) => {
            const next = { ...prev } as Record<string, string>;
            (data.statuses || []).forEach((s: any) => {
              if (s.status === "grey") return; // keep loading
              next[s.name] = s.status;
            });
            return next;
          });
          setStableDeviceStatuses((prev) => {
            const next = { ...prev };
            (data.statuses || []).forEach((s: any) => {
              if (s.status === "grey") return;
              if (!prev[s.name]) next[s.name] = s.status;
            });
            return next;
          });
        })
        .catch(() => {});
    }
    const metricGroups: Record<string, string[]> = {};
    for (const r of results)
      if (r.type === "metric") {
        metricGroups[r.deviceName] = metricGroups[r.deviceName] || [];
        metricGroups[r.deviceName].push(r.metricName);
      }
    Object.entries(metricGroups).forEach(([dev, metrics]) => {
      fetch(
        `/api/devices/${encodeURIComponent(
          dev
        )}/metrics/status?metrics=${encodeURIComponent(metrics.join(","))}`
      )
        .then((r) => r.json())
        .then((data) => {
          setMetricStatuses((prev) => {
            const next = { ...prev } as Record<string, string>;
            (data.statuses || []).forEach((s: any) => {
              if (s.status === "grey") return;
              next[dev + "::" + s.name] = s.status;
            });
            return next;
          });
          setStableMetricStatuses((prev) => {
            const next = { ...prev };
            (data.statuses || []).forEach((s: any) => {
              if (s.status === "grey") return;
              const key = dev + "::" + s.name;
              if (!prev[key]) next[key] = s.status;
            });
            return next;
          });
        })
        .catch(() => {});
    });
  }, [results]);

  useEffect(() => {
    if (!open || !results.length) return;
    if (statusTimer.current) window.clearTimeout(statusTimer.current);
    statusTimer.current = window.setTimeout(fetchStatuses, 120);
  }, [open, results, fetchStatuses]);

  useEffect(() => {
    if (!open || !results.length) return;
    const id = window.setInterval(() => {
      // Only refetch if any item still loading
      const hasLoading = results.some((r) => {
        if (r.type === "device")
          return deviceStatuses[r.deviceName] === undefined;
        if (r.type === "metric")
          return (
            metricStatuses[r.deviceName + "::" + r.metricName] === undefined
          );
        return false;
      });
      if (hasLoading) fetchStatuses();
    }, 3000);
    return () => window.clearInterval(id);
  }, [open, results, deviceStatuses, metricStatuses, fetchStatuses]);

  const performSearch = useCallback(
    async (q: string) => {
      const trimmed = q.trim();
      if (trimmed.length === 0) {
        setResults([]);
        setOpen(false);
        return;
      }
      const r = await fetch(
        `/api/search?q=${encodeURIComponent(trimmed)}&limit=25`
      ).then((r) => r.json());
      setResults(r.results || []);
      setOpen(true);
    },
    [setOpen]
  );

  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      if (suppressNextSearch.current) {
        suppressNextSearch.current = false; // skip one cycle
        return; // do not perform search or reopen panel
      }
      void performSearch(value);
    }, DEBOUNCE_MS);
  }, [value, performSearch]);

  function displayLabel(r: SearchResult): string {
    return r.type === "device" ? r.deviceName : r.metricName;
  }
  function handleSelect(r: SearchResult) {
    suppressNextSearch.current = true; // prevent immediate re-query
    setValue(""); // clear input after selection
    setResults([]); // clear suggestions
    onSelect(r);
    setOpen(false);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <ClickAwayListener onClickAway={() => setOpen(false)}>
      <Box sx={{ position: "relative", flex: 1 }} onKeyDown={handleKeyDown}>
        <TextField
          size="small"
          fullWidth
          placeholder="Search devices or metrics"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={() => {
            if (results.length > 0) setOpen(true);
          }}
        />
        {open && results.length > 0 && (
          <Paper
            elevation={3}
            sx={{
              position: "absolute",
              top: "100%",
              left: 0,
              right: 0,
              zIndex: 10,
              maxHeight: 240,
              overflowY: "auto",
              mt: 0.5,
              p: 0.5,
            }}
          >
            <List dense disablePadding>
              {results.map((r, i) => (
                <ListItemButton
                  key={i}
                  dense
                  sx={{ py: 0.5, minHeight: 32 }}
                  onClick={() => handleSelect(r)}
                >
                  <ListItemText
                    primary={
                      <Box
                        sx={{
                          display: "flex",
                          alignItems: "center",
                          gap: 1,
                        }}
                      >
                        <Chip
                          size="small"
                          label={r.type === "device" ? "D" : "M"}
                          color={r.type === "device" ? "primary" : "secondary"}
                        />
                        <Box
                          sx={{
                            width: 10,
                            height: 10,
                            borderRadius: "50%",
                            bgcolor: (() => {
                              const stKey =
                                r.type === "device"
                                  ? r.deviceName
                                  : r.deviceName + "::" + r.metricName;
                              const live =
                                r.type === "device"
                                  ? deviceStatuses[r.deviceName]
                                  : metricStatuses[stKey];
                              const stable =
                                r.type === "device"
                                  ? stableDeviceStatuses[r.deviceName]
                                  : stableMetricStatuses[stKey];
                              const effective = live || stable; // prefer latest non-loading
                              const loading = !effective;
                              return !loading && effective === "green"
                                ? "success.main"
                                : !loading && effective === "yellow"
                                ? "warning.main"
                                : !loading && effective === "red"
                                ? "error.main"
                                : "info.main";
                            })(),
                            flexShrink: 0,
                            ...(() => {
                              const stKey =
                                r.type === "device"
                                  ? r.deviceName
                                  : r.deviceName + "::" + r.metricName;
                              const live =
                                r.type === "device"
                                  ? deviceStatuses[r.deviceName]
                                  : metricStatuses[stKey];
                              const stable =
                                r.type === "device"
                                  ? stableDeviceStatuses[r.deviceName]
                                  : stableMetricStatuses[stKey];
                              const effective = live || stable;
                              if (effective) return {};
                              return {
                                animation: `${pulse} 1.2s ease-in-out infinite`,
                                boxShadow: (theme: any) =>
                                  `0 0 4px 2px ${theme.palette.info.light}`,
                              };
                            })(),
                          }}
                        />
                        <Typography variant="body2">
                          {r.type === "device"
                            ? r.deviceName
                            : `${r.metricName}`}
                        </Typography>
                        {r.type === "metric" && (
                          <Typography variant="caption" color="text.secondary">
                            {r.deviceName}
                          </Typography>
                        )}
                      </Box>
                    }
                  />
                </ListItemButton>
              ))}
            </List>
          </Paper>
        )}
      </Box>
    </ClickAwayListener>
  );
};
export default SearchBar;
