import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import "./styles.css";

// Startup animation: the splash sits in index.html (so it paints before any
// JS loads), three stones stack, then it fades. Removed from the DOM here.
const splash = document.getElementById("splash");
if (splash) {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const quotes = [
    "Every stone placed with intent.",
    "Mark the path. Verify each step.",
    "Trust is built one verified run at a time.",
    "Small stones, sure footing.",
    "What is checked is calm.",
    "Stack the evidence. Walk the path.",
  ];
  const q = splash.querySelector(".splash-quote");
  if (q) q.textContent = quotes[Math.floor(Math.random() * quotes.length)] ?? quotes[0]!;
  window.setTimeout(() => {
    splash.classList.add("splash-out");
    window.setTimeout(() => splash.remove(), 450);
  }, reduced ? 100 : 1150);
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
