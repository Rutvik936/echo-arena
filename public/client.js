const menu = document.querySelector("#menu");
const game = document.querySelector("#game");
const createBtn = document.querySelector("#createBtn");
const joinForm = document.querySelector("#joinForm");
const roomInput = document.querySelector("#roomInput");
const copyCode = document.querySelector("#copyCode");
const statusEl = document.querySelector("#status");
const timerEl = document.querySelector("#timer");
const echoTimerEl = document.querySelector("#echoTimer");
const p1Hp = document.querySelector("#p1Hp");
const p2Hp = document.querySelector("#p2Hp");
const banner = document.querySelector("#banner");
const rematch = document.querySelector("#rematch");
const canvas = document.querySelector("#arena");
const ctx = canvas.getContext("2d");

let ws;
let playerId;
let roomCode = "";
let state = null;
let keys = {};
let lastInput = "";

connect();
requestAnimationFrame(draw);
setInterval(sendInput, 1000 / 30);

createBtn.addEventListener("click", () => {
  ensureSocket(() => send({ type: "createRoom" }));
});

joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const code = roomInput.value.trim().toUpperCase();
  if (code) ensureSocket(() => send({ type: "joinRoom", code }));
});

copyCode.addEventListener("click", async () => {
  if (!roomCode) return;
  await navigator.clipboard?.writeText(roomCode);
  copyCode.textContent = "Copied";
  setTimeout(() => (copyCode.textContent = roomCode), 900);
});

rematch.addEventListener("click", () => send({ type: "rematch" }));

window.addEventListener("keydown", (event) => {
  keys[event.key.toLowerCase()] = true;
  if ([" ", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(event.key.toLowerCase())) {
    event.preventDefault();
  }
});

window.addEventListener("keyup", (event) => {
  keys[event.key.toLowerCase()] = false;
});

document.querySelectorAll("[data-control]").forEach((button) => {
  const control = button.dataset.control;
  const set = (value) => {
    keys[`touch:${control}`] = value;
  };
  button.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    set(true);
  });
  button.addEventListener("pointerup", () => set(false));
  button.addEventListener("pointercancel", () => set(false));
  button.addEventListener("pointerleave", () => set(false));
});

function connect() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${protocol}://${location.host}`);
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "joined") {
      playerId = message.playerId;
      roomCode = message.code;
      copyCode.textContent = roomCode;
      menu.classList.add("hidden");
      game.classList.remove("hidden");
    }
    if (message.type === "room") {
      roomCode = message.code;
      copyCode.textContent = roomCode;
      statusEl.textContent = message.players < 2 ? "Waiting for opponent" : "Connected";
    }
    if (message.type === "state") {
      state = message;
      updateHud();
    }
    if (message.type === "error") {
      statusEl.textContent = message.message;
      alert(message.message);
    }
  });
  ws.addEventListener("close", () => {
    statusEl.textContent = "Reconnecting";
    setTimeout(connect, 700);
  });
}

function ensureSocket(callback) {
  if (ws?.readyState === WebSocket.OPEN) callback();
  else {
    connect();
    setTimeout(callback, 400);
  }
}

function send(message) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function currentInput() {
  return {
    left: keys.a || keys.arrowleft || keys["touch:left"],
    right: keys.d || keys.arrowright || keys["touch:right"],
    jump: keys.w || keys.arrowup || keys[" "] || keys["touch:jump"],
    punch: keys.j || keys["touch:punch"],
    kick: keys.k || keys["touch:kick"],
    block: keys.l || keys.shift || keys["touch:block"]
  };
}

function sendInput() {
  if (!playerId) return;
  const input = currentInput();
  const encoded = JSON.stringify(input);
  if (encoded !== lastInput) {
    lastInput = encoded;
    send({ type: "input", input });
  }
}

function updateHud() {
  if (!state) return;
  timerEl.textContent = Math.ceil(state.timer);
  echoTimerEl.textContent = state.phase === "playing" ? `Echo in ${Math.ceil(state.nextEchoIn)}s` : "Echo armed";
  p1Hp.style.width = `${state.players.p1.hp}%`;
  p2Hp.style.width = `${state.players.p2.hp}%`;
  rematch.classList.toggle("hidden", state.phase !== "ended");
  banner.classList.toggle("hidden", state.phase === "playing");
  if (state.phase === "waiting") banner.textContent = "Waiting";
  if (state.phase === "paused") banner.textContent = "Opponent left";
  if (state.phase === "countdown") banner.textContent = Math.ceil(state.countdown) || "Fight";
  if (state.phase === "ended") {
    if (state.winner === "draw") banner.textContent = "Draw";
    else banner.textContent = state.winner === playerId ? "You win" : "You lose";
  }
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawArena();
  if (state) {
    drawFighter(state.players.p1, "#37d39a", false);
    drawFighter(state.players.p2, "#ef6262", false);
    for (const echo of state.echoes) drawFighter(echo, echo.owner === "p1" ? "#8bd3d0" : "#f0c15a", true);
    for (const spark of state.sparks) drawSpark(spark);
  }
  requestAnimationFrame(draw);
}

function drawArena() {
  const g = ctx.createLinearGradient(0, 0, 0, canvas.height);
  g.addColorStop(0, "#20272c");
  g.addColorStop(1, "#151719");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#293036";
  ctx.fillRect(0, 452, canvas.width, 88);
  ctx.strokeStyle = "rgba(139, 211, 208, 0.24)";
  ctx.lineWidth = 2;
  for (let x = 0; x < canvas.width; x += 80) {
    ctx.beginPath();
    ctx.moveTo(x, 452);
    ctx.lineTo(x + 44, 540);
    ctx.stroke();
  }
  ctx.fillStyle = "rgba(255,255,255,0.08)";
  ctx.fillRect(90, 118, 780, 4);
  ctx.fillRect(130, 160, 700, 2);
}

function drawFighter(f, color, echo) {
  ctx.save();
  ctx.globalAlpha = echo ? 0.48 : 1;
  const x = f.x;
  const y = f.y;
  ctx.translate(x, y);
  ctx.scale(f.face, 1);
  ctx.fillStyle = echo ? "rgba(139, 211, 208, 0.18)" : "rgba(0,0,0,0.28)";
  ctx.beginPath();
  ctx.ellipse(0, 8, 32, 10, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = color;
  roundRect(-18, -78, 36, 58, 8);
  ctx.fill();
  ctx.fillStyle = echo ? "#effffc" : "#f4f0e8";
  roundRect(-14, -108, 28, 28, 8);
  ctx.fill();
  ctx.strokeStyle = f.blocking ? "#ffffff" : color;
  ctx.lineWidth = echo ? 5 : 7;
  limb(-15, -58, -31, -30);
  limb(15, -58, 31, -30);
  limb(-10, -20, -22, 0);
  limb(10, -20, 22, 0);
  if (f.action === "punch") limb(14, -58, 56, -56);
  if (f.action === "kick") limb(12, -21, 62, -24);
  if (echo) {
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 7]);
    ctx.strokeRect(-25, -116, 50, 124);
  }
  ctx.restore();
}

function limb(x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function drawSpark(spark) {
  ctx.save();
  ctx.translate(spark.x, spark.y);
  ctx.globalAlpha = Math.max(0, spark.life / 0.22);
  ctx.fillStyle = spark.blocked ? "#8bd3d0" : spark.echo ? "#f0c15a" : "#ffffff";
  for (let i = 0; i < 8; i++) {
    ctx.rotate(Math.PI / 4);
    ctx.fillRect(0, -2, 28, 4);
  }
  ctx.restore();
}
