import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import "./styles.css";

// Startup animation: the splash sits in index.html (so it paints before any
// JS loads), three stones stack, then it fades. Removed from the DOM here.
const splash = document.getElementById("splash");
if (splash) {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.setTimeout(() => {
    splash.classList.add("splash-out");
    window.setTimeout(() => splash.remove(), 600);
  }, reduced ? 150 : 1750);
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
