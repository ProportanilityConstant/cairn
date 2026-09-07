/**
 * Cairn demo target — a deliberately tiny "service" to automate against.
 *
 * Endpoints:
 *   GET /ping         → 200 {"ok":true,"status":"healthy"}      (when not degraded)
 *   GET /orders       → 200 {"orders":[…]}
 *   POST /orders      → 201 {"id":"ord_…","item":…,"qty":…}
 *   GET /chaos        → degrades the service (next /ping fails)
 *   GET /heal         → restores the service
 *   GET /metrics      → counters
 *
 * Deterministic by design: no randomness, no persistence. The /chaos → fail →
 * /heal cycle lets you exercise Cairn's failure intelligence end to end.
 */
import { createServer } from "node:http";

let healthy = true;
let orders = [{ id: "ord_1", item: "widget", qty: 2 }];
let hits = 0;

const server = createServer((req, res) => {
  hits++;
  const url = new URL(req.url, "http://localhost");
  const json = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  if (url.pathname === "/ping") {
    if (!healthy) return json(500, { ok: false, status: "degraded" });
    return json(200, { ok: true, status: "healthy" });
  }
  if (url.pathname === "/orders" && req.method === "GET") {
    if (!healthy) return json(503, { error: "service degraded" });
    return json(200, { orders });
  }
  if (url.pathname === "/orders" && req.method === "POST") {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      try {
        const body = JSON.parse(raw || "{}");
        if (!body.item || typeof body.qty !== "number") return json(400, { error: "item and qty are required" });
        const order = { id: `ord_${orders.length + 1}`, item: String(body.item), qty: body.qty };
        orders.push(order);
        return json(201, order);
      } catch { return json(400, { error: "invalid JSON" }); }
    });
    return;
  }
  if (url.pathname === "/chaos") {
    healthy = false;
    return json(200, { chaos: true, message: "Service degraded. Run your workflow to watch failure intelligence work, then GET /heal." });
  }
  if (url.pathname === "/heal") {
    healthy = true;
    return json(200, { healed: true });
  }
  if (url.pathname === "/metrics") {
    return json(200, { hits, orders: orders.length, healthy });
  }
  json(404, { error: "not found" });
});

const port = parseInt(process.env.PORT ?? "5175", 10);
server.listen(port, "127.0.0.1", () => {
  console.log(`Cairn demo target listening on http://127.0.0.1:${port}`);
  console.log("  GET  /ping    health probe");
  console.log("  GET  /orders  list orders");
  console.log("  POST /orders  create an order");
  console.log("  GET  /chaos   inject a controlled failure");
  console.log("  GET  /heal    recover");
});
