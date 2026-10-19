// T3 PoC front proxy on :8080 (the only port the MicroVM endpoint exposes).
//   /healthz, /ide/*  -> code-server on 127.0.0.1:8081 (prefix /ide stripped)
//   everything else   -> t3 serve on 127.0.0.1:3773
// T3's web UI uses absolute asset paths, so it cannot live under a sub-path.
const http = require('node:http');
const net = require('node:net');

const IDE = { host: '127.0.0.1', port: 8081 };
const T3 = { host: '127.0.0.1', port: 3773 };

function route(url) {
  if (url === '/healthz') return { target: IDE, path: url };
  if (url === '/ide') return { redirect: '/ide/' };
  if (url.startsWith('/ide/')) return { target: IDE, path: url.slice(4) };
  return { target: T3, path: url };
}

function forward(req, res) {
  const r = route(req.url);
  if (r.redirect) {
    res.writeHead(302, { location: r.redirect });
    return res.end();
  }
  const up = http.request({ ...r.target, path: r.path, method: req.method, headers: req.headers }, (u) => {
    res.writeHead(u.statusCode, u.headers);
    u.pipe(res);
  });
  up.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(up);
}

function upgrade(req, socket, head) {
  const r = route(req.url);
  if (r.redirect) return socket.destroy();
  const up = net.connect(r.target.port, r.target.host, () => {
    const lines = [`${req.method} ${r.path} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    up.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head?.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
}

module.exports = { route };

if (require.main === module) {
  const server = http.createServer(forward);
  server.on('upgrade', upgrade);
  server.listen(Number(process.env.FRONT_PORT ?? 8080), process.env.FRONT_HOST ?? '0.0.0.0');
}
