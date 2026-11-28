/** Byte-transparent host loopback access to an already-verified owned container. */
import assert from 'node:assert/strict';
import { createConnection, createServer, isIP } from 'node:net';

export async function loopbackRelay(host, port) {
  assert.equal(isIP(host), 4, 'Relay target must be a literal IPv4 address');
  assert.match(host, /^(?:127\.0\.0\.1$|10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)/);
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
  const sockets = new Set();
  const server = createServer({ allowHalfOpen: true }, incoming => {
    const outgoing = createConnection({ host, port, allowHalfOpen: true });
    const destroy = () => { incoming.destroy(); outgoing.destroy(); };
    for (const socket of [incoming, outgoing]) {
      sockets.add(socket);
      socket.setTimeout(70_000, destroy);
      socket.on('error', destroy);
      socket.once('close', () => { sockets.delete(socket); destroy(); });
    }
    incoming.pipe(outgoing).pipe(incoming);
  });
  server.maxConnections = 32;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
