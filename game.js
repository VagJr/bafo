const socket = io();
const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");

let width = window.innerWidth,
  height = window.innerHeight;
canvas.width = width;
canvas.height = height;

let gameState = "LOGIN";
let myUser = null;

let currentRoom = null;
let isMyTurn = false;
let currentTurnId = null;

let physicsCards = [];
let particles = [];
let flyingCards = [];

const camera = { x: 0, y: 0, zoom: 1 };

const PHYSICS = {
  GRAVITY: 0.6,
  BOUNCE: 0.4,
  FRICTION: 0.92,
  MAX_HOLD_TIME: 800,
  MAX_FORCE: 25,
  EXPLOSION_RADIUS: 220,
};

const images = {};
["card1.png", "card2.png", "card3.png", "card4.png", "card5.png"].forEach((n) => {
  const i = new Image();
  i.src = `assets/${n}`;
  images[n] = i;
});

// --- Card ---
class PhysCard {
  constructor(data, x, y) {
    this.data = data;
    this.uid = data.uid;
    this.x = x;
    this.y = y;
    this.z = 0;
    this.vx = 0;
    this.vy = 0;
    this.vz = 0;
    this.angleX = data.flipped ? 180 : 0;
    this.velAngleX = 0;
    this.angleZ = (Math.random() - 0.5) * 20;
    this.velAngleZ = 0;
    this.w = 130;
    this.h = 180;
    this.settled = true;
  }

  update() {
    if (this.settled && this.z <= 0.01) return;

    this.x += this.vx;
    this.y += this.vy;
    this.z += this.vz;
    this.angleX += this.velAngleX;
    this.angleZ += this.velAngleZ;

    if (this.z > 0) this.vz -= PHYSICS.GRAVITY;

    if (this.z <= 0) {
      this.z = 0;

      if (Math.abs(this.vz) > 1.5) {
        this.vz *= -PHYSICS.BOUNCE;
        this.velAngleX *= 0.6;
      } else {
        this.vz = 0;
        this.settled = true;
        this.checkFlip();
      }

      this.vx *= PHYSICS.FRICTION;
      this.vy *= PHYSICS.FRICTION;
      this.velAngleZ *= PHYSICS.FRICTION;
      this.velAngleX *= PHYSICS.FRICTION;
    } else {
      this.vx *= 0.99;
      this.vy *= 0.99;
    }
  }

  checkFlip() {
    const d = Math.abs(this.angleX % 360);
    if (d > 90 && d < 270) {
      this.angleX = 180;
      this.data.flipped = true;
    } else {
      this.angleX = 0;
      this.data.flipped = false;
    }
    this.velAngleX = 0;
  }

  draw(ctx) {
    const depth = 1 + this.z / 600;
    const rad = this.angleX * (Math.PI / 180);
    const flip = Math.cos(rad);
    const isFace = flip < 0;

    ctx.save();

    if (this.z > 2) {
      ctx.translate(this.x + this.z / 4, this.y + this.z / 4);
      ctx.rotate(this.angleZ * (Math.PI / 180));
      ctx.fillStyle = `rgba(0,0,0,${Math.max(0, 0.3 - this.z / 800)})`;
      ctx.beginPath();
      ctx.roundRect(-this.w / 2, -this.h / 2, this.w, this.h, 10);
      ctx.fill();
      ctx.restore();
      ctx.save();
    }

    ctx.translate(this.x, this.y - this.z);
    ctx.scale(depth, Math.abs(flip) * depth);
    ctx.rotate(this.angleZ * (Math.PI / 180));

    const img = images[`card${this.data.cardId}.png`];

    if (isFace) {
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.roundRect(-this.w / 2, -this.h / 2, this.w, this.h, 10);
      ctx.fill();

      if (img && img.complete) {
        ctx.save();
        ctx.clip();
        ctx.drawImage(img, -this.w / 2, -this.h / 2, this.w, this.h);
        ctx.restore();
      }

      // raridade cor
      const rarity = this.data.rarity || "common";
      let stroke = "#ffd700";
      if (rarity === "common") stroke = "#dfe6e9";
      if (rarity === "rare") stroke = "#0984e3";
      if (rarity === "epic") stroke = "#a29bfe";
      if (rarity === "legend") stroke = "#fdcb6e";

      ctx.strokeStyle = stroke;
      ctx.lineWidth = 4;
      ctx.stroke();
    } else {
      ctx.fillStyle = "#2d3436";
      ctx.beginPath();
      ctx.roundRect(-this.w / 2, -this.h / 2, this.w, this.h, 10);
      ctx.fill();
      ctx.strokeStyle = "#ffd700";
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.fillStyle = "#ffd700";
      ctx.font = "50px Arial";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("?", 0, 0);
    }

    ctx.restore();
  }
}

