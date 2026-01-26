const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);
const path = require("path");
const fs = require("fs");

app.use(express.static(path.join(__dirname, ".")));

const DB_FILE = "db.json";
let DATABASE = { users: {}, market: [] };
const BOT_NAME = "LumiaBot";

if (fs.existsSync(DB_FILE)) {
  try {
    DATABASE = JSON.parse(fs.readFileSync(DB_FILE));
    if (!DATABASE.market) DATABASE.market = [];
  } catch (e) { saveDB(); }
} else { saveDB(); }

if (!DATABASE.users[BOT_NAME]) {
    DATABASE.users[BOT_NAME] = { username: BOT_NAME, coins: 999999, collection: [], isBot: true };
    saveDB();
}

function saveDB() { fs.writeFileSync(DB_FILE, JSON.stringify(DATABASE, null, 2)); }

const MATCHES = {};
const TRADES = {}; 
const SOCKET_USER_MAP = {};

function uid() { return Math.random().toString(36).slice(2, 10); }

// --- API ---
async function fetchRandomCard() {
    const sources = ['pokemon', 'mtg', 'lorcana'];
    const source = sources[Math.floor(Math.random() * sources.length)];
    let cardData = { name: "Carta", image: "https://via.placeholder.com/150", rarity: "common", source: "System" };

    try {
        if (source === 'pokemon') {
            const res = await fetch('https://api.pokemontcg.io/v2/cards?pageSize=1&page=' + Math.floor(Math.random() * 800));
            const data = await res.json();
            const c = data.data[0];
            if(c) cardData = { name: c.name, image: c.images.large || c.images.small, rarity: mapRarity(c.rarity), source: "Pokémon" };
        } 
        else if (source === 'mtg') {
            const res = await fetch('https://api.scryfall.com/cards/random');
            const c = await res.json();
            if(c) {
                const img = c.image_uris ? c.image_uris.normal : (c.card_faces ? c.card_faces[0].image_uris.normal : "");
                cardData = { name: c.name, image: img, rarity: mapRarity(c.rarity), source: "Magic" };
            }
        }
        else if (source === 'lorcana') {
             try {
                const res = await fetch('https://api.lorcana-api.com/cards/all'); 
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
      uid: uid(), name: data.name, image: data.image, rarity: data.rarity, source: data.source, originalOwner: ownerName, flipped: false,
  }));
}

// Bot Economy Loop
// --- Bot Market Buyer Loop ---
setInterval(() => {
  const bot = DATABASE.users[BOT_NAME];
  if (!bot) return;

  if (!DATABASE.market || DATABASE.market.length === 0) return;

  // Pega alguns itens aleatórios do mercado pra avaliar
  const sample = DATABASE.market
    .filter(m => m && m.seller !== BOT_NAME)
    .sort(() => Math.random() - 0.5)
    .slice(0, 5);

  // Bot compra no máximo 1 item por rodada
  for (const item of sample) {
    if (!item) continue;

    const price = item.price || 0;
    if (bot.coins < price) continue;

    if (!botShouldBuy(item)) continue;

    // Compra de verdade
    const idx = DATABASE.market.findIndex(m => m.listingId === item.listingId);
    if (idx === -1) continue;

    const buyItem = DATABASE.market[idx];

    // Segurança extra
    if (buyItem.seller === BOT_NAME) continue;
    if (bot.coins < buyItem.price) continue;

    bot.coins -= buyItem.price;
    bot.collection.push({ ...buyItem.card, originalOwner: BOT_NAME });

    // Paga o vendedor
    if (DATABASE.users[buyItem.seller]) {
      DATABASE.users[buyItem.seller].coins += buyItem.price;

      // Atualiza profile do vendedor se estiver online
      for (let sid in SOCKET_USER_MAP) {
        if (SOCKET_USER_MAP[sid] === buyItem.seller) {
          io.to(sid).emit("update_profile", DATABASE.users[buyItem.seller]);
        }
      }
    }

    // Remove do market
    DATABASE.market.splice(idx, 1);

    saveDB();
    io.emit("market_update", DATABASE.market);

    // Opcional: notificação global pra dar sensação de "mercado vivo"
    io.emit("notification", `🤖 ${BOT_NAME} comprou uma carta do mercado!`);

    break;
  }
}, 12000);


