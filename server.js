const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);
const path = require("path");
const fs = require("fs");

const fetchFn = global.fetch ? global.fetch : (...args) => import("node-fetch").then(({default: fetch}) => fetch(...args));

app.use(express.static(path.join(__dirname, ".")));

const DB_FILE = "db.json";
let DATABASE = { users: {}, market: [] };
const BOT_NAME = "LumiaBot";

// DB Init
if (fs.existsSync(DB_FILE)) {
  try {
    DATABASE = JSON.parse(fs.readFileSync(DB_FILE));
    if (!DATABASE.market) DATABASE.market = [];
    if (!DATABASE.users) DATABASE.users = {};
  } catch (e) { saveDB(); }
} else { saveDB(); }

if (!DATABASE.users[BOT_NAME]) {
    DATABASE.users[BOT_NAME] = { 
        username: BOT_NAME, gold: 999999, mana: 999999, essence: 999999, collection: [], isBot: true, wins: 0 
    };
    saveDB();
}

function saveDB() { try { fs.writeFileSync(DB_FILE, JSON.stringify(DATABASE, null, 2)); } catch(e) { console.error(e); } }

const MATCHES = {};
const TRADES = {}; 
const SOCKET_USER_MAP = {};
let LORCANA_CACHE = null;
let LORCANA_CACHE_TIME = 0;

async function getLorcanaAllCached() {
    const now = Date.now();
    if (LORCANA_CACHE && (now - LORCANA_CACHE_TIME) < 60 * 60 * 1000) return LORCANA_CACHE;

    try {
        const res = await fetchWithTimeout("https://api.lorcana-api.com/cards/all", 3500);
        const all = await res.json();
        if (Array.isArray(all) && all.length > 0) {
            LORCANA_CACHE = all;
            LORCANA_CACHE_TIME = now;
            return all;
        }
    } catch (e) {}

    return LORCANA_CACHE || [];
}


function uid() { return Math.random().toString(36).slice(2, 10); }
async function fetchWithTimeout(url, ms = 2500) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
        const res = await fetchFn(url, { signal: ctrl.signal });
        clearTimeout(t);
        return res;
    } catch (e) {
        clearTimeout(t);
        throw e;
    }
}

// --- API ---
async function fetchRandomCard(forcedSource) {
    const sources = ['pokemon', 'mtg', 'lorcana'];
    const source = forcedSource || sources[Math.floor(Math.random() * sources.length)];
    let cardData = { name: "Carta", image: "/assets/placeholder.png", rarity: "common", source: "System" };

    try {
        if (source === 'pokemon') {
            const res = await fetchFn('https://api.pokemontcg.io/v2/cards?pageSize=1&page=' + Math.floor(Math.random() * 800));
            const data = await res.json();
            if(data.data && data.data[0]) {
                const c = data.data[0];
                cardData = { name: c.name, image: c.images.large || c.images.small, rarity: mapRarity(c.rarity), source: "Pokémon" };
            }
        } else if (source === 'mtg') {
            const res = await fetchFn('https://api.scryfall.com/cards/random');
            const c = await res.json();
            const img = c.image_uris ? c.image_uris.normal : (c.card_faces ? c.card_faces[0].image_uris.normal : "");
            if(img) cardData = { name: c.name, image: img, rarity: mapRarity(c.rarity), source: "Magic" };
        } else if (source === 'lorcana') {
             try {
                const all = await getLorcanaAllCached();

                if(all.length > 0) {
                    const c = all[Math.floor(Math.random() * all.length)];
                    cardData = { name: c.Name, image: c.Image, rarity: mapRarity(c.Rarity), source: "Lorcana" };
                }
            } catch(e){}
        }
    } catch (e) {}
    return cardData;
}

function mapRarity(raw) {
    if(!raw) return "common";
    const r = String(raw).toLowerCase();
    if (r.includes('rare') || r.includes('holo')) return 'rare';
    if (r.includes('ultra') || r.includes('mythic') || r.includes('secret')) return 'epic';
    if (r.includes('legend') || r.includes('enchanted')) return 'legend';
    return 'common';
}

