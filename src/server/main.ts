/// <reference types="node" />
// The game server: one authoritative match, and the game's own pages.
//
//   npm run server -- [--port 8080] [--level s-standard] [--teams 2] [--ctf] [--bots 3] [--score 15] [--minutes 10]
//
// It serves the built client (dist/) over HTTP and takes WebSocket
// connections on the same port, so players only need its address:
// http://<this machine>:8080. Anyone in the match can start another level
// from the Multiplayer menu.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { DT, LEVELS, levelById, type GameSetup } from '../sim';
import { Room } from '../net/room';

const args = process.argv.slice(2);
const opt = (name: string, fallback?: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] ?? '' : fallback; };
const flag = (name: string) => args.includes(`--${name}`);
const port = Number(opt('port', process.env.PORT ?? '8080'));
const def = levelById(opt('level', 's-standard')!) ?? levelById('s-standard')!;
if (flag('levels')) { for (const l of LEVELS.filter((x) => x.mode === 'sandbox')) console.log(l.id.padEnd(16), l.name); process.exit(0); }
const teams = flag('ctf') ? Math.max(2, Number(opt('teams', '2'))) : Number(opt('teams', '0'));
const nBots = opt('bots') !== undefined ? Number(opt('bots')) : undefined;
const setup: GameSetup = {
  teams, ctf: flag('ctf'), bases: true,
  scoreLimit: Number(opt('score', flag('ctf') ? '3' : '15')),
  timeLimit: Number(opt('minutes', '0')) * 60,
  ...(nBots !== undefined ? { bots: teams >= 2 ? Array.from({ length: teams }, (_, t) => Math.floor(nBots / teams) + (t < nBots % teams ? 1 : 0)) : [nBots] } : {}),
};

const stamp = () => new Date().toISOString().slice(11, 19);
const room = new Room({ def, setup }, { log: (text) => console.log(`[${stamp()}] ${text}`) });

// ---- the pages
const root = resolve(process.cwd(), 'dist');
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.map': 'application/json' };
const http = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
    if (path === '/status') {
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify({ level: room.spec.def.name, players: [...room.clients.values()].filter((c) => c.playerId >= 0).map((c) => c.name || 'Player'), bots: room.botIds.length, tick: room.state.tick }));
      return;
    }
    const file = normalize(join(root, path === '/' ? 'index.html' : path));
    if (!file.startsWith(root) || !existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(await readFile(file));
  } catch { res.writeHead(500); res.end('error'); }
});

// ---- the players (compression on: one snapshot is much like the last, and the socket's deflate remembers)
const wss = new WebSocketServer({ server: http, perMessageDeflate: { zlibDeflateOptions: { level: 3 }, threshold: 256 }, maxPayload: 1 << 20 });
wss.on('connection', (ws) => {
  ws.binaryType = 'nodebuffer';
  const id = room.connect((bytes) => { if (ws.readyState === ws.OPEN && ws.bufferedAmount < 4_000_000) ws.send(bytes, { binary: true }); });
  ws.on('message', (data) => {
    const buf = data as Buffer;
    room.receive(id, new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  });
  ws.on('close', () => room.disconnect(id));
  ws.on('error', () => room.disconnect(id));
});

// ---- the clock: the sim's fixed step, caught up if the timer runs late (but never a spiral)
const stepMs = 1000 * DT;
let next = performance.now();
setInterval(() => {
  const now = performance.now();
  let n = 0;
  while (next <= now && n < 24) { room.tick(); next += stepMs; n++; }
  if (n === 24) next = now; // fell badly behind: let it go
}, 4);

http.listen(port, () => {
  console.log(`Combat Revolves server: ${def.name}${teams >= 2 ? ` · ${teams} teams${setup.ctf ? ' · capture the flag' : ''}` : ''}`);
  console.log(`  play at  http://localhost:${port}/  (other machines: this one's address, port ${port})`);
  if (!existsSync(join(root, 'index.html'))) console.log('  (no dist/ yet: run "npm run build" first to serve the game from here)');
});
