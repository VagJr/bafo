const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);
const path = require("path");
const fs = require("fs");

app.use(express.static(path.join(__dirname, ".")));

const DB_FILE = "db.json";
let DATABASE = { users: {}, market: [] };

if (fs.existsSync(DB_FILE)) {
  try {
    DATABASE = JSON.parse(fs.readFileSync(DB_FILE));
    if (!DATABASE.market) DATABASE.market = [];
  } catch (e) {
    saveDB();
  }
} else {
  saveDB();
}

function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(DATABASE, null, 2));
}

const MATCHES = {};
const SOCKET_USER_MAP = {};
const ALLOWED_BETS = [1, 3, 5];

function uid() { return Math.random().toString(36).slice(2, 10); }
function coinFlip() { return Math.random() < 0.5 ? 0 : 1; }

// --- MULTIVERSO (SEM YU-GI-OH) ---
async function fetchRandomCard() {
    const sources = ['pokemon', 'mtg', 'lorcana'];
    const source = sources[Math.floor(Math.random() * sources.length)];
    
    let cardData = { name: "Carta Misteriosa", image: "", rarity: "common", source: "Unknown" };

    try {
        if (source === 'pokemon') {
            const res = await fetch('https://api.pokemontcg.io/v2/cards?pageSize=1&page=' + Math.floor(Math.random() * 800));
            const data = await res.json();
            const c = data.data[0];
            if(c) {
                cardData.name = c.name;
                cardData.image = c.images.large || c.images.small;
                cardData.rarity = mapRarity(c.rarity);
                cardData.source = "Pokémon";
            }
        } 
        else if (source === 'mtg') {
            const res = await fetch('https://api.scryfall.com/cards/random');
            const c = await res.json();
            if(c) {
                cardData.name = c.name;
                cardData.image = c.image_uris ? c.image_uris.normal : (c.card_faces ? c.card_faces[0].image_uris.normal : "");
                cardData.rarity = mapRarity(c.rarity);
                cardData.source = "Magic";
            }
        }
        else if (source === 'lorcana') {
            // Tentativa de pegar carta aleatória via paginação simulada ou endpoint de sets
            // Como a API Lorcana é instável, usamos fallback seguro
            try {
                const res = await fetch('https://api.lorcana-api.com/cards/all'); 
                const all = await res.json();
                if(all && all.length > 0) {
                    const c = all[Math.floor(Math.random() * all.length)];
                    cardData.name = c.Name;
                    cardData.image = c.Image;
                    cardData.rarity = mapRarity(c.Rarity);
                    cardData.source = "Lorcana";
                }
            } catch(e) { throw e; }
        }
    } catch (err) {
        console.error(`Erro na API ${source}:`, err.message);
        cardData = { name: "Glitch Card", image: "https://via.placeholder.com/300x400?text=Error", rarity: "common", source: "System" };
    }

    if(!cardData.image || cardData.image === "") cardData.image = "https://via.placeholder.com/300x400?text=No+Image";
    return cardData;
}

function mapRarity(rawRarity) {
    if(!rawRarity) return "common";
    const r = String(rawRarity).toLowerCase();
    if (r.includes('common') || r.includes('land')) return 'common';
    if (r.includes('uncommon')) return 'common'; 
    if (r.includes('rare') || r.includes('holo') || r.includes('super')) return 'rare';
    if (r.includes('ultra') || r.includes('mythic') || r.includes('vmax') || r.includes('secret')) return 'epic';
    if (r.includes('legend') || r.includes('enchanted') || r.includes('shining')) return 'legend';
    return 'common';
}

