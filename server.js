const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const TICK_RATE = 60;
const DT = 1 / TICK_RATE;
const WIDTH = 960;
const HEIGHT = 540;
const FLOOR = 452;
const MATCH_SECONDS = 80;
const ECHO_INTERVAL = 17;
const ECHO_DURATION = 9;
const INPUT_HISTORY = 11;

const rooms = new Map();
const sockets = new Set();

const server = http.createServer((req, res) => {
  let filePath = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, "");
  const fullPath = path.join(__dirname, "public", filePath);
  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(fullPath);
    const type = ext === ".js" ? "text/javascript" : ext === ".css" ? "text/css" : "text/html";
    res.writeHead(200, { "content-type": type });
    res.end(data);
  });
});

server.on("upgrade", (req, socket) => {
  if (req.headers.upgrade?.toLowerCase() !== "websocket") {
    socket.destroy();
    return;
  }
  const key = req.headers["sec-websocket-key"];
  const accept = crypto
    .createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.id = crypto.randomUUID();
  socket.roomCode = null;
  socket.playerId = null;
  sockets.add(socket);
  send(socket, { type: "hello", id: socket.id });
  socket.on("data", (buffer) => readFrames(socket, buffer));
  socket.on("close", () => disconnect(socket));
  socket.on("error", () => disconnect(socket));
});

function readFrames(socket, buffer) {
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const b1 = buffer[offset++];
    const b2 = buffer[offset++];
    let len = b2 & 0x7f;
    if (len === 126) {
      if (offset + 2 > buffer.length) return;
      len = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (offset + 8 > buffer.length) return;
      len = Number(buffer.readBigUInt64BE(offset));
      offset += 8;
    }
    const masked = Boolean(b2 & 0x80);
    const mask = masked ? buffer.subarray(offset, offset + 4) : null;
    offset += masked ? 4 : 0;
    if (offset + len > buffer.length) return;
    const payload = Buffer.from(buffer.subarray(offset, offset + len));
    offset += len;
    if (masked) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    }
    if ((b1 & 0x0f) === 8) {
      socket.end();
      return;
    }
    if ((b1 & 0x0f) === 1) {
      try {
        handle(socket, JSON.parse(payload.toString("utf8")));
      } catch {
        send(socket, { type: "error", message: "Bad message" });
      }
    }
  }
}