async function generateBooster(ownerName, weights) {
    const w = weights || { pokemon: 33, magic: 33, lorcana: 33 };

    function pickSource() {
        const total = (w.pokemon + w.magic + w.lorcana);
        const rand = Math.random() * total;

        let source = 'pokemon';
        if (rand < w.pokemon) source = 'pokemon';
        else if (rand < w.pokemon + w.magic) source = 'mtg';
        else source = 'lorcana';

        // "chato": nunca 100% garantido
        if (Math.random() < 0.15) {
            source = ['pokemon','mtg','lorcana'][Math.floor(Math.random() * 3)];
        }
        return source;
    }

    const tasks = [];
    for (let i = 0; i < 3; i++) {
        const source = pickSource();
        tasks.push(fetchRandomCard(source));
    }

    const results = await Promise.all(tasks);

    return results.map(data => ({
        uid: uid(),
        name: data.name,
        image: data.image,
        rarity: data.rarity,
        source: data.source,
        originalOwner: ownerName,
        flipped: false
    }));
}


// --- BOT LOGIC ---
setInterval(async () => {
    try {
        const bot = DATABASE.users[BOT_NAME];
        if(!bot) return;
        if (bot.collection.length > 30 && Math.random() < 0.2) {
            const c = bot.collection.splice(0, 1)[0];
            DATABASE.market.push({ listingId: uid(), seller: BOT_NAME, card: c, price: Math.floor(Math.random()*300)+50 });
            io.emit("market_update", DATABASE.market);
            saveDB();
        }
        if (bot.collection.length < 10) {
            const pack = await generateBooster(BOT_NAME, { pokemon:100, magic:100, lorcana:100 });
            bot.collection.push(...pack);
        }
    } catch(e){}
}, 10000);

