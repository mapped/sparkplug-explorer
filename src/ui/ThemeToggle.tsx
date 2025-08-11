import React from "react";
import { IconButton } from "@mui/material";
import Brightness4Icon from "@mui/icons-material/Brightness4";
import Brightness7Icon from "@mui/icons-material/Brightness7";

const ThemeToggle: React.FC<{ dark: boolean; setDark(v: boolean): void }> = ({
  dark,
  setDark,
}) => (
  <IconButton size="small" onClick={() => setDark(!dark)} title="Toggle theme">
    {dark ? (
      <Brightness7Icon fontSize="small" />
    ) : (
      <Brightness4Icon fontSize="small" />
    )}
  </IconButton>
);
export default ThemeToggle;
