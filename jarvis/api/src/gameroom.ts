import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";

// Online play for OVOA's games (2026-09-27).
//
// A game (sites.ts, kind 'game') runs in a sandbox with no network, except one
// address: wss://<its host><its base>/room, which serveSite hands to this room,
// one per game (idFromName(site id)). The room knows nothing about the game:
// it gives each phone a seat, relays what one sends to the others, and keeps
// the last shared state so a phone that reloads or joins late catches up.
// ROOM_SCRIPT (roomscript.ts) is the small helper every game page gets, window.ovoaRoom.
// Rooms are small and capped; a room nobody has used for a week forgets itself.

export const MAX_PLAYERS = 8;
/** One message, as sent: bigger ones are dropped. */
export const MAX_MESSAGE = 16_000;
/** Per phone, per second. */
const MAX_RATE = 30;
const FORGET_AFTER_MS = 7 * 86_400_000;

type Seat = { id: string; seat: number; n: number; t: number };

export class GameRoom extends DurableObject<Env> {
  private seats(): Seat[] {
    return this.ctx.getWebSockets().map((ws) => ws.deserializeAttachment() as Seat).filter(Boolean);
  }

  private players() {
    return this.seats()
      .map(({ id, seat }) => ({ id, seat }))
      .sort((a, b) => a.seat - b.seat);
  }

  private broadcast(message: unknown, except?: WebSocket) {
    const text = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(text);
      } catch {
        // Closing; its close handler tells the rest.
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("A game room takes a WebSocket.", { status: 426 });
    const taken = this.seats();
    if (taken.length >= MAX_PLAYERS) return new Response("This game is full.", { status: 409 });
    let seat = 0;
    while (taken.some((s) => s.seat === seat)) seat++;
    const { 0: client, 1: server } = new WebSocketPair();
    const me: Seat = { id: crypto.randomUUID().slice(0, 8), seat, n: 0, t: 0 };
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(me);
    const state = (await this.ctx.storage.get("state")) ?? null;
    const players = this.players();
    server.send(JSON.stringify({ type: "welcome", you: me.id, seat, players, state }));
    this.broadcast({ type: "players", players }, server);
    await this.ctx.storage.setAlarm(Date.now() + FORGET_AFTER_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== "string" || raw.length > MAX_MESSAGE) return;
    const me = ws.deserializeAttachment() as Seat;
    const second = Math.floor(Date.now() / 1000);
    if (me.t !== second) {
      me.t = second;
      me.n = 0;
    }
    if (++me.n > MAX_RATE) return;
    ws.serializeAttachment(me);
    let message: { type?: unknown; data?: unknown };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.type === "state") {
      await this.ctx.storage.put("state", message.data ?? null);
      this.broadcast({ type: "state", from: me.id, seat: me.seat, data: message.data ?? null }, ws);
    } else if (message.type === "send") {
      this.broadcast({ type: "message", from: me.id, seat: me.seat, data: message.data ?? null }, ws);
    } else if (message.type === "ping") {
      ws.send('{"type":"pong"}');
    }
  }

  async webSocketClose(ws: WebSocket) {
    try {
      ws.close();
    } catch {
      // Already closed.
    }
    this.broadcast({ type: "players", players: this.players().filter((p) => p.id !== (ws.deserializeAttachment() as Seat)?.id) }, ws);
  }

  async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws);
  }

  async alarm() {
    if (this.ctx.getWebSockets().length) await this.ctx.storage.setAlarm(Date.now() + FORGET_AFTER_MS);
    else await this.ctx.storage.deleteAll();
  }
}
