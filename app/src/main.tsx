import "./polyfills";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { inject } from "@vercel/analytics";

// pageviews + the two funnel events (connect, tx) — the only way to know whether a tweet turned into a trade
inject();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