function send(socket, message) {
  if (socket.destroyed) return;
  const payload = Buffer.from(JSON.stringify(message));
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

function handle(socket, message) {
  if (message.type === "createRoom") {
    const code = makeCode();
    const room = createRoom(code);
    rooms.set(code, room);
    joinRoom(socket, room);
  }
  if (message.type === "joinRoom") {
    const code = String(message.code || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return send(socket, { type: "error", message: "Room not found" });
    if (room.clients.size >= 2 && !room.clients.has(socket)) {
      return send(socket, { type: "error", message: "Room is full" });
    }
    joinRoom(socket, room);
  }
  if (message.type === "input") {
    const room = rooms.get(socket.roomCode);
    const player = room?.state.players[socket.playerId];
    if (!player || room.state.phase === "ended") return;
    player.input = sanitizeInput(message.input);
  }
  if (message.type === "rematch") {
    const room = rooms.get(socket.roomCode);
    if (!room) return;
    room.rematch.add(socket.playerId);
    broadcast(room, { type: "room", code: room.code, players: room.clients.size, rematch: room.rematch.size });
    if (room.rematch.size >= room.clients.size && room.clients.size === 2) resetMatch(room);
  }
}

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function createRoom(code) {
  return {
    code,
    clients: new Set(),
    rematch: new Set(),
    state: freshState(),
    lastTick: Date.now(),
    accumulator: 0
  };
}

function freshState() {
  return {
    phase: "waiting",
    countdown: 3,
    timer: MATCH_SECONDS,
    echoClock: ECHO_INTERVAL,
    nextEchoIn: ECHO_INTERVAL,
    winner: null,
    sparks: [],
    echoes: [],
    players: {
      p1: makePlayer("p1", 230, 1),
      p2: makePlayer("p2", 730, -1)
    }
  };
}

function makePlayer(id, x, face) {
  return {
    id,
    x,
    y: FLOOR,
    vx: 0,
    vy: 0,
    w: 42,
    h: 86,
    face,
    hp: 100,
    blocking: false,
    grounded: true,
    stun: 0,
    cooldown: 0,
    action: "idle",
    actionTime: 0,
    input: {},
    history: [],
    lastHitBy: new Map()
  };
}

function joinRoom(socket, room) {
  if (socket.roomCode) disconnect(socket);
  const id = room.clients.size === 0 || ![...room.clients].some((s) => s.playerId === "p1") ? "p1" : "p2";
  socket.roomCode = room.code;
  socket.playerId = id;
  room.clients.add(socket);
  send(socket, { type: "joined", code: room.code, playerId: id });
  if (room.clients.size === 2 && room.state.phase === "waiting") room.state.phase = "countdown";
  broadcast(room, { type: "room", code: room.code, players: room.clients.size, rematch: room.rematch.size });
}

function disconnect(socket) {
  sockets.delete(socket);
  const room = rooms.get(socket.roomCode);
  if (!room) return;
  room.clients.delete(socket);
  room.rematch.delete(socket.playerId);
  if (room.clients.size === 0) {
    rooms.delete(room.code);
    return;
  }
  room.state.phase = "paused";
  room.state.winner = socket.playerId === "p1" ? "p2" : "p1";
  broadcast(room, { type: "room", code: room.code, players: room.clients.size, rematch: room.rematch.size });
}

function sanitizeInput(input = {}) {
  return {
    left: Boolean(input.left),
    right: Boolean(input.right),
    jump: Boolean(input.jump),
    punch: Boolean(input.punch),
    kick: Boolean(input.kick),
    block: Boolean(input.block)
  };
}

function resetMatch(room) {
  room.rematch.clear();
  room.state = freshState();
  room.state.phase = "countdown";
  broadcast(room, { type: "room", code: room.code, players: room.clients.size, rematch: 0 });
}

function tickRoom(room) {
  const state = room.state;
  if (state.phase === "waiting" || state.phase === "paused") return;
  if (state.phase === "countdown") {
    state.countdown -= DT;
    if (state.countdown <= 0) state.phase = "playing";
    return;
  }
  if (state.phase !== "playing") return;
  state.timer -= DT;
  state.echoClock -= DT;
  state.nextEchoIn = Math.max(0, state.echoClock);
  if (state.echoClock <= 0) {
    state.echoClock += ECHO_INTERVAL;
    state.nextEchoIn = state.echoClock;
    spawnEchoes(state);
  }
  for (const player of Object.values(state.players)) stepFighter(player, player.input, state, false);
  for (const echo of state.echoes) {
    const frame = echo.frames[echo.index] || echo.frames[echo.frames.length - 1] || {};
    stepFighter(echo, frame.input || {}, state, true);
    echo.index++;
    echo.life -= DT;
  }
  state.echoes = state.echoes.filter((echo) => echo.life > 0 && echo.index < echo.frames.length);
  state.sparks = state.sparks.map((s) => ({ ...s, life: s.life - DT })).filter((s) => s.life > 0);
  for (const player of Object.values(state.players)) {
    player.history.push({ t: state.timer, input: { ...player.input }, x: player.x, y: player.y, face: player.face });
    while (player.history.length > INPUT_HISTORY * TICK_RATE) player.history.shift();
  }
  if (state.timer <= 0 || state.players.p1.hp <= 0 || state.players.p2.hp <= 0) endMatch(state);
}

function stepFighter(f, input, state, isEcho) {
  f.cooldown = Math.max(0, f.cooldown - DT);
  f.stun = Math.max(0, f.stun - DT);
  f.actionTime = Math.max(0, f.actionTime - DT);
  f.blocking = input.block && f.grounded && f.stun <= 0 && f.actionTime <= 0;
  const speed = isEcho ? 246 : 270;
  if (f.stun <= 0 && !f.blocking) {
    const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    f.vx = dir * speed;
    if (dir) f.face = dir;
    if (input.jump && f.grounded) {
      f.vy = -650;
      f.grounded = false;
    }
    if (input.punch) tryAttack(f, state, "punch", isEcho);
    if (input.kick) tryAttack(f, state, "kick", isEcho);
  } else {
    f.vx *= 0.82;
  }
  f.vy += 1850 * DT;
  f.x += f.vx * DT;
  f.y += f.vy * DT;
  f.x = clamp(f.x, 48, WIDTH - 48);
  if (f.y >= FLOOR) {
    f.y = FLOOR;
    f.vy = 0;
    f.grounded = true;
  }
  if (f.actionTime <= 0) {
    f.action = f.blocking ? "block" : !f.grounded ? "jump" : Math.abs(f.vx) > 12 ? "run" : "idle";
  }
}

function tryAttack(attacker, state, kind, isEcho) {
  if (attacker.cooldown > 0 || attacker.actionTime > 0) return;
  const attack = kind === "kick"
    ? { range: 76, height: 50, damage: isEcho ? 8 : 12, cooldown: 0.78, active: 0.22, knock: 360 }
    : { range: 61, height: 44, damage: isEcho ? 6 : 9, cooldown: 0.45, active: 0.16, knock: 250 };
  attacker.cooldown = attack.cooldown;
  attacker.actionTime = attack.active;
  attacker.action = kind;
  const targets = Object.values(state.players).filter((p) => p.id !== ownerId(attacker));
  for (const target of targets) {
    if (target.hp <= 0) continue;
    const inFront = attacker.face > 0 ? target.x >= attacker.x : target.x <= attacker.x;
    const dx = Math.abs(target.x - attacker.x);
    const dy = Math.abs(target.y - attacker.y);
    const hitKey = `${ownerId(attacker)}-${kind}-${Math.round(state.timer * 10)}`;
    if (inFront && dx < attack.range && dy < attack.height && !target.lastHitBy.has(hitKey)) {
      target.lastHitBy.set(hitKey, true);
      while (target.lastHitBy.size > 20) target.lastHitBy.delete(target.lastHitBy.keys().next().value);
      const blocked = target.blocking && target.face === -attacker.face;
      const damage = blocked ? Math.ceil(attack.damage * 0.28) : attack.damage;
      target.hp = clamp(target.hp - damage, 0, 100);
      target.stun = blocked ? 0.08 : 0.22;
      target.vx = attacker.face * (blocked ? attack.knock * 0.25 : attack.knock);
      target.vy = blocked ? target.vy : -120;
      state.sparks.push({ x: target.x, y: target.y - 42, life: 0.22, blocked, echo: isEcho });
    }
  }
}

function ownerId(fighter) {
  return fighter.owner || fighter.id;
}

function spawnEchoes(state) {
  for (const p of Object.values(state.players)) {
    const frames = p.history.slice(-ECHO_DURATION * TICK_RATE);
    if (frames.length < TICK_RATE) continue;
    state.echoes.push({
      ...makePlayer(`echo-${p.id}-${Date.now()}`, frames[0].x, frames[0].face),
      owner: p.id,
      hp: 1,
      y: frames[0].y,
      frames,
      index: 0,
      life: Math.min(ECHO_DURATION, frames.length / TICK_RATE),
      echo: true
    });
  }
}

function endMatch(state) {
  state.phase = "ended";
  const p1 = state.players.p1.hp;
  const p2 = state.players.p2.hp;
  state.winner = p1 === p2 ? "draw" : p1 > p2 ? "p1" : "p2";
}

function snapshot(room) {
  const s = room.state;
  return {
    type: "state",
    code: room.code,
    phase: s.phase,
    countdown: Math.max(0, s.countdown),
    timer: Math.max(0, s.timer),
    nextEchoIn: s.nextEchoIn,
    winner: s.winner,
    players: Object.fromEntries(Object.entries(s.players).map(([id, p]) => [id, packFighter(p)])),
    echoes: s.echoes.map(packFighter),
    sparks: s.sparks
  };
}

function packFighter(f) {
  return {
    id: f.id,
    owner: ownerId(f),
    x: Math.round(f.x),
    y: Math.round(f.y),
    face: f.face,
    hp: f.hp,
    action: f.action,
    blocking: f.blocking,
    echo: Boolean(f.echo)
  };
}

function broadcast(room, message) {
  for (const socket of room.clients) send(socket, message);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

setInterval(() => {
  for (const room of rooms.values()) {
    tickRoom(room);
    broadcast(room, snapshot(room));
  }
}, 1000 / TICK_RATE);

server.listen(PORT, () => {
  console.log(`Echo Arena listening on http://localhost:${PORT}`);
});
