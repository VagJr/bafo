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

// templates
const CARD_TEMPLATES = [
  { id: 1, name: "Guerreiro Slime", rarity: "common" },
  { id: 2, name: "Dragão de Papel", rarity: "rare" },
  { id: 3, name: "Mago Neon", rarity: "epic" },
  { id: 4, name: "Rei do Bafo", rarity: "legend" },
  { id: 5, name: "Fantasma Bloop", rarity: "common" },
];

const GAME_MODES = {
  FREE: "free",
  BET: "bet",
};

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function coinFlip() {
  return Math.random() < 0.5 ? 0 : 1;
}

function generateBooster(ownerName, count, rarityFilter = null) {
  const cards = [];
  for (let i = 0; i < count; i++) {
    let templates = CARD_TEMPLATES;
    if (rarityFilter) templates = templates.filter((t) => t.rarity === rarityFilter);
    if (templates.length === 0) templates = CARD_TEMPLATES;

    const t = templates[Math.floor(Math.random() * templates.length)];
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

function createFreeTableCards(count, rarityFilter = null) {
  const cards = [];
  for (let i = 0; i < count; i++) {
    let templates = CARD_TEMPLATES;
    if (rarityFilter) templates = templates.filter((t) => t.rarity === rarityFilter);
    if (templates.length === 0) templates = CARD_TEMPLATES;

    const t = templates[Math.floor(Math.random() * templates.length)];
    cards.push({
      uid: uid(),
      cardId: t.id,
      name: t.name,
      rarity: t.rarity,
      originalOwner: "__TABLE__",
      flipped: false,
    });
  }
  return cards;
}

function findRoomToJoin(mode, betAmount, rarityFilter, freeCount) {
  for (const id in MATCHES) {
    const r = MATCHES[id];
    if (r.started) continue;
    if (r.players.length >= 2) continue;
    if (r.mode !== mode) continue;

    if (mode === GAME_MODES.BET) {
      if (r.betAmount !== betAmount) continue;
      if ((r.rarityFilter || null) !== (rarityFilter || null)) continue;
    } else {
      if (r.freeCount !== freeCount) continue;
      if ((r.rarityFilter || null) !== (rarityFilter || null)) continue;
    }
    return r;
  }
  return null;
}

io.on("connection", (socket) => {
  socket.on("login", (data) => {
    const { username, password } = data || {};
    if (!username || !password) return socket.emit("login_error", "Dados inválidos!");

    let user = DATABASE.users[username];

    if (!user) {
      user = {
        username,
        password,
        coins: 500,
        wins: 0,
        matches: 0,
        collection: generateBooster(username, 8),
      };
      DATABASE.users[username] = user;
      saveDB();
    } else if (user.password !== password) {
      return socket.emit("login_error", "Senha incorreta!");
    }

    SOCKET_USER_MAP[socket.id] = username;
    socket.emit("login_success", user);
  });

  socket.on("create_match", (payload) => {
    const username = SOCKET_USER_MAP[socket.id];
    if (!username) return;

    const userObj = DATABASE.users[username];
    if (!userObj) return;

    const { mode, selectedCardUIDs = [], freeCount = 9, rarityFilter = null } = payload || {};
    const safeMode = mode === GAME_MODES.FREE ? GAME_MODES.FREE : GAME_MODES.BET;

    let betCards = [];
    let betAmount = selectedCardUIDs.length;

    if (safeMode === GAME_MODES.BET) {
      betCards = userObj.collection.filter((c) => selectedCardUIDs.includes(c.uid));
      betAmount = betCards.length;

      if (betAmount <= 0) return socket.emit("notification", "Selecione cartas válidas!");
      if (betAmount !== selectedCardUIDs.length)
        return socket.emit("notification", "Cartas inválidas detectadas!");
    }

    const room = findRoomToJoin(safeMode, betAmount, rarityFilter, freeCount);

    // cria sala
    if (!room) {
      const rid = "room_" + socket.id;

      const newRoom = {
        id: rid,
        mode: safeMode,
        players: [socket.id],
        usernames: [username],
        started: false,

        // turnos
        turnIndex: 0,
        turnId: null,
        actionUsedThisTurn: false, // já houve golpe?
        reportDoneThisTurn: false, // já finalizou?

        // filtros
        rarityFilter: rarityFilter || null,

        betAmount,
        freeCount,

        pot: [],
      };

      if (safeMode === GAME_MODES.BET) newRoom.pot = [...betCards];
      else newRoom.pot = createFreeTableCards(freeCount, rarityFilter);

      MATCHES[rid] = newRoom;
      socket.join(rid);
      socket.emit("waiting_opponent");
      return;
    }

    // entra como player2
    room.players.push(socket.id);
    room.usernames.push(username);
    socket.join(room.id);

    if (room.mode === GAME_MODES.BET) room.pot.push(...betCards);

    room.started = true;
    room.pot.sort(() => Math.random() - 0.5);

    const starter = coinFlip();
    room.turnIndex = starter;
    room.turnId = uid();
    room.actionUsedThisTurn = false;
    room.reportDoneThisTurn = false;

    io.to(room.id).emit("game_start", {
      roomId: room.id,
      mode: room.mode,
      pot: room.pot,
      players: room.players,
      usernames: room.usernames,
      rarityFilter: room.rarityFilter,
      currentTurn: room.players[room.turnIndex],
      coinFlipWinnerIndex: starter,
      turnId: room.turnId,
    });
  });

  // ✅ AÇÃO AO VIVO: golpe sincronizado pros 2 jogadores
  socket.on("action_blow", (data) => {
    const { roomId, turnId, x, y, pressure } = data || {};
    const room = MATCHES[roomId];
    if (!room) return;

    if (room.players[room.turnIndex] !== socket.id) return;
    if (turnId !== room.turnId) return;
    if (room.actionUsedThisTurn) return; // 1 golpe por turno
    if (room.reportDoneThisTurn) return;

    room.actionUsedThisTurn = true;

    io.to(room.id).emit("action_blow", {
      by: socket.id,
      roomId,
      turnId,
      x,
      y,
      pressure: Math.max(0, Math.min(1, pressure)),
      t: Date.now(),
    });
  });

  // ✅ encerramento do turno (1 carta no máximo)
  socket.on("physics_report", (data) => {
    const room = MATCHES[data.roomId];
    if (!room) return;

    if (room.players[room.turnIndex] !== socket.id) return;
    if (data.turnId !== room.turnId) return;

    // precisa ter feito golpe
    if (!room.actionUsedThisTurn) return;

    // 1 fechamento por turno
    if (room.reportDoneThisTurn) return;
    room.reportDoneThisTurn = true;

    const username = SOCKET_USER_MAP[socket.id];
    if (!username) return;

    // escolhe a primeira carta flipped que ainda existe no pot
    let won = null;
    const reported = Array.isArray(data.results) ? data.results : [];
    for (const res of reported) {
      if (!res || !res.uid || !res.flipped) continue;
      const cardInPot = room.pot.find((c) => c.uid === res.uid);
      if (cardInPot) {
        won = cardInPot;
        break;
      }
    }

    const wonUIDs = [];
    if (won) {
      wonUIDs.push(won.uid);

      // remove do pot
      room.pot = room.pot.filter((c) => c.uid !== won.uid);

      // ganha a carta
      const winnerUser = DATABASE.users[username];
      if (winnerUser) {
        const newCard = { ...won, originalOwner: username, flipped: false };
        winnerUser.collection.push(newCard);
      }

      // se era aposta, remove do dono original também
      if (room.mode === GAME_MODES.BET) {
        const originalUser = DATABASE.users[won.originalOwner];
        if (originalUser) {
          const idx = originalUser.collection.findIndex((c) => c.uid === won.uid);
          if (idx > -1) originalUser.collection.splice(idx, 1);
        }
      }

      saveDB();
    }

    // próximo turno
    room.turnIndex = (room.turnIndex + 1) % 2;
    room.turnId = uid();
    room.actionUsedThisTurn = false;
    room.reportDoneThisTurn = false;

    const nextPlayerId = room.players[room.turnIndex];

    io.to(room.id).emit("turn_result", {
      cardsWonUIDs: wonUIDs, // 0 ou 1
      winnerId: socket.id,
      nextTurn: nextPlayerId,
      remainingPotCount: room.pot.length,
      turnId: room.turnId,
    });

    if (room.pot.length === 0) {
      io.to(room.id).emit("game_over", { message: "Mesa acabou! Partida finalizada." });

      io.to(room.players[0]).emit("update_profile", DATABASE.users[room.usernames[0]]);
      io.to(room.players[1]).emit("update_profile", DATABASE.users[room.usernames[1]]);

      delete MATCHES[room.id];
    }
  });

  socket.on("open_booster", () => {
    const username = SOCKET_USER_MAP[socket.id];
    if (!username) return;
    const user = DATABASE.users[username];
    if (!user) return;

    if (user.coins >= 100) {
      user.coins -= 100;
      const newCards = generateBooster(username, 3);
      user.collection.push(...newCards);
      saveDB();
      socket.emit("update_profile", user);
      socket.emit("booster_opened", newCards);
    } else {
      socket.emit("notification", "Moedas insuficientes!");
    }
  });

  socket.on("disconnect", () => {
    delete SOCKET_USER_MAP[socket.id];
  });
});

http.listen(3000, () => console.log("Server Bafo TURNO SYNC v2 rodando na 3000"));
