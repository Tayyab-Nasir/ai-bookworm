import net from "node:net";
import { performance } from "node:perf_hooks";
import tls from "node:tls";
import { domainToASCII } from "node:url";

const MAX_URL_BYTES = 8_192;
const MAX_CREDENTIAL_BYTES = 1_024;
const MAX_RESPONSE_BYTES = 4_096;

export interface RedisReadinessEndpoint {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  authenticate: boolean;
  database: number | null;
}

// Never substitute another endpoint for invalid configuration. Userinfo is
// decoded once and transmitted as RESP bulk strings, not inline commands.
export function parseRedisReadinessEndpoint(value: string): RedisReadinessEndpoint | null {
  try {
    if (Buffer.byteLength(value) > MAX_URL_BYTES || /[\u0000-\u0020\u007f?#]/.test(value) || value.trim() !== value) return null;
    // Validate the literal database path before WHATWG URL can normalize dot
    // segments (including encoded dots) into a different, valid-looking DB.
    const literal = /^rediss?:\/\/([^/]+)(\/.*)?$/i.exec(value);
    if (!literal) return null;
    const rawPath = literal[2] ?? "";
    if (rawPath && rawPath !== "/" && !/^\/(0|[1-9]\d{0,9})$/.test(rawPath)) return null;
    const url = new URL(value);
    if (url.protocol !== "redis:" && url.protocol !== "rediss:") return null;
    let host = url.hostname;
    if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
    if (!net.isIP(host)) host = domainToASCII(host);
    if (!host || host.length > 253 || /[\s\[\]\\/@?#]/.test(host)) return null;
    const port = url.port ? Number(url.port) : 6379;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
    const username = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    if (Buffer.byteLength(username) > MAX_CREDENTIAL_BYTES || Buffer.byteLength(password) > MAX_CREDENTIAL_BYTES) return null;
    const authority = literal[1];
    const authenticate = authority.includes("@");
    let database: number | null = null;
    if (rawPath && rawPath !== "/") {
      database = Number(rawPath.slice(1));
      if (database > 2_147_483_647) return null;
    }
    return { host, port, secure: url.protocol === "rediss:", username, password, authenticate, database };
  } catch {
    return null;
  }
}

function command(parts: string[]): Buffer {
  const fields = [Buffer.from(`*${parts.length}\r\n`)];
  for (const part of parts) {
    const bytes = Buffer.from(part, "utf8");
    fields.push(Buffer.from(`$${bytes.length}\r\n`), bytes, Buffer.from("\r\n"));
  }
  return Buffer.concat(fields);
}

// A fresh, bounded connection probes protocol/auth/database access. It never
// runs customer commands, logs a URL/error, relaxes TLS checks, or reconnects.
export function redisReady(value: string, timeoutMs = 1_000): Promise<boolean> {
  const endpoint = parseRedisReadinessEndpoint(value);
  if (!endpoint || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) return Promise.resolve(false);
  return new Promise((resolve) => {
    const expiresAt = performance.now() + timeoutMs;
    let socket: net.Socket | undefined;
    let settled = false;
    let received = 0;
    let response = Buffer.alloc(0);
    let step = 0;
    const exchanges: { request: Buffer; expected: string }[] = [];
    if (endpoint.authenticate) {
      exchanges.push({ request: command(endpoint.username ? ["AUTH", endpoint.username, endpoint.password] : ["AUTH", endpoint.password]), expected: "+OK" });
    }
    if (endpoint.database !== null) exchanges.push({ request: command(["SELECT", String(endpoint.database)]), expected: "+OK" });
    exchanges.push({ request: command(["PING"]), expected: "+PONG" });
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket?.destroy();
      resolve(ready && performance.now() < expiresAt);
    };
    // Absolute deadline includes DNS, TLS, AUTH, SELECT and fragmented replies;
    // receiving bytes does not reset it and a trickle cannot hold it open.
    const deadline = setTimeout(() => finish(false), timeoutMs);
    try {
      socket = endpoint.secure
        ? tls.connect({ host: endpoint.host, port: endpoint.port, servername: net.isIP(endpoint.host) ? undefined : endpoint.host, rejectUnauthorized: true, minVersion: "TLSv1.2" })
        : net.connect({ host: endpoint.host, port: endpoint.port });
      socket.once(endpoint.secure ? "secureConnect" : "connect", () => {
        if (settled) return;
        if (performance.now() >= expiresAt) { finish(false); return; }
        if (endpoint.secure && !(socket as tls.TLSSocket).authorized) { finish(false); return; }
        socket!.write(exchanges[step].request);
      });
      socket.on("data", (chunk: Buffer) => {
        if (settled) return;
        if (performance.now() >= expiresAt) { finish(false); return; }
        received += chunk.length;
        if (received > MAX_RESPONSE_BYTES) { finish(false); return; }
        response = Buffer.concat([response, chunk]);
        const end = response.indexOf("\r\n");
        if (end < 0) return;
        // A command has exactly one simple-string response. Reject errors,
        // other RESP types, trailing/unsolicited replies and malformed frames.
        if (end + 2 !== response.length || response.subarray(0, end).toString("utf8") !== exchanges[step].expected) { finish(false); return; }
        response = Buffer.alloc(0);
        step++;
        if (step === exchanges.length) { finish(true); return; }
        socket!.write(exchanges[step].request);
      });
      socket.once("error", () => finish(false));
      socket.once("end", () => finish(false));
      socket.once("close", () => finish(false));
    } catch {
      finish(false);
    }
  });
}
