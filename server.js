const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);
const path = require("path");
const fs = require("fs");

// Node 18+ tem fetch global, mas deixo compatível:
const fetchFn = global.fetch ? global.fetch : (...args) => import("node-fetch").then(({default: fetch}) => fetch(...args));

// --------------------
// POSTGRES (Render)
// --------------------
let Pool = null;
try { Pool = require("pg").Pool; } catch(e) {}

const HAS_PG = !!(Pool && process.env.DATABASE_URL);

const pool = HAS_PG ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
}) : null;

// --------------------
// STATIC
// --------------------
app.use(express.static(path.join(__dirname, ".")));

// --------------------
// LOCAL DB FALLBACK
// --------------------
const DB_FILE = "db.json";
let DATABASE = { users: {}, market: [] };
const BOT_NAME = "LumiaBot";

// runtime objects
const MATCHES = {};
const TRADES = {};
const SOCKET_USER_MAP = {};

function uid() { return Math.random().toString(36).slice(2, 10); }

// --------------------
// DB: Local
// --------------------
function saveLocalDB() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(DATABASE, null, 2));
  } catch(e) {
    console.error("Erro ao salvar DB:", e);
  }
}
function loadLocalDB() {
  if (fs.existsSync(DB_FILE)) {
    try {
      DATABASE = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
      if (!DATABASE.market) DATABASE.market = [];
      if (!DATABASE.users) DATABASE.users = {};
    } catch (e) {
      console.error("Erro ao ler DB, resetando:", e);
      DATABASE = { users: {}, market: [] };
      saveLocalDB();
    }
  } else {
    saveLocalDB();
  }
}

