// Moved from web/src/ui/App.tsx
import React, { useEffect, useMemo, useState } from "react";
import {
  ThemeProvider,
  createTheme,
  CssBaseline,
  Box,
  useMediaQuery,
  Breadcrumbs,
  Link,
  Typography,
} from "@mui/material";
import { lightBlue, blueGrey } from "@mui/material/colors";
import SearchBar from "./SearchBar";
import DevicesPane from "./DevicesPane";
import MetricsPane from "./MetricsPane";
import MetricDetailPane from "./MetricDetailPane";
import ThemeToggle from "./ThemeToggle";

interface SearchResultDevice {
  type: "device";
  deviceName: string;
}
interface SearchResultMetric {
  type: "metric";
  deviceName: string;
  metricName: string;
}
export type SearchResult = SearchResultDevice | SearchResultMetric;

const LS_KEY = "sparkplug_ui_state_v1";
interface PersistedState {
  device?: string;
  metric?: string;
  dark?: boolean;
}
function loadState(): PersistedState {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || "{}");
  } catch {
    return {};
  }
}
function saveState(s: PersistedState) {
  localStorage.setItem(LS_KEY, JSON.stringify(s));
}

const App: React.FC = () => {
  const stored = useMemo(loadState, []);
  // Parse URL params for device & metric (override stored)
  const urlParams = new URLSearchParams(window.location.search);
  const urlDevice = urlParams.get("device") || undefined;
  const urlMetric = urlParams.get("metric") || undefined;

  const prefersDark = useMediaQuery("(prefers-color-scheme: dark)");
  const [dark, setDark] = useState(stored.dark ?? prefersDark);
  const [selectedDevice, setSelectedDevice] = useState<string | undefined>(
    urlDevice ?? stored.device
  );
  const [selectedMetric, setSelectedMetric] = useState<string | undefined>(
    urlMetric ?? stored.metric
  );
  const [searchOpen, setSearchOpen] = useState(false);
  const [metricsReloadSeq, setMetricsReloadSeq] = useState(0);

  useEffect(() => {
    saveState({ device: selectedDevice, metric: selectedMetric, dark });
    const params = new URLSearchParams(window.location.search);
    if (selectedDevice) params.set("device", selectedDevice);
    else params.delete("device");
    if (selectedMetric) params.set("metric", selectedMetric);
    else params.delete("metric");
    const newQs = params.toString();
    const newUrl = `${window.location.pathname}${newQs ? "?" + newQs : ""}${
      window.location.hash
    }`;
    if (newUrl !== window.location.href.replace(window.location.origin, "")) {
      window.history.replaceState(null, "", newUrl);
    }
  }, [selectedDevice, selectedMetric, dark]);

  const theme = useMemo(
    () =>
      createTheme({
        palette: {
          mode: dark ? "dark" : "light",
          primary: lightBlue,
          secondary: blueGrey,
        },
      }),
    [dark]
  );

  const handleSearchSelect = (r: SearchResult) => {
    if (r.type === "device") {
      setSelectedDevice(r.deviceName);
      setSelectedMetric(undefined);
    } else {
      setSelectedDevice(r.deviceName);
      setSelectedMetric(r.metricName);
    }
    setSearchOpen(false);
  };

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box sx={{ display: "flex", flexDirection: "column", height: "100vh" }}>
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            p: 1,
            gap: 1,
            borderBottom: 1,
            borderColor: "divider",
          }}
        >
          <SearchBar
            onSelect={handleSearchSelect}
            open={searchOpen}
            setOpen={setSearchOpen}
          />
          <ThemeToggle dark={dark} setDark={setDark} />
        </Box>
        {(selectedDevice || selectedMetric) && (
          <Box
            sx={{
              px: 2,
              py: 0.5,
              borderBottom: 1,
              borderColor: "divider",
              bgcolor: "background.paper",
            }}
          >
            <Breadcrumbs
              maxItems={4}
              aria-label="breadcrumb"
              separator=">"
              sx={{ fontSize: 13 }}
            >
              <Link
                underline="hover"
                color="inherit"
                component="button"
                onClick={() => {
                  setSelectedDevice(undefined);
                  setSelectedMetric(undefined);
                }}
              >
                Home
              </Link>
              {selectedDevice && (
                <Link
                  underline="hover"
                  color="inherit"
                  component="button"
                  onClick={() => setSelectedMetric(undefined)}
                >
                  {selectedDevice}
                </Link>
              )}
              {selectedMetric && (
                <Typography color="text.primary">{selectedMetric}</Typography>
              )}
            </Breadcrumbs>
          </Box>
        )}
        <Box
          sx={{
            flex: 1,
            display: "grid",
            gridTemplateColumns: "280px 340px 1fr",
            minHeight: 0,
          }}
        >
          <DevicesPane
            selectedDevice={selectedDevice}
            onSelect={(d) => {
              setSelectedDevice(d);
              setSelectedMetric(undefined);
              setMetricsReloadSeq((s) => s + 1); // force metrics refresh
            }}
          />
          <MetricsPane
            device={selectedDevice}
            selectedMetric={selectedMetric}
            reloadSeq={metricsReloadSeq}
            onSelect={(m) => setSelectedMetric(m)}
          />
          <MetricDetailPane device={selectedDevice} metric={selectedMetric} />
        </Box>
      </Box>
    </ThemeProvider>
  );
};
export default App;