io.on("connection", (socket) => {
    const onlineCount = io.engine.clientsCount;
    io.emit("online_count", onlineCount);

    socket.on("login", async (data) => {
        const { username } = data || {}; if(!username) return;
        let user = DATABASE.users[username];
        if(!user) {
            const deck = await generateBooster(username, {pokemon:100,magic:100,lorcana:100}); 
            const deck2 = await generateBooster(username, {pokemon:100,magic:100,lorcana:100});
            user = { username, gold: 1000, mana: 1000, essence: 1000, collection: [...deck, ...deck2], lastLogin: "", wins: 0 };
            DATABASE.users[username] = user;
        }
        
        const today = new Date().toDateString();
        if (user.lastLogin !== today) { 
            user.gold = (user.gold||0) + 1000; 
            user.mana = (user.mana||0) + 1000; 
            user.essence = (user.essence||0) + 1000; 
            user.lastLogin = today; 
            socket.emit("notification", "🎁 +1000 de Tudo (Diário)!");
        }
        
        SOCKET_USER_MAP[socket.id] = username;
        saveDB();
        socket.emit("login_success", user);
        socket.emit("market_update", DATABASE.market);
    });

    socket.on("currency_swap", (data) => {
        const u = DATABASE.users[SOCKET_USER_MAP[socket.id]];
        if(!u) return;
        const amount = parseInt(data.amount);
        if(isNaN(amount) || amount <= 0) return socket.emit("notification", "Valor inválido.");
        if ((u[data.from] || 0) < amount) return socket.emit("notification", `Sem ${data.from} suficiente!`);
        u[data.from] -= amount;
        u[data.to] = (u[data.to] || 0) + amount;
        saveDB();
        socket.emit("update_profile", u);
        socket.emit("notification", "Troca realizada!");
    });

    socket.on("buy_booster_multiverse", async (payment) => {
        const u = DATABASE.users[SOCKET_USER_MAP[socket.id]];
        const total = (payment.gold||0) + (payment.mana||0) + (payment.essence||0);
        if (total !== 500) return socket.emit("notification", "O custo total deve ser 500!");
        
        if (u.gold >= payment.gold && u.mana >= payment.mana && u.essence >= payment.essence) {
            u.gold -= payment.gold; u.mana -= payment.mana; u.essence -= payment.essence;
            const weights = { pokemon: payment.gold, magic: payment.mana, lorcana: payment.essence };
            
            // O cliente vai mostrar a animação de loading enquanto isso processa
            const cards = await generateBooster(u.username, weights);
            u.collection.push(...cards);
            saveDB();
            
            socket.emit("update_profile", u);
            socket.emit("booster_opened", cards); 
        } else {
            socket.emit("notification", "Recursos insuficientes!");
        }
    });

    socket.on("chat_send", (msg) => {
        const u = SOCKET_USER_MAP[socket.id];
        if(u && msg) io.emit("chat_message", { user: u, text: msg.substring(0, 100) });
    });

    // --- MATCH (SMART BOT JOIN) ---
    socket.on("create_match", async (selectedUIDs) => {
        const username = SOCKET_USER_MAP[socket.id];
        const user = DATABASE.users[username];
        if (!user) return;

        const betCards = selectedUIDs.map(id => user.collection.find(c => c.uid === id)).filter(Boolean);

        if (betCards.length !== selectedUIDs.length) {
            socket.emit("update_profile", user);
            return socket.emit("notification", "Erro: Sincronize a coleção.");
        }

        let room = null;
        for (const id in MATCHES) {
            const r = MATCHES[id];
            if (!r.started && r.players.length < 2 && !r.isBotMatch && r.betAmount === betCards.length) { room = r; break; }
        }

        if (!room) {
            const rid = "room_" + uid();
            MATCHES[rid] = {
                id: rid, players: [socket.id], usernames: [username],
                betAmount: betCards.length, pot: [...betCards], scores: {[username]:0},
                started: false, isBotMatch: false, createdAt: Date.now()
            };
            socket.join(rid);
            socket.emit("waiting_opponent");
            
            // LÓGICA INTELIGENTE DO BOT
// ✅ BOT CONSTANTE: entra rápido quando a fila está vazia
const waitTime = 800; // <1s SEMPRE

setTimeout(async () => {
    const r = MATCHES[rid];
    if (!r || r.started) return;

    // entrou um player humano? cancela bot
    if (r.players.length >= 2) return;

    // ✅ prioridade total: poucos jogadores = bot sempre entra
    const online = io.engine.clientsCount;
    const mustFill = (online <= 3); // até 3 online, bot garante jogo
    if (!mustFill) {
        // se tem bastante gente online, dá uma chance de PVP
        if (Math.random() > 0.30) return;
    }

    // ✅ não depender de API lenta pra não travar fila:
    // gera cartas de forma leve (reaproveitando cartas do bot, ou fallback rápido)
    let botBet = [];

    // usa cartas do bot primeiro (instantâneo)
    const botUser = DATABASE.users[BOT_NAME];
    while (botUser.collection.length < r.betAmount) {
        // se não tiver estoque, gera booster (pode demorar, mas só quando falta)
        const pack = await generateBooster(BOT_NAME, { pokemon:150, magic:150, lorcana:150 });
        botUser.collection.push(...pack);
    }

    botBet = botUser.collection.splice(0, r.betAmount);

    r.players.push("BOT_ID");
    r.usernames.push(BOT_NAME);
    r.pot.push(...botBet);
    r.scores[BOT_NAME] = 0;
    r.started = true;
    r.isBotMatch = true;

    startMatch(r);

}, waitTime);

        } else {
            room.players.push(socket.id); room.usernames.push(username);
            room.pot.push(...betCards); room.scores[username] = 0;
            room.started = true;
            socket.join(room.id);
            startMatch(room);
        }
    });

    function startMatch(r) {
        r.pot.sort(() => Math.random() - 0.5);
        r.turnIndex = 0; r.turnId = uid();
        io.to(r.id).emit("game_start", { roomId: r.id, pot: r.pot, currentTurn: r.players[0], turnId: r.turnId, usernames: r.usernames });
    }

    socket.on("action_blow", (d) => {
        const r = MATCHES[d.roomId];
        if(r && !r.actionUsed) { r.actionUsed = true; io.to(d.roomId).emit("action_blow", d); }
    });

    socket.on("bot_play_trigger", (rid) => {
        const r = MATCHES[rid];
        if(r && r.isBotMatch && r.players[r.turnIndex] === "BOT_ID" && !r.actionUsed) {
            io.to(rid).emit("bot_should_play", { turnId: r.turnId });
        }
    });

    socket.on("card_flip_claim", (d) => {
        const r = MATCHES[d.roomId];
        if(!r) return;
        const idx = r.pot.findIndex(c => c.uid === d.cardUID);
        if(idx === -1) return;

        const card = r.pot[idx];
        r.pot.splice(idx, 1);

        const winnerId = d.winnerIsBot ? "BOT_ID" : socket.id;
        const winnerName = d.winnerIsBot ? BOT_NAME : SOCKET_USER_MAP[winnerId];
        r.scores[winnerName] = (r.scores[winnerName] || 0) + 1;

        const winner = DATABASE.users[winnerName];
        const loser = DATABASE.users[card.originalOwner];

        if(loser) {
            const lIdx = loser.collection.findIndex(c => c.uid === card.uid);
            if(lIdx > -1) loser.collection.splice(lIdx, 1);
        }
        if(winner) {
            winner.collection.push({ ...card, originalOwner: winnerName, flipped: false });
        }
        saveDB();

        if(!d.winnerIsBot) socket.emit("update_profile", winner);
        if(loser && !d.winnerIsBot && card.originalOwner !== BOT_NAME) {
             const lSid = Object.keys(SOCKET_USER_MAP).find(k => SOCKET_USER_MAP[k] === card.originalOwner);
             if(lSid) io.to(lSid).emit("update_profile", loser);
        }

        io.to(r.id).emit("card_won", { cardUID: card.uid, winnerId });

        if(r.pot.length === 0) endGame(r);
    });

    function endGame(r) {
        const p1 = r.usernames[0]; const p2 = r.usernames[1];
        const s1 = r.scores[p1]||0; const s2 = r.scores[p2]||0;
        let msg = "Empate!";
        if(s1 > s2) { msg = `${p1} Venceu!`; addReward(p1, 100); } 
        else if(s2 > s1) { msg = `${p2} Venceu!`; addReward(p2, 100); } 
        else { msg = "Empate! (+50)"; addReward(p1, 50); addReward(p2, 50); }
        io.to(r.id).emit("game_over", { message: msg });
        delete MATCHES[r.id];
    }

    function addReward(uName, qtd) {
        if(DATABASE.users[uName]) {
            DATABASE.users[uName].gold = (DATABASE.users[uName].gold||0) + qtd;
            DATABASE.users[uName].mana = (DATABASE.users[uName].mana||0) + qtd;
            DATABASE.users[uName].essence = (DATABASE.users[uName].essence||0) + qtd;
            if(qtd >= 100) DATABASE.users[uName].wins = (DATABASE.users[uName].wins||0) + 1;
            saveDB();
            const sid = Object.keys(SOCKET_USER_MAP).find(k => SOCKET_USER_MAP[k] === uName);
            if(sid) {
                io.to(sid).emit("update_profile", DATABASE.users[uName]);
                io.to(sid).emit("notification", `Ganhou +${qtd} moedas!`);
            }
        }
    }

    socket.on("turn_end_request", (d) => {
        const r = MATCHES[d.roomId];
        if(r) {
            r.turnIndex = (r.turnIndex + 1) % 2; r.turnId = uid(); r.actionUsed = false;
            io.to(r.id).emit("new_turn", { nextTurn: r.players[r.turnIndex], turnId: r.turnId });
        }
    });

    socket.on("market_sell", (d) => {
        const u = DATABASE.users[SOCKET_USER_MAP[socket.id]];
        const idx = u.collection.findIndex(c => c.uid === d.cardUID);
        if(idx > -1) {
            const c = u.collection.splice(idx, 1)[0];
            DATABASE.market.push({ listingId: uid(), seller: u.username, card: c, price: d.price });
            saveDB();
            socket.emit("update_profile", u);
            io.emit("market_update", DATABASE.market);
        }
    });
    socket.on("market_buy", (lid) => {
        const buyer = DATABASE.users[SOCKET_USER_MAP[socket.id]];
        const idx = DATABASE.market.findIndex(m => m.listingId === lid);
        if(idx > -1 && (buyer.gold||0) >= DATABASE.market[idx].price) {
            const item = DATABASE.market[idx];
            buyer.gold -= item.price;
            buyer.collection.push(item.card);
            if(DATABASE.users[item.seller]) DATABASE.users[item.seller].gold = (DATABASE.users[item.seller].gold||0) + item.price;
            DATABASE.market.splice(idx, 1);
            saveDB();
            socket.emit("update_profile", buyer);
            io.emit("market_update", DATABASE.market);
        }
    });

    socket.on("get_ranking", () => {
        const sorted = Object.values(DATABASE.users).filter(u=>!u.isBot).sort((a,b)=>(b.gold||0)-(a.gold||0)).slice(0,10);
        socket.emit("ranking_data", sorted);
    });

    socket.on("trade_create", () => { const tid = "t_"+uid(); TRADES[tid]={id:tid,p1:socket.id,p1Name:SOCKET_USER_MAP[socket.id],p2:null}; socket.join(tid); socket.emit("trade_created",tid); });
    socket.on("trade_join", (tid) => { const t=TRADES[tid]; if(t&&!t.p2){t.p2=socket.id;t.p2Name=SOCKET_USER_MAP[socket.id];socket.join(tid);io.to(tid).emit("trade_joined",{p1:t.p1Name,p2:t.p2Name});} });
    socket.on("trade_offer", (d) => { 
        const t=TRADES[d.tradeId]; const u=DATABASE.users[SOCKET_USER_MAP[socket.id]]; const c=u.collection.find(x=>x.uid===d.cardUID);
        if(socket.id===t.p1) { t.o1=c; t.c1=false; } else { t.o2=c; t.c2=false; }
        io.to(d.tradeId).emit("trade_updated", {o1:t.o1, o2:t.o2});
    });
    socket.on("trade_confirm", (tid) => {
        const t=TRADES[tid]; if(socket.id===t.p1) t.c1=true; else t.c2=true;
        if(t.c1 && t.c2 && t.o1 && t.o2) {
            const u1=DATABASE.users[t.p1Name]; const u2=DATABASE.users[t.p2Name];
            const i1=u1.collection.findIndex(x=>x.uid===t.o1.uid); const i2=u2.collection.findIndex(x=>x.uid===t.o2.uid);
            if(i1>-1 && i2>-1) {
                const c1=u1.collection.splice(i1,1)[0]; const c2=u2.collection.splice(i2,1)[0];
                c1.originalOwner=t.p2Name; c2.originalOwner=t.p1Name;
                u1.collection.push(c2); u2.collection.push(c1);
                saveDB();
                io.to(t.p1).emit("update_profile", u1); io.to(t.p2).emit("update_profile", u2);
                io.to(tid).emit("trade_completed"); delete TRADES[tid];
            }
        }
    });

    socket.on("disconnect", () => { delete SOCKET_USER_MAP[socket.id]; io.emit("online_count", io.engine.clientsCount); });
});

http.listen(3000, () => console.log("Server Bafo v13 - Turbo Pack & Smart Bot"));