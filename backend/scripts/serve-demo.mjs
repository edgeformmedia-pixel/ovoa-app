// Serves the iMessage simulator on its own, with no .env or API keys needed.
//
//   npm run demo            -> http://localhost:4321
//   PORT=5000 npm run demo
//
// Live mode needs the real backend (npm run dev → /imessage); everything else,
// including the voice-over timeline, works from here.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.resolve(here, "..", "public");
const port = Number(process.env.PORT ?? 4321);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const name = url.pathname === "/" ? "imessage.html" : path.basename(url.pathname);
    const file = path.join(pub, name);
    if (!types[path.extname(name)] || !fs.existsSync(file)) {
      res.writeHead(404).end("not found");
      return;
    }
    // Always fresh: the page and clips are edited and rebuilt while this runs.
    res.writeHead(200, { "Content-Type": types[path.extname(name)], "Cache-Control": "no-store" });
    fs.createReadStream(file).pipe(res);
  })
  .listen(port, () => console.log(`OVOA iMessage demo: http://localhost:${port}`));
