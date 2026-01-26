const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);
const path = require("path");
const fs = require("fs");

app.use(express.static(path.join(__dirname, ".")));

const DB_FILE = "db.json";
let DATABASE = { users: {} };

if (fs.existsSync(DB_FILE)) {
  DATABASE = JSON.parse(fs.readFileSync(DB_FILE));
} else {
  saveDB();
}
function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(DATABASE, null, 2));
}

const MATCHES = {};
const SOCKET_USER_MAP = {};

const CARD_TEMPLATES = [
  { id: 1, name: "Guerreiro Slime", rarity: "common" },
  { id: 2, name: "Dragão de Papel", rarity: "rare" },
  { id: 3, name: "Mago Neon", rarity: "epic" },
  { id: 4, name: "Rei do Bafo", rarity: "legend" },
  { id: 5, name: "Fantasma Bloop", rarity: "common" },
];

const ALLOWED_BETS = [1, 3, 5]; // Regra de aposta

function uid() { return Math.random().toString(36).slice(2, 10); }
function coinFlip() { return Math.random() < 0.5 ? 0 : 1; }

function generateBooster(ownerName, count) {
  const cards = [];
  for (let i = 0; i < count; i++) {
    const t = CARD_TEMPLATES[Math.floor(Math.random() * CARD_TEMPLATES.length)];
    cards.push({
      uid: uid(),
      cardId: t.id,
      name: t.name,
      rarity: t.rarity,
      originalOwner: ownerName,
      flipped: false,
    });
  }
  return cards;
}

function findRoomToJoin(betAmount) {
  for (const id in MATCHES) {
    const r = MATCHES[id];
    if (r.started) continue;
    if (r.players.length >= 2) continue;
    if (r.betAmount === betAmount) return r;
  }
  return null;
}

io.on("connection", (socket) => {
  socket.on("login", (data) => {
    const { username, password } = data || {};
    if (!username || !password) return;

    let user = DATABASE.users[username];
    if (!user) {
      user = { username, password, coins: 500, collection: generateBooster(username, 10) };
      DATABASE.users[username] = user;
      saveDB();
    }
    SOCKET_USER_MAP[socket.id] = username;
    socket.emit("login_success", user);
  });

  socket.on("create_match", (selectedUIDs) => {
    const username = SOCKET_USER_MAP[socket.id];
    if (!username) return;

    // Validação Rigorosa de Quantidade
    if (!ALLOWED_BETS.includes(selectedUIDs.length)) {
      return socket.emit("notification", "Apostas permitidas: 1, 3 ou 5 cartas!");
    }

    const userObj = DATABASE.users[username];
    const betCards = userObj.collection.filter(c => selectedUIDs.includes(c.uid));
    
    if (betCards.length !== selectedUIDs.length) return;

    const room = findRoomToJoin(betCards.length);

    if (!room) {
      const rid = "room_" + socket.id;
      MATCHES[rid] = {
        id: rid,
        players: [socket.id],
        usernames: [username],
        betAmount: betCards.length,
        pot: [...betCards],
        started: false,
        turnIndex: 0,
        turnId: null,
        actionUsed: false
      };
      socket.join(rid);
      socket.emit("waiting_opponent");
    } else {
      room.players.push(socket.id);
      room.usernames.push(username);
      room.pot.push(...betCards);
      room.started = true;
      socket.join(room.id);

      // Embaralha muito bem
      room.pot.sort(() => Math.random() - 0.5);

      const starter = coinFlip();
      room.turnIndex = starter;
      room.turnId = uid();
      room.actionUsed = false;

      io.to(room.id).emit("game_start", {
        roomId: room.id,
        pot: room.pot,
        currentTurn: room.players[starter],
        turnId: room.turnId
      });
    }
  });

  socket.on("action_blow", (data) => {
    const room = MATCHES[data.roomId];
    if (!room) return;
    if (room.players[room.turnIndex] !== socket.id) return;
    if (room.actionUsed) return;

    room.actionUsed = true;
    io.to(room.id).emit("action_blow", {
      roomId: data.roomId,
      turnId: data.turnId,
      x: data.x, y: data.y, pressure: data.pressure
    });
  });

  // CLAIM INSTANTÂNEO
  socket.on("card_flip_claim", (data) => {
    const room = MATCHES[data.roomId];
    if (!room) return;

    // Remove do POT da sala
    const idx = room.pot.findIndex(c => c.uid === data.cardUID);
    if (idx === -1) return; // Já foi pega

    const card = room.pot[idx];
    room.pot.splice(idx, 1);

    // Transfere posse no DB
    const winnerName = SOCKET_USER_MAP[socket.id];
    const winnerUser = DATABASE.users[winnerName];
    const loserUser = DATABASE.users[card.originalOwner];

    // Remove do perdedor
    if (loserUser) {
        const lIdx = loserUser.collection.findIndex(c => c.uid === card.uid);
        if (lIdx > -1) loserUser.collection.splice(lIdx, 1);
    }

    // Adiciona ao vencedor
    if (winnerUser) {
        winnerUser.collection.push({ ...card, originalOwner: winnerName, flipped: false });
        socket.emit("update_profile", winnerUser);
    }
    saveDB();

    // Broadcast para remover visualmente para AMBOS
    io.to(room.id).emit("card_won", {
      cardUID: card.uid,
      winnerId: socket.id
    });

    if (room.pot.length === 0) {
      io.to(room.id).emit("game_over", { message: "Fim de Jogo!" });
      delete MATCHES[room.id];
    }
  });

  socket.on("turn_end_request", (data) => {
    const room = MATCHES[data.roomId];
    if (!room) return;
    if (room.players[room.turnIndex] !== socket.id) return;
    
    // Passa a vez
    room.turnIndex = (room.turnIndex + 1) % 2;
    room.turnId = uid();
    room.actionUsed = false;

    io.to(room.id).emit("new_turn", {
        nextTurn: room.players[room.turnIndex],
        turnId: room.turnId
    });
  });

  socket.on("disconnect", () => delete SOCKET_USER_MAP[socket.id]);
});

http.listen(3000, () => console.log("Server Bafo V6 - 3000"));