async function generateBooster(ownerName, count) {
  const cards = [];
  for (let i = 0; i < count; i++) {
    const data = await fetchRandomCard();
    cards.push({
      uid: uid(),
      name: data.name,
      image: data.image,
      rarity: data.rarity,
      source: data.source,
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
  
  socket.on("login", async (data) => {
    const { username } = data || {};
    if (!username) return;

    let user = DATABASE.users[username];
    if (!user) {
      const starterDeck = await generateBooster(username, 6);
      user = { username, coins: 1000, collection: starterDeck };
      DATABASE.users[username] = user;
      saveDB();
    }
    SOCKET_USER_MAP[socket.id] = username;
    socket.emit("login_success", user);
    socket.emit("market_update", DATABASE.market);
  });

  socket.on("buy_booster", async () => {
      const username = SOCKET_USER_MAP[socket.id];
      const user = DATABASE.users[username];
      const cost = 500;

      if(user.coins >= cost) {
          user.coins -= cost;
          const newCards = await generateBooster(username, 3);
          user.collection.push(...newCards);
          saveDB();
          socket.emit("update_profile", user);
          socket.emit("booster_opened", newCards); 
      } else {
          socket.emit("notification", "Moedas insuficientes!");
      }
  });

  // --- MERCADO ---
  socket.on("market_sell", (data) => {
      const username = SOCKET_USER_MAP[socket.id];
      const user = DATABASE.users[username];
      const price = parseInt(data.price);
      if(!user || isNaN(price) || price < 0) return;

      const idx = user.collection.findIndex(c => c.uid === data.cardUID);
      if(idx > -1) {
          const card = user.collection.splice(idx, 1)[0]; // Remove do inventário
          DATABASE.market.push({ 
              listingId: uid(), 
              seller: username, 
              card: card, 
              price: price, 
              timestamp: Date.now() 
          });
          saveDB();
          socket.emit("update_profile", user); // Atualiza quem vendeu
          io.emit("market_update", DATABASE.market); // Atualiza loja de todos
          socket.emit("notification", "Carta enviada ao mercado!");
      }
  });

  socket.on("market_buy", (listingId) => {
      const buyerName = SOCKET_USER_MAP[socket.id];
      const buyer = DATABASE.users[buyerName];
      
      const listingIdx = DATABASE.market.findIndex(m => m.listingId === listingId);
      if(listingIdx === -1) return socket.emit("notification", "Oferta já foi vendida.");

      const listing = DATABASE.market[listingIdx];
      if(listing.seller === buyerName) return socket.emit("notification", "Você não pode comprar sua própria carta.");

      if(buyer.coins >= listing.price) {
          // 1. Desconta dinheiro
          buyer.coins -= listing.price;
          
          // 2. Paga vendedor
          const seller = DATABASE.users[listing.seller];
          if(seller) seller.coins += listing.price;

          // 3. Transfere carta
          const card = listing.card;
          card.originalOwner = buyerName;
          buyer.collection.push(card);

          // 4. Remove do mercado
          DATABASE.market.splice(listingIdx, 1);
          saveDB();

          // 5. Notificações
          socket.emit("update_profile", buyer);
          socket.emit("notification", `Comprou ${card.name}!`);
          
          // Se o vendedor estiver online, poderia receber update, 
          // mas simplificamos atualizando só quando ele fizer ação ou relogar.
          // O importante é o broadcast do mercado:
          io.emit("market_update", DATABASE.market);
      } else {
          socket.emit("notification", "Moedas insuficientes.");
      }
  });

  // --- JOGO ---
  socket.on("create_match", (selectedUIDs) => {
      const username = SOCKET_USER_MAP[socket.id];
      if (!username) return;
      if (!ALLOWED_BETS.includes(selectedUIDs.length)) return socket.emit("notification", "Apostas: 1, 3 ou 5!");
      
      const userObj = DATABASE.users[username];
      // Garante que carta nao ta no mercado
      const betCards = userObj.collection.filter(c => selectedUIDs.includes(c.uid));
      if (betCards.length !== selectedUIDs.length) return socket.emit("notification", "Erro: Cartas inválidas ou em uso.");

      const room = findRoomToJoin(betCards.length);
      if (!room) {
        const rid = "room_" + socket.id;
        MATCHES[rid] = { id: rid, players: [socket.id], usernames: [username], betAmount: betCards.length, pot: [...betCards], started: false, turnIndex: 0, turnId: null, actionUsed: false };
        socket.join(rid);
        socket.emit("waiting_opponent");
      } else {
        room.players.push(socket.id); room.usernames.push(username); room.pot.push(...betCards); room.started = true;
        socket.join(room.id); 
        room.pot.sort(() => Math.random() - 0.5);
        const starter = coinFlip(); room.turnIndex = starter; room.turnId = uid(); room.actionUsed = false;
        io.to(room.id).emit("game_start", { roomId: room.id, pot: room.pot, currentTurn: room.players[starter], turnId: room.turnId });
      }
  });

  socket.on("action_blow", (data) => {
    const room = MATCHES[data.roomId];
    if (room && room.players[room.turnIndex] === socket.id && !room.actionUsed) {
        room.actionUsed = true;
        io.to(room.id).emit("action_blow", data);
    }
  });

  socket.on("card_flip_claim", (data) => {
    const room = MATCHES[data.roomId];
    if (!room) return;
    const idx = room.pot.findIndex(c => c.uid === data.cardUID);
    if (idx === -1) return; 
    
    const card = room.pot[idx]; room.pot.splice(idx, 1);
    
    const winnerName = SOCKET_USER_MAP[socket.id];
    const winnerUser = DATABASE.users[winnerName];
    const loserUser = DATABASE.users[card.originalOwner];
    
    if (loserUser) { const lIdx = loserUser.collection.findIndex(c => c.uid === card.uid); if (lIdx > -1) loserUser.collection.splice(lIdx, 1); }
    if (winnerUser) { winnerUser.collection.push({ ...card, originalOwner: winnerName, flipped: false }); socket.emit("update_profile", winnerUser); }
    
    saveDB();
    io.to(room.id).emit("card_won", { cardUID: card.uid, winnerId: socket.id });
    
    if (room.pot.length === 0) { 
        io.to(room.id).emit("game_over", { message: "Fim de Jogo!" }); 
        delete MATCHES[room.id]; 
    }
  });

  socket.on("turn_end_request", (data) => {
      const room = MATCHES[data.roomId];
      if (room && room.players[room.turnIndex] === socket.id) {
          room.turnIndex = (room.turnIndex + 1) % 2; room.turnId = uid(); room.actionUsed = false;
          io.to(room.id).emit("new_turn", { nextTurn: room.players[room.turnIndex], turnId: room.turnId });
      }
  });
  
  socket.on("disconnect", () => delete SOCKET_USER_MAP[socket.id]);
});

http.listen(3000, () => console.log("Server Bafo v3 - 3000"));