// --- Particles ---
class Particle {
  constructor(x, y) {
    this.x = x;
    this.y = y;
    this.life = 1.0;
    this.vx = (Math.random() - 0.5) * 8;
    this.vy = (Math.random() - 0.5) * 8;
  }
  update() {
    this.x += this.vx;
    this.y += this.vy;
    this.life -= 0.03;
  }
  draw(ctx) {
    ctx.globalAlpha = this.life;
    ctx.fillStyle = "white";
    ctx.beginPath();
    ctx.arc(this.x, this.y, Math.random() * 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

// --- Input ---
const input = { active: false, startT: 0, x: 0, y: 0 };
let hasPlayedThisTurn = false;

function handleStart(x, y) {
  if (gameState !== "PLAYING" || !isMyTurn) return;
  if (hasPlayedThisTurn) return;

  input.active = true;
  input.startT = Date.now();
  input.x = x;
  input.y = y;
}

function handleMove(x, y) {
  if (input.active) {
    input.x = x;
    input.y = y;
  }
}

function handleEnd() {
  if (!input.active) return;
  input.active = false;

  if (gameState !== "PLAYING" || !isMyTurn) return;
  if (hasPlayedThisTurn) return;

  const holdTime = Math.min(Date.now() - input.startT, PHYSICS.MAX_HOLD_TIME);
  const pressure = holdTime / PHYSICS.MAX_HOLD_TIME;

  const worldPos = screenToWorld(input.x, input.y);

  // ✅ NÃO aplica local: manda pro server sincronizar pros 2
  socket.emit("action_blow", {
    roomId: currentRoom.roomId,
    turnId: currentTurnId,
    x: worldPos.x,
    y: worldPos.y,
    pressure,
  });

  hasPlayedThisTurn = true;
}

function createExplosion(x, y, pressure) {
  const radius = PHYSICS.EXPLOSION_RADIUS * (0.8 + pressure * 0.4);
  const force = PHYSICS.MAX_FORCE * pressure;

  let hit = false;

  physicsCards.forEach((c) => {
    const dist = Math.hypot(c.x - x, c.y - y);
    if (dist < radius) {
      hit = true;
      const impact = 1 - dist / radius;

      const safeDist = Math.max(1, dist);
      const dx = (c.x - x) / safeDist;
      const dy = (c.y - y) / safeDist;

      c.vx += dx * impact * 15;
      c.vy += dy * impact * 15;
      c.vz += force * impact;

      c.velAngleX += force * impact * (Math.random() > 0.5 ? 2 : -2);
      c.settled = false;
    }
  });

  if (hit) {
    for (let i = 0; i < 15; i++) particles.push(new Particle(x, y));
  }
}

canvas.addEventListener("mousedown", (e) => handleStart(e.clientX, e.clientY));
canvas.addEventListener("mousemove", (e) => handleMove(e.clientX, e.clientY));
canvas.addEventListener("mouseup", handleEnd);

canvas.addEventListener(
  "touchstart",
  (e) => {
    e.preventDefault();
    handleStart(e.touches[0].clientX, e.touches[0].clientY);
  },
  { passive: false }
);
canvas.addEventListener(
  "touchmove",
  (e) => {
    e.preventDefault();
    handleMove(e.touches[0].clientX, e.touches[0].clientY);
  },
  { passive: false }
);
canvas.addEventListener("touchend", handleEnd);

// --- Camera ---
function updateCamera() {
  if (physicsCards.length === 0) return;

  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;

  physicsCards.forEach((c) => {
    minX = Math.min(minX, c.x);
    maxX = Math.max(maxX, c.x);
    minY = Math.min(minY, c.y);
    maxY = Math.max(maxY, c.y);
  });

  minX -= 300;
  maxX += 300;
  minY -= 300;
  maxY += 300;

  const contentW = maxX - minX;
  const contentH = maxY - minY;

  let targetZoom = Math.min(width / contentW, height / contentH);
  targetZoom = Math.max(0.3, Math.min(targetZoom, 1.2));

  const targetX = (minX + maxX) / 2;
  const targetY = (minY + maxY) / 2;

  camera.x += (targetX - camera.x) * 0.1;
  camera.y += (targetY - camera.y) * 0.1;
  camera.zoom += (targetZoom - camera.zoom) * 0.1;
}

function screenToWorld(sx, sy) {
  return {
    x: (sx - width / 2) / camera.zoom + camera.x,
    y: (sy - height / 2) / camera.zoom + camera.y,
  };
}

// --- Loop ---
let reporting = false;

function sendReport() {
  if (reporting) return;
  if (!isMyTurn) return;
  if (!hasPlayedThisTurn) return;

  const flipped = physicsCards
    .filter((c) => c.data.flipped)
    .map((c) => ({ uid: c.uid, flipped: true }));

  reporting = true;
  socket.emit("physics_report", {
    roomId: currentRoom.roomId,
    turnId: currentTurnId,
    results: flipped,
  });

  setTimeout(() => (reporting = false), 1200);
}

function loop() {
  ctx.clearRect(0, 0, width, height);

  if (gameState === "PLAYING") {
    updateCamera();

    ctx.save();
    ctx.translate(width / 2, height / 2);
    ctx.scale(camera.zoom, camera.zoom);
    ctx.translate(-camera.x, -camera.y);

    // mesa
    ctx.strokeStyle = "rgba(255,255,255,0.1)";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(0, 0, 800, 0, Math.PI * 2);
    ctx.stroke();

    particles.forEach((p, i) => {
      p.update();
      p.draw(ctx);
      if (p.life <= 0) particles.splice(i, 1);
    });

    let settled = true;
    physicsCards.forEach((c) => {
      c.update();
      c.draw(ctx);
      if (!c.settled) settled = false;
    });

    // círculo do charge
    if (input.active) {
      const ws = screenToWorld(input.x, input.y);
      const holdTime = Math.min(Date.now() - input.startT, PHYSICS.MAX_HOLD_TIME);
      const pct = holdTime / PHYSICS.MAX_HOLD_TIME;

      const radius = 100 - pct * 60;
      const alpha = 0.3 + pct * 0.7;

      ctx.beginPath();
      ctx.arc(ws.x, ws.y, radius, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255, 215, 0, ${alpha})`;
      ctx.lineWidth = 5 + pct * 10;
      ctx.stroke();
    }

    ctx.restore();

    // se tudo parou e não está segurando, manda report
    if (settled && !input.active) {
      sendReport();
    }

    // cartas voando overlay
    flyingCards.forEach((fc, i) => {
      const tx = width / 2;
      const ty = fc.winnerId === socket.id ? height - 50 : 50;

      fc.x += (tx - fc.x) * 0.1;
      fc.y += (ty - fc.y) * 0.1;
      fc.scale -= 0.03;

      ctx.save();
      ctx.translate(fc.x, fc.y);
      ctx.scale(fc.scale, fc.scale);

      const img = images[`card${fc.cardId}.png`];
      if (img && img.complete) ctx.drawImage(img, -40, -60, 80, 120);

      ctx.strokeStyle = "gold";
      ctx.lineWidth = 5;
      ctx.strokeRect(-40, -60, 80, 120);
      ctx.restore();

      if (fc.scale <= 0) flyingCards.splice(i, 1);
    });
  }

  requestAnimationFrame(loop);
}

// --- UI ---
function notify(msg) {
  const d = document.createElement("div");
  d.className = "toast";
  d.innerText = msg;
  document.getElementById("toast-area").appendChild(d);
  setTimeout(() => d.remove(), 3000);
}

function updateHUD() {
  document.getElementById("coins-display").innerText = myUser.coins;
  document.getElementById("cards-display").innerText = myUser.collection.length;
}

function updateTurnUI() {
  const b = document.getElementById("turn-badge");
  b.innerText = isMyTurn ? "SUA VEZ!" : "AGUARDE...";
  b.style.borderColor = isMyTurn ? "#00cec9" : "#555";

  hasPlayedThisTurn = false;

  if (isMyTurn) notify("Sua vez! Faça 1 jogada.");
}

// --- COLEÇÃO ---
function rarityColor(rarity) {
  if (rarity === "common") return "#dfe6e9";
  if (rarity === "rare") return "#0984e3";
  if (rarity === "epic") return "#a29bfe";
  if (rarity === "legend") return "#fdcb6e";
  return "#aaa";
}

function openCollection() {
  const grid = document.getElementById("collection-grid");
  grid.innerHTML = "";

  myUser.collection.forEach((c) => {
    const item = document.createElement("div");
    item.className = "collection-card";
    item.style.borderColor = rarityColor(c.rarity);

    const top = document.createElement("div");
    top.className = "collection-top";
    top.innerText = (c.name || "Carta") + ` (${c.rarity || "?"})`;

    const img = document.createElement("div");
    img.className = "collection-img";
    img.style.backgroundImage = `url(assets/card${c.cardId}.png)`;

    item.appendChild(top);
    item.appendChild(img);
    grid.appendChild(item);
  });

  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  document.getElementById("screen-collection").classList.add("active");
}

window.openCollection = openCollection;

// --- Socket ---
socket.on("login_success", (u) => {
  myUser = u;
  document.querySelector(".active").classList.remove("active");
  document.getElementById("screen-menu").classList.add("active");
  updateHUD();
});

socket.on("update_profile", (u) => {
  myUser = u;
  updateHUD();
});

socket.on("waiting_opponent", () => notify("Aguardando oponente..."));

socket.on("game_start", (room) => {
  currentRoom = room;
  gameState = "PLAYING";

  currentTurnId = room.turnId;
  isMyTurn = room.currentTurn === socket.id;

  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  document.getElementById("game-hud").style.display = "flex";

  physicsCards = room.pot.map((c, i) => {
    const angle = i * 0.5;
    const dist = 10 + i * 15;
    return new PhysCard(c, Math.cos(angle) * dist, Math.sin(angle) * dist);
  });

  notify(room.coinFlipWinnerIndex === 0 ? "Moeda: Player 1 começa!" : "Moeda: Player 2 começa!");
  updateTurnUI();
});

// ✅ RECEBE O GOLPE AO VIVO E APLICA IGUAL NOS 2
socket.on("action_blow", (data) => {
  if (!currentRoom || data.roomId !== currentRoom.roomId) return;
  if (data.turnId !== currentTurnId) return;
  createExplosion(data.x, data.y, data.pressure);
});

socket.on("turn_result", (data) => {
  currentTurnId = data.turnId;

  data.cardsWonUIDs.forEach((uid) => {
    const idx = physicsCards.findIndex((c) => c.uid === uid);
    if (idx > -1) {
      const c = physicsCards[idx];
      flyingCards.push({
        x: c.x,
        y: c.y,
        cardId: c.data.cardId,
        winnerId: data.winnerId,
        scale: 1.0,
      });
      physicsCards.splice(idx, 1);
    }
  });

  isMyTurn = data.nextTurn === socket.id;
  updateTurnUI();
});

socket.on("game_over", (d) => {
  notify(d.message);
  setTimeout(() => window.location.reload(), 2500);
});

socket.on("notification", (m) => notify(m));
socket.on("login_error", (m) => notify(m));

// --- Exports ---
window.doLogin = () => {
  const u = document.getElementById("login-user").value;
  const p = document.getElementById("login-pass").value;
  if (u && p) socket.emit("login", { username: u, password: p });
};

window.openMenu = () => {
  gameState = "MENU";
  document.querySelector(".active").classList.remove("active");
  document.getElementById("screen-menu").classList.add("active");
};

window.openBetting = () => {
  const g = document.getElementById("bet-grid");
  g.innerHTML = "";
  window.selectedBet = [];

  myUser.collection.forEach((c) => {
    const d = document.createElement("div");
    d.className = "slot";
    d.style.backgroundImage = `url(assets/card${c.cardId}.png)`;
    d.style.backgroundSize = "cover";
    d.onclick = () => {
      if (window.selectedBet.includes(c.uid)) {
        window.selectedBet = window.selectedBet.filter((i) => i !== c.uid);
        d.style.borderColor = "transparent";
      } else {
        window.selectedBet.push(c.uid);
        d.style.borderColor = "#00cec9";
      }
    };
    g.appendChild(d);
  });

  document.querySelector(".active").classList.remove("active");
  document.getElementById("screen-bet").classList.add("active");
};

window.createMatch = () => {
  const mode = document.getElementById("mode-select").value;
  const rarity = document.getElementById("rarity-select").value || null;
  const freeCount = parseInt(document.getElementById("free-count").value || "9", 10);

  if (mode === "bet") {
    if (!window.selectedBet || window.selectedBet.length <= 0) return notify("Selecione cartas!");
    socket.emit("create_match", {
      mode: "bet",
      selectedCardUIDs: window.selectedBet,
      rarityFilter: rarity,
    });
  } else {
    socket.emit("create_match", {
      mode: "free",
      selectedCardUIDs: [],
      freeCount,
      rarityFilter: rarity,
    });
  }
};

window.openGacha = () => socket.emit("open_booster");
window.closeAll = () => window.location.reload();

window.addEventListener("resize", () => {
  width = window.innerWidth;
  height = window.innerHeight;
  canvas.width = width;
  canvas.height = height;
});

loop();
