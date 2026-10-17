/* Minimal static server for reviewing the CODEZY site locally. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2];
const port = Number(process.argv[3] || 8321);

const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
};

http
  .createServer((req, res) => {
    let urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath.endsWith('/')) urlPath += 'index.html';
    const file = path.join(root, urlPath);
    if (!file.startsWith(root)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      const type = types[path.extname(file).toLowerCase()] || 'application/octet-stream';
      // byte-range support so <video> seeking works
      const range = req.headers.range;
      if (range && /^bytes=\d*-\d*$/.test(range)) {
        const [s, e] = range.replace('bytes=', '').split('-');
        const start = s ? parseInt(s, 10) : 0;
        const end = e ? parseInt(e, 10) : data.length - 1;
        res.writeHead(206, {
          'Content-Type': type,
          'Content-Range': `bytes ${start}-${end}/${data.length}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
        });
        res.end(data.subarray(start, end + 1));
        return;
      }
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length, 'Accept-Ranges': 'bytes' });
      res.end(data);
    });
  })
  .listen(port, () => console.log('serving ' + root + ' on ' + port));
