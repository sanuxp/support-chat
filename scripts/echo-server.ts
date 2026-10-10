// Tiny local webhook receiver for testing the `webhook` tool handler.
//   standalone:  npx tsx scripts/echo-server.ts   (listens on :4010, prints each request, replies with a fake ticket)
//   in tests:    import { startEchoServer } and inspect `received`
// Point a tool's options.url at http://host.docker.internal:4010/tickets (the backend runs in Docker).
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { loadEnv } from "./env.js";

export interface EchoRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
  body: any;
  signatureValid: boolean;
}

export function startEchoServer(secret: string, port = 4010, reply: unknown = { ticket_id: "TCK-ECHO-0001", status: "created" }) {
  const received: EchoRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
      const got = String(req.headers["x-supportchat-signature"] ?? "");
      const signatureValid = got.length === expected.length && timingSafeEqual(Buffer.from(got), Buffer.from(expected));
      let body: any = null;
      try { body = JSON.parse(rawBody); } catch { /* not JSON */ }
      received.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, rawBody, body, signatureValid });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  });
  return new Promise<{ received: EchoRequest[]; close: () => Promise<void> }>((resolve) => {
    server.listen(port, "0.0.0.0", () =>
      resolve({ received, close: () => new Promise((r) => server.close(() => r())) }));
  });
}

if (process.argv[1]?.endsWith("echo-server.ts")) {
  const secret = (await loadEnv()).WEBHOOK_SIGNING_SECRET ?? "";
  const { received } = await startEchoServer(secret);
  console.log("echo server on :4010 — waiting for webhook calls");
  setInterval(() => {
    while (received.length) {
      const r = received.shift()!;
      console.log(`${r.method} ${r.url} signatureValid=${r.signatureValid}\n${JSON.stringify(r.body, null, 2)}`);
    }
  }, 500);
}