io.on("connection", (socket) => {
  socket.on("login", async (data) => {
    const { username } = data || {}; if (!username) return;
    let user = DATABASE.users[username];
    if (!user) {
      const starterDeck = await generateBooster(username, 6);
      user = { username, coins: 1000, collection: starterDeck, lastLogin: "" };
      DATABASE.users[username] = user;
    }
    const today = new Date().toDateString();
    if (user.lastLogin !== today) { user.coins += 2000; user.lastLogin = today; socket.emit("notification", "🎁 +2000 Moedas Diárias!"); }
    saveDB();
    SOCKET_USER_MAP[socket.id] = username;
    socket.emit("login_success", user);
    socket.emit("market_update", DATABASE.market);
  });

  socket.on("buy_booster", async () => {
      const username = SOCKET_USER_MAP[socket.id];
      const user = DATABASE.users[username];
      if(user.coins >= 500) {
          user.coins -= 500;
          socket.emit("notification", "Gerando pacote...");
          const newCards = await generateBooster(username, 3);
          user.collection.push(...newCards);
          saveDB();
          socket.emit("update_profile", user);
          socket.emit("booster_opened", newCards); 
      } else socket.emit("notification", "Sem moedas (500)!");
  });

  socket.on("create_match", async (selectedUIDs) => {
    const username = SOCKET_USER_MAP[socket.id];
    const userObj = DATABASE.users[username];
    const betCards = userObj.collection.filter(c => selectedUIDs.includes(c.uid));
    if (betCards.length !== selectedUIDs.length) return socket.emit("notification", "Erro nas cartas.");

    let room = null;
    for (const id in MATCHES) {
        const r = MATCHES[id];
        if (!r.started && r.players.length < 2 && r.betAmount === betCards.length && !r.isBotMatch) { room = r; break; }
    }

    if (!room) {
      const rid = "room_" + socket.id;
      MATCHES[rid] = {
        id: rid, players: [socket.id], usernames: [username], betAmount: betCards.length, pot: [...betCards], scores: { [username]: 0 }, started: false, isBotMatch: false
      };
      socket.join(rid);
      socket.emit("waiting_opponent");
      setTimeout(async () => {
          const r = MATCHES[rid];
          if (r && !r.started) {
              const botBet = await generateBooster(BOT_NAME, r.betAmount);
              r.players.push("BOT_ID"); r.usernames.push(BOT_NAME); r.pot.push(...botBet); r.scores[BOT_NAME] = 0; r.started = true; r.isBotMatch = true;
              startMatch(r);
          }
      }, 3000);
    } else {
      room.players.push(socket.id); room.usernames.push(username); room.pot.push(...betCards); room.scores[username] = 0; room.started = true;
      socket.join(room.id);
      startMatch(room);
    }
  });
  
  function botShouldBuy(item) {
  if (!item || !item.card) return false;

  // Não compra dele mesmo
  if (item.seller === BOT_NAME) return false;

  const price = item.price || 0;
  const rarity = item.card.rarity || "common";

  // Tabela de preço máximo por raridade (o bot aceita pagar até X)
  const maxByRarity = {
    common: 120,
    rare: 260,
    epic: 650,
    legend: 1500,
  };

  const max = maxByRarity[rarity] ?? 150;

  // Chance extra de compra (pra dar vida ao mercado)
  // Common é mais chato comprar, Legend é mais "desejo"
  const chanceByRarity = {
    common: 0.25,
    rare: 0.45,
    epic: 0.65,
    legend: 0.85,
  };
  const chance = chanceByRarity[rarity] ?? 0.4;

  // Se tá barato, compra sempre
  if (price <= max * 0.6) return true;

  // Se tá dentro do aceitável, compra por chance
  if (price <= max) return Math.random() < chance;

  return false;
}


  function startMatch(room) {
      room.pot.sort(() => Math.random() - 0.5);
      room.turnIndex = 0; room.turnId = uid();
      io.to(room.id).emit("game_start", { roomId: room.id, pot: room.pot, currentTurn: room.players[0], turnId: room.turnId, usernames: room.usernames });
  }

  socket.on("action_blow", (data) => {
    const room = MATCHES[data.roomId];
    if (room && !room.actionUsed) { room.actionUsed = true; io.to(room.id).emit("action_blow", data); }
  });

  socket.on("bot_play_trigger", (roomId) => {
      const room = MATCHES[roomId];
      if(room && room.isBotMatch && room.players[room.turnIndex] === "BOT_ID" && !room.actionUsed) {
          io.to(roomId).emit("bot_should_play", { turnId: room.turnId });
      }
  });

  socket.on("card_flip_claim", (data) => {
    const room = MATCHES[data.roomId];
    if (!room) return;
    const idx = room.pot.findIndex(c => c.uid === data.cardUID);
    if (idx === -1) return;
    const card = room.pot[idx]; room.pot.splice(idx, 1);
    
    let winnerId = data.winnerIsBot ? "BOT_ID" : socket.id;
    let winnerName = data.winnerIsBot ? BOT_NAME : SOCKET_USER_MAP[winnerId];
    room.scores[winnerName] = (room.scores[winnerName] || 0) + 1;

    const wUser = DATABASE.users[winnerName];
    if(wUser) wUser.collection.push({ ...card, originalOwner: winnerName });
    saveDB();
    if(winnerId !== "BOT_ID") socket.emit("update_profile", wUser);
    io.to(room.id).emit("card_won", { cardUID: card.uid, winnerId: winnerId });
    if (room.pot.length === 0) endGame(room);
  });

  function endGame(room) {
      const p1 = room.usernames[0]; const p2 = room.usernames[1];
      const s1 = room.scores[p1] || 0; const s2 = room.scores[p2] || 0;
      let msg = "Empate!";
      if (s1 > s2) { msg = `${p1} Venceu!`; addCoins(p1, 250); }
      else if (s2 > s1) { msg = `${p2} Venceu!`; addCoins(p2, 250); }
      else { addCoins(p1, 100); addCoins(p2, 100); }
      io.to(room.id).emit("game_over", { message: msg });
      delete MATCHES[room.id];
  }
  function addCoins(user, qtd) {
      if(DATABASE.users[user]) {
          DATABASE.users[user].coins += qtd;
          for(let id in SOCKET_USER_MAP) { if(SOCKET_USER_MAP[id] === user) io.to(id).emit("update_profile", DATABASE.users[user]); }
      } saveDB();
  }

  socket.on("turn_end_request", (data) => {
      const room = MATCHES[data.roomId];
      if (room) {
          room.turnIndex = (room.turnIndex + 1) % 2; room.turnId = uid(); room.actionUsed = false;
          io.to(room.id).emit("new_turn", { nextTurn: room.players[room.turnIndex], turnId: room.turnId });
      }
  });

  // --- TRADE SYSTEM RESTAURADO ---
  socket.on("trade_create", () => {
      const username = SOCKET_USER_MAP[socket.id];
      const tid = "trade_" + uid();
      TRADES[tid] = { id: tid, p1: socket.id, p1Name: username, p2: null, p2Name: null, offer1: null, offer2: null, status: "waiting", p1Confirm: false, p2Confirm: false };
      socket.join(tid);
      socket.emit("trade_created", tid);
  });
  socket.on("trade_join", (tid) => {
      const trade = TRADES[tid];
      if (trade && !trade.p2) {
          trade.p2 = socket.id; trade.p2Name = SOCKET_USER_MAP[socket.id]; trade.status = "active";
          socket.join(tid); io.to(tid).emit("trade_joined", { p1: trade.p1Name, p2: trade.p2Name });
      } else socket.emit("notification", "Sala cheia/inexistente.");
  });
  socket.on("trade_offer", (data) => {
      const trade = TRADES[data.tradeId]; if (!trade) return;
      const username = SOCKET_USER_MAP[socket.id];
      const user = DATABASE.users[username];
      const card = user.collection.find(c => c.uid === data.cardUID);
      if (socket.id === trade.p1) { trade.offer1 = card; trade.p1Confirm = false; trade.p2Confirm = false; }
      else if (socket.id === trade.p2) { trade.offer2 = card; trade.p1Confirm = false; trade.p2Confirm = false; }
      io.to(data.tradeId).emit("trade_updated", { offer1: trade.offer1, offer2: trade.offer2 });
  });
  socket.on("trade_confirm", (tradeId) => {
      const trade = TRADES[tradeId]; if(!trade) return;
      if(socket.id === trade.p1) trade.p1Confirm = true;
      if(socket.id === trade.p2) trade.p2Confirm = true;

      // Se ambos confirmaram e tem ofertas na mesa
      if (trade.p1Confirm && trade.p2Confirm && trade.offer1 && trade.offer2) {
          const u1 = DATABASE.users[trade.p1Name]; 
          const u2 = DATABASE.users[trade.p2Name];

          // Verifica se as cartas ainda existem
          const c1Idx = u1.collection.findIndex(c => c.uid === trade.offer1.uid);
          const c2Idx = u2.collection.findIndex(c => c.uid === trade.offer2.uid);

          if (c1Idx > -1 && c2Idx > -1) {
              const c1 = u1.collection.splice(c1Idx, 1)[0];
              const c2 = u2.collection.splice(c2Idx, 1)[0];

              c1.originalOwner = trade.p2Name;
              c2.originalOwner = trade.p1Name;

              u1.collection.push(c2);
              u2.collection.push(c1);

              saveDB();

              // Atualiza os clients
              if(SOCKET_USER_MAP[trade.p1]) {
                  const s1 = io.sockets.sockets.get(trade.p1);
                  if(s1) s1.emit("update_profile", u1);
              }
              if(SOCKET_USER_MAP[trade.p2]) {
                  const s2 = io.sockets.sockets.get(trade.p2);
                  if(s2) s2.emit("update_profile", u2);
              }

              io.to(trade.id).emit("trade_completed");
              delete TRADES[tradeId];
          } else {
              io.to(trade.id).emit("notification", "Erro: Carta não existe mais.");
          }
      }
  });

  socket.on("market_sell", (d) => {
      const u = DATABASE.users[SOCKET_USER_MAP[socket.id]];
      const idx = u.collection.findIndex(c=>c.uid===d.cardUID);
      if(idx>-1) {
          const card = u.collection.splice(idx,1)[0];
          DATABASE.market.push({listingId:uid(), seller:u.username, card, price:d.price});
          saveDB();
          socket.emit("update_profile", u);
          io.emit("market_update", DATABASE.market);
      }
  });
  
  socket.on("market_buy", (listingId) => {
      const buyerName = SOCKET_USER_MAP[socket.id];
      const buyer = DATABASE.users[buyerName];
      const idx = DATABASE.market.findIndex(m=>m.listingId===listingId);
      if(idx>-1 && buyer.coins >= DATABASE.market[idx].price) {
          const item = DATABASE.market[idx];
          buyer.coins -= item.price;
          buyer.collection.push(item.card);
          DATABASE.market.splice(idx,1);
          if(DATABASE.users[item.seller]) DATABASE.users[item.seller].coins += item.price;
          saveDB();
          socket.emit("update_profile", buyer);
          io.emit("market_update", DATABASE.market);
          socket.emit("notification", "Compra realizada!");
      }
  });

  socket.on("disconnect", () => delete SOCKET_USER_MAP[socket.id]);
});

http.listen(3000, () => console.log("Server Bafo v6 - Full Trade & Visuals"));