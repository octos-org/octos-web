import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { initTheme } from "./hooks/use-theme";

// Apply the stored/system theme to <html> before React mounts so every
// route — including galleries that render no component calling useTheme —
// honors the saved preference and avoids a dark-to-light first-paint flash.
initTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
