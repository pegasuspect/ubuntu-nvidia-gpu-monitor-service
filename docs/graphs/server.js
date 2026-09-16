// Minimal static file server for the graph viewer; falls back to the next
// port automatically if the current one is already in use.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..'); // serve docs/
const MIN_PORT = 3000;
const MAX_PORT = 3020;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serve(port) {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    let filePath = path.normalize(path.join(ROOT, urlPath));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    if (urlPath === '/' || path.extname(filePath) === '') {
      filePath = path.join(ROOT, 'index.html');
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Not found');
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
      res.end(data);
    });
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && port < MAX_PORT) {
      serve(port + 1);
    } else {
      console.error(`error: no free port between ${MIN_PORT} and ${MAX_PORT}`);
      process.exit(1);
    }
  });

  server.listen(port, () => {
    console.log(`Graph viewer running at http://localhost:${port}`);
  });
}

serve(MIN_PORT);