// --------------------
// DB: Postgres
// --------------------
async function initPG() {
  if (!pool) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      coins INT NOT NULL DEFAULT 0,
      collection JSONB NOT NULL DEFAULT '[]',
      lastlogin TEXT DEFAULT '',
      isbot BOOLEAN DEFAULT FALSE
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS market (
      listingid TEXT PRIMARY KEY,
      seller TEXT NOT NULL,
      card JSONB NOT NULL,
      price INT NOT NULL,
      timestamp BIGINT NOT NULL
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_market_ts ON market(timestamp DESC);`);
}

async function pgLoadAll() {
  if (!pool) return;

  const usersRes = await pool.query("SELECT * FROM users");
  DATABASE.users = {};
  for (const row of usersRes.rows) {
    DATABASE.users[row.username] = {
      username: row.username,
      coins: Number(row.coins || 0),
      collection: Array.isArray(row.collection) ? row.collection : [],
      lastLogin: row.lastlogin || "",
      isBot: !!row.isbot
    };
  }

  const marketRes = await pool.query("SELECT * FROM market ORDER BY timestamp DESC LIMIT 5000");
  DATABASE.market = marketRes.rows.map(r => ({
    listingId: r.listingid,
    seller: r.seller,
    card: r.card,
    price: Number(r.price || 0),
    timestamp: Number(r.timestamp || Date.now())
  }));
}

async function pgUpsertUser(user) {
  if (!pool) return;
  await pool.query(`
    INSERT INTO users (username, coins, collection, lastlogin, isbot)
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (username)
    DO UPDATE SET coins=$2, collection=$3, lastlogin=$4, isbot=$5
  `, [
    user.username,
    Number(user.coins || 0),
    JSON.stringify(user.collection || []),
    user.lastLogin || "",
    !!user.isBot
  ]);
}

async function pgInsertMarket(item) {
  if (!pool) return;
  await pool.query(`
    INSERT INTO market (listingid, seller, card, price, timestamp)
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (listingid)
    DO NOTHING
  `, [
    item.listingId,
    item.seller,
    JSON.stringify(item.card),
    Number(item.price || 0),
    Number(item.timestamp || Date.now())
  ]);
}

async function pgDeleteMarket(listingId) {
  if (!pool) return;
  await pool.query(`DELETE FROM market WHERE listingid=$1`, [listingId]);
}

// Persistência unificada (não esquece nada)
async function saveDB() {
  if (HAS_PG) {
    try {
      // salva users
      for (const uName in DATABASE.users) {
        await pgUpsertUser(DATABASE.users[uName]);
      }

      // sincroniza market (simples e confiável)
      // (para market não acumular fantasmas quando muda muito)
      await pool.query("DELETE FROM market");
      for (const item of DATABASE.market) {
        await pgInsertMarket(item);
      }
    } catch (e) {
      console.error("Erro PG saveDB:", e);
    }
  } else {
    saveLocalDB();
  }
}

// --------------------
// BOOT
// --------------------
async function initStorage() {
  if (HAS_PG) {
    console.log("DB: usando PostgreSQL (Render)");
    await initPG();
    await pgLoadAll();
  } else {
    console.log("DB: usando db.json local");
    loadLocalDB();
  }

  // Garante Bot
  if (!DATABASE.users[BOT_NAME]) {
    DATABASE.users[BOT_NAME] = { username: BOT_NAME, coins: 999999, collection: [], isBot: true };
    await saveDB();
  } else {
    DATABASE.users[BOT_NAME].isBot = true;
  }
}

// --------------------
// API: CARTAS (mantido)
// --------------------
async function fetchRandomCard() {
  const sources = ['pokemon', 'mtg', 'lorcana'];
  const source = sources[Math.floor(Math.random() * sources.length)];
  let cardData = { name: "Carta", image: "https://via.placeholder.com/150", rarity: "common", source: "System" };

  try {
    if (source === 'pokemon') {
      const res = await fetchFn('https://api.pokemontcg.io/v2/cards?pageSize=1&page=' + Math.floor(Math.random() * 800));
      const data = await res.json();
      const c = data.data[0];
      if(c) cardData = { name: c.name, image: c.images.large || c.images.small, rarity: mapRarity(c.rarity), source: "Pokémon" };
    }
    else if (source === 'mtg') {
      const res = await fetchFn('https://api.scryfall.com/cards/random');
      const c = await res.json();
      if(c) {
        const img = c.image_uris ? c.image_uris.normal : (c.card_faces ? c.card_faces[0].image_uris.normal : "");
        cardData = { name: c.name, image: img, rarity: mapRarity(c.rarity), source: "Magic" };
      }
    }
    else if (source === 'lorcana') {
      try {
        const res = await fetchFn('https://api.lorcana-api.com/cards/all');
        const all = await res.json();
        if(all && all.length > 0) {
          const c = all[Math.floor(Math.random() * all.length)];
          cardData = { name: c.Name, image: c.Image, rarity: mapRarity(c.Rarity), source: "Lorcana" };
        }
      } catch(e) {}
    }
  } catch (err) {}

  return cardData;
}

function mapRarity(rawRarity) {
  if(!rawRarity) return "common";
  const r = String(rawRarity).toLowerCase();
  if (r.includes('rare') || r.includes('holo')) return 'rare';
  if (r.includes('ultra') || r.includes('mythic') || r.includes('vmax') || r.includes('secret')) return 'epic';
  if (r.includes('legend') || r.includes('enchanted')) return 'legend';
  return 'common';
}

async function generateBooster(ownerName, count) {
  const promises = [];
  for (let i = 0; i < count; i++) promises.push(fetchRandomCard());
  const results = await Promise.all(promises);

  return results.map(data => ({
    uid: uid(),
    name: data.name,
    image: data.image,
    rarity: data.rarity,
    source: data.source,
    originalOwner: ownerName,
    flipped: false,
  }));
}

// --------------------
// BOT ECONOMY (SAFE LOOP) (mantido e persistindo)
// --------------------
setInterval(async () => {
  try {
    const bot = DATABASE.users[BOT_NAME];
    if (!bot) return;
    if (!DATABASE.market) DATABASE.market = [];

    // Bot compra (mantido)
    const sample = DATABASE.market.filter(m => m && m.seller !== BOT_NAME).slice(0, 5);
    for (const item of sample) {
      if (!item || !item.card) continue;

      if (bot.coins >= item.price && Math.random() < 0.3) {
        const idx = DATABASE.market.findIndex(m => m.listingId === item.listingId);
        if (idx > -1) {
          const buyItem = DATABASE.market[idx];

          bot.coins -= buyItem.price;
          bot.collection.push({ ...buyItem.card, originalOwner: BOT_NAME });

          if(DATABASE.users[buyItem.seller]) {
            DATABASE.users[buyItem.seller].coins += buyItem.price;
          }

          DATABASE.market.splice(idx, 1);

          io.emit("market_update", DATABASE.market);
          await saveDB();
          break; // Compra 1 por vez
        }
      }
    }

    // Bot vende (mantido)
    if(bot.collection.length > 30) {
      const card = bot.collection.splice(0, 1)[0];
      const price = Math.floor(Math.random() * 200) + 50;

      DATABASE.market.push({
        listingId: uid(),
        seller: BOT_NAME,
        card,
        price,
        timestamp: Date.now()
      });

      io.emit("market_update", DATABASE.market);
      await saveDB();
    }
  } catch (err) {
    console.error("Erro no Loop do Bot:", err);
  }
}, 15000);


// --------------------
// SOCKETS (seu código inteiro)
// --------------------
io.on("connection", (socket) => {

  // Atualiza contador
  io.emit("online_count", io.engine.clientsCount);

  socket.on("login", async (data) => {
    try {
      const { username } = data || {};
      if (!username) return;

      let user = DATABASE.users[username];

      if (!user) {
        const starterDeck = await generateBooster(username, 6);
        user = { username, coins: 1000, collection: starterDeck, lastLogin: "" };
        DATABASE.users[username] = user;
      }

      const today = new Date().toDateString();
      if (user.lastLogin !== today) {
        user.coins += 2000;
        user.lastLogin = today;
        socket.emit("notification", "🎁 +2000 Moedas Diárias!");
      }

      await saveDB();

      SOCKET_USER_MAP[socket.id] = username;

      socket.emit("login_success", user);
      socket.emit("market_update", DATABASE.market);
    } catch(e) { console.error("Login Error:", e); }
  });

  // --- CHAT GLOBAL ---
  socket.on("chat_send", (msg) => {
    const username = SOCKET_USER_MAP[socket.id];
    if(username && msg.trim().length > 0) {
      const cleanMsg = msg.substring(0, 100);
      io.emit("chat_message", { user: username, text: cleanMsg });
    }
  });

  // --- COMPRA PACOTE ---
  socket.on("buy_booster", async () => {
    try {
      const username = SOCKET_USER_MAP[socket.id];
      if(!username) return;

      const user = DATABASE.users[username];
      if(user.coins >= 500) {
        user.coins -= 500;
        socket.emit("notification", "Gerando pacote...");

        const newCards = await generateBooster(username, 3);
        user.collection.push(...newCards);

        await saveDB();

        socket.emit("update_profile", user);
        socket.emit("booster_opened", newCards);
      } else socket.emit("notification", "Sem moedas (500)!");
    } catch(e) { console.error("Booster Error:", e); }
  });

  // --- MERCADO ---
  socket.on("market_sell", async (d) => {
    try {
      const username = SOCKET_USER_MAP[socket.id];
      if(!username) return;

      const u = DATABASE.users[username];
      const idx = u.collection.findIndex(c => c.uid === d.cardUID);

      if(idx > -1) {
        const card = u.collection.splice(idx, 1)[0];

        DATABASE.market.push({
          listingId: uid(),
          seller: u.username,
          card,
          price: d.price,
          timestamp: Date.now()
        });

        await saveDB();

        socket.emit("update_profile", u);
        io.emit("market_update", DATABASE.market);
        socket.emit("notification", "Carta listada!");
      }
    } catch(e) { console.error("Sell Error:", e); }
  });

  socket.on("market_buy", async (listingId) => {
    try {
      const buyerName = SOCKET_USER_MAP[socket.id];
      if(!buyerName) return;

      const buyer = DATABASE.users[buyerName];
      const idx = DATABASE.market.findIndex(m => m.listingId === listingId);

      if(idx === -1) return socket.emit("notification", "Já foi vendida!");

      const item = DATABASE.market[idx];

      if(buyer.coins >= item.price) {
        buyer.coins -= item.price;
        buyer.collection.push(item.card);

        DATABASE.market.splice(idx, 1);

        if(DATABASE.users[item.seller]) {
          DATABASE.users[item.seller].coins += item.price;
        }

        await saveDB();

        socket.emit("update_profile", buyer);
        io.emit("market_update", DATABASE.market);
        socket.emit("notification", "Compra realizada!");
      } else {
        socket.emit("notification", "Moedas insuficientes.");
      }
    } catch(e) { console.error("Buy Error:", e); }
  });

  // --- MATCHMAKING & GAME ---
  socket.on("create_match", async (selectedUIDs) => {
    try {
      const username = SOCKET_USER_MAP[socket.id];
      if(!username) return;

      const userObj = DATABASE.users[username];
      const betCards = userObj.collection.filter(c => selectedUIDs.includes(c.uid));

      if (betCards.length !== selectedUIDs.length) return socket.emit("notification", "Erro: Cartas não encontradas.");

      let room = null;
      for (const id in MATCHES) {
        const r = MATCHES[id];
        if (!r.started && r.players.length < 2 && r.betAmount === betCards.length && !r.isBotMatch) { room = r; break; }
      }

      if (!room) {
        const rid = "room_" + socket.id;
        MATCHES[rid] = {
          id: rid, players: [socket.id], usernames: [username],
          betAmount: betCards.length, pot: [...betCards], scores: { [username]: 0 },
          started: false, isBotMatch: false
        };
        socket.join(rid);
        socket.emit("waiting_opponent");

        // Bot Join Logic
        setTimeout(async () => {
          const r = MATCHES[rid];
          if (r && !r.started) {
            const botBet = await generateBooster(BOT_NAME, r.betAmount);
            r.players.push("BOT_ID"); r.usernames.push(BOT_NAME);
            r.pot.push(...botBet); r.scores[BOT_NAME] = 0;
            r.started = true; r.isBotMatch = true;
            startMatch(r);
          }
        }, 4000);
      } else {
        room.players.push(socket.id); room.usernames.push(username);
        room.pot.push(...betCards); room.scores[username] = 0;
        room.started = true;
        socket.join(room.id);
        startMatch(room);
      }
    } catch(e) { console.error("Match Error:", e); }
  });

  function startMatch(room) {
    room.pot.sort(() => Math.random() - 0.5);
    room.turnIndex = 0; room.turnId = uid();
    io.to(room.id).emit("game_start", {
      roomId: room.id,
      pot: room.pot,
      currentTurn: room.players[0],
      turnId: room.turnId,
      usernames: room.usernames
    });
  }

  // Ações In-Game
  socket.on("action_blow", (d) => {
    const r = MATCHES[d.roomId];
    if(r && !r.actionUsed) { r.actionUsed = true; io.to(d.roomId).emit("action_blow", d); }
  });

  socket.on("bot_play_trigger", (roomId) => {
    const r = MATCHES[roomId];
    if(r && r.isBotMatch && r.players[r.turnIndex] === "BOT_ID" && !r.actionUsed) {
      io.to(roomId).emit("bot_should_play", { turnId: r.turnId });
    }
  });

  socket.on("card_flip_claim", async (d) => {
    try {
      const room = MATCHES[d.roomId];
      if (!room) return;

      const idx = room.pot.findIndex(c => c.uid === d.cardUID);
      if (idx === -1) return;

      const card = room.pot[idx];
      room.pot.splice(idx, 1);

      let wId = d.winnerIsBot ? "BOT_ID" : socket.id;
      let wName = d.winnerIsBot ? BOT_NAME : SOCKET_USER_MAP[wId];
      room.scores[wName] = (room.scores[wName] || 0) + 1;

      const wUser = DATABASE.users[wName];
      if(wUser) wUser.collection.push({ ...card, originalOwner: wName });

      await saveDB();

      if(!d.winnerIsBot) socket.emit("update_profile", wUser);
      io.to(room.id).emit("card_won", { cardUID: card.uid, winnerId: wId });

      if(room.pot.length === 0) endGame(room);
    } catch(e) { console.error("Claim Error:", e); }
  });

  function endGame(room) {
    const p1 = room.usernames[0];
    const p2 = room.usernames[1];
    const s1 = room.scores[p1] || 0;
    const s2 = room.scores[p2] || 0;

    let msg = "Empate!";
    if(s1 > s2) { msg = `${p1} Venceu!`; addCoins(p1, 250); }
    else if(s2 > s1) { msg = `${p2} Venceu!`; addCoins(p2, 250); }
    else { addCoins(p1, 100); addCoins(p2, 100); }

    io.to(room.id).emit("game_over", { message: msg });
    delete MATCHES[room.id];
  }

  async function addCoins(user, qtd) {
    if(DATABASE.users[user]) {
      DATABASE.users[user].coins += qtd;
      await saveDB();
    }

    for(let sid in SOCKET_USER_MAP) {
      if(SOCKET_USER_MAP[sid] === user) io.to(sid).emit("update_profile", DATABASE.users[user]);
    }
  }

  socket.on("turn_end_request", (d) => {
    const r = MATCHES[d.roomId];
    if(r) {
      r.turnIndex = (r.turnIndex + 1) % 2;
      r.turnId = uid(); r.actionUsed = false;
      io.to(r.id).emit("new_turn", { nextTurn: r.players[r.turnIndex], turnId: r.turnId });
    }
  });

  socket.on("disconnect", () => {
    delete SOCKET_USER_MAP[socket.id];
    io.emit("online_count", io.engine.clientsCount);
  });
});

// --------------------
// START
// --------------------
(async () => {
  await initStorage();

  const PORT = process.env.PORT || 3000;
  http.listen(PORT, () => console.log("Server Bafo v7 - Stable & Features (DB OK)"));
})();
