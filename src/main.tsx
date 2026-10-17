import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AppMotion } from "./components/app-motion";
import { ErrorBoundary } from "./components/error-boundary";
import { restoreZoom } from "./lib/page-zoom";
import { installReduceTransparency } from "./lib/reduce-transparency";
import "./index.css";

// As early as possible, so the window spends little time translucent or at the wrong size.
installReduceTransparency();
void restoreZoom();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AppMotion>
      <ErrorBoundary label="zMail">
        <App />
      </ErrorBoundary>
    </AppMotion>
  </React.StrictMode>,
);
