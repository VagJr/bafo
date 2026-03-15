const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);
const path = require("path");
const fs = require("fs");

// Helper para import dinâmico do node-fetch
const fetchFn = global.fetch ? global.fetch : (...args) => import("node-fetch").then(({default: fetch}) => fetch(...args));

app.use(express.static(path.join(__dirname, ".")));

// --- CONFIGURAÇÃO DB ---
const DB_FILE = process.env.FLY_APP_NAME ? "/data/db.json" : "db.json";
if (DB_FILE.startsWith("/data")) { try { fs.mkdirSync("/data", { recursive: true }); } catch (e) {} }

// --- CONSTANTES DE JOGO & SETS (LÓGICA DE EDIÇÕES) ---
const SET_CONFIG = {
    'Magic': { 
        code: 'MTG', 
        editions: ['Alpha', 'Beta', 'Unlimited', 'Arabian Nights', 'Modern Age'] 
    },
    'Pokemon': { 
        code: 'PKM', 
        editions: ['Base Set', 'Jungle', 'Fossil', 'Team Rocket', 'Neo Genesis'] 
    },
    'Lorcana': { 
        code: 'LOR', 
        editions: ['First Chapter', 'Rise of Floodborn', 'Into Inklands', 'Ursula Return', 'Shimmering Skies'] 
    },
    'System': { code: 'SYS', editions: ['Core'] }
};

// Estado Global
let DATABASE = { 
    users: {}, 
    market: [], 
    marketIndex: 1.0, 
    marketTrend: 'neutral', 
    cycleStage: 0,
    priceHistory: {}, // Histórico de preços para Smart Pricing
    globalGoals: {    // Metas Comunitárias
        active: { type: 'market_volume', target: 50000, current: 0, desc: "Comerciante: Movimentem 50k Gold no Mercado", reward: "booster_gold" },
        lastCompleted: 0
    }
};

const BOT_NAME = "LumiaBot";
const RARITY_WEIGHTS = { 'common': 1, 'rare': 3, 'epic': 5, 'legend': 10 };

// Ciclos de Mercado para o Bot
const MARKET_CYCLES = ['accumulation', 'bull', 'distribution', 'bear', 'crash'];
const XP_TABLE = {
    base: 100,
    factor: 1.5 
};

const RARITY_XP = {
    'common': 10,
    'rare': 50,
    'epic': 200,
    'legend': 1000 
};

// --- LUMIA CORE: LÓGICA DE PROGRESSÃO ---
const LumiaCore = {
    getNextLevelXp: (level) => Math.floor(XP_TABLE.base * Math.pow(level, 1.2)),

    addXP: (user, amount, source, socket) => {
        if (!user.xp) user.xp = 0;
        if (!user.level) user.level = 1;
        
        user.xp += amount;
        let nextLvl = LumiaCore.getNextLevelXp(user.level);
        let leveledUp = false;

        while (user.xp >= nextLvl) {
            user.xp -= nextLvl;
            user.level++;
            leveledUp = true;
            nextLvl = LumiaCore.getNextLevelXp(user.level);
            
            const rewardGold = user.level * 500;
            user.gold += rewardGold;
            if(socket) socket.emit("notification", `🆙 LEVELED UP! Nível ${user.level} (+${rewardGold}g)`);
        }

        if(socket && amount > 0) {
            socket.emit("xp_gain", { amount, source, current: user.xp, max: nextLvl, level: user.level });
        }
        return leveledUp;
    },

    calculateCollectionPower: (user) => {
        if (!user.collection) return 0;
        return user.collection.reduce((acc, card) => {
            const base = RARITY_WEIGHTS[card.rarity] || 1;
            return acc + (base * 10);
        }, 0);
    }
};

// Inicialização do DB
if (fs.existsSync(DB_FILE)) {
  try {
    DATABASE = JSON.parse(fs.readFileSync(DB_FILE));
    if (!DATABASE.market) DATABASE.market = [];
    if (!DATABASE.users) DATABASE.users = {};
    if (!DATABASE.marketIndex) DATABASE.marketIndex = 1.0;
    if (!DATABASE.priceHistory) DATABASE.priceHistory = {};
    if (!DATABASE.globalGoals) DATABASE.globalGoals = { active: { type: 'market_volume', target: 50000, current: 0, desc: "Comerciante: Movimentem 50k Gold no Mercado", reward: "booster_gold" }, lastCompleted: 0 };
  } catch (e) { saveDB(); }
} else { saveDB(); }

// Inicializa Bot
if (!DATABASE.users[BOT_NAME]) {
    DATABASE.users[BOT_NAME] = { 
        username: BOT_NAME, gold: 9999999, mana: 9999999, essence: 9999999, 
        collection: [], isBot: true, wins: 0, elo: 1500, activeSleeve: 'neon', decks: []
    };
    saveDB();
}

// --- SISTEMA DE MISSÕES ---
const MISSION_TEMPLATES = {
    daily: [
        { id: 'd1', desc: "Investidor: Compre 1 carta no Mercado", type: 'market_buy', target: 1, reward: { gold: 200 } },
        { id: 'd2', desc: "Duelista: Vença 1 partida", type: 'duel_win', target: 1, reward: { xp: 100 } },
        { id: 'd3', desc: "Sortudo: Abra 1 Pacote", type: 'open_pack', target: 1, reward: { mana: 50 } },
        { id: 'd4', desc: "Magic Fan: Consiga 3 cartas de Magic", type: 'collect_source', source: 'Magic', target: 3, reward: { essence: 50 } }
    ],
    weekly: [
        { id: 'w1', desc: "Magnata: Acumule 5000 de Ouro em vendas", type: 'market_sell_amt', target: 5000, reward: { gold: 2000, xp: 500 } },
        { id: 'w2', desc: "Lenda Disney: Encontre Mickey, Donald ou Pateta", type: 'collect_lore', regex: /Mickey|Donald|Goofy|Pateta/i, target: 1, reward: { essence: 1000 } },
        { id: 'w3', desc: "Mestre Pokémon: Colete 10 cartas do tipo Épico", type: 'collect_rarity', rarity: 'epic', target: 10, reward: { mana: 1000 } }
    ]
};

const LumiaMissions = {
    generate: (user) => {
        const now = Date.now();
        if (!user.missions) user.missions = { active: [], lastGen: 0 };
        
        if (now - user.missions.lastGen > 24 * 60 * 60 * 1000) {
            const daily = MISSION_TEMPLATES.daily.sort(() => 0.5 - Math.random()).slice(0, 3);
            const weekly = MISSION_TEMPLATES.weekly.sort(() => 0.5 - Math.random()).slice(0, 1);
            
            user.missions.active = [...daily, ...weekly].map(m => ({ ...m, progress: 0, completed: false }));
            user.missions.lastGen = now;
            return true;
        }
        return false;
    },

    check: (user, type, data, socket) => {
        if (!user.missions || !user.missions.active) return;
        let updated = false;

        user.missions.active.forEach(m => {
            if (m.completed) return;

            let progressMade = 0;
            if (m.type === type) {
                if (type === 'market_buy' || type === 'duel_win' || type === 'open_pack') progressMade = 1;
                if (type === 'market_sell_amt') progressMade = data.amount || 0;
                
                if (type === 'collect_cards' && Array.isArray(data.cards)) {
                    data.cards.forEach(c => {
                        if (m.id === 'd4' && c.source === 'Magic') m.progress++;
                        if (m.id === 'w3' && c.rarity === 'epic') m.progress++;
                        if (m.id === 'w2' && m.regex && m.regex.test(c.name)) m.progress++;
                    });
                }
            }

            if (progressMade > 0) {
                m.progress += progressMade;
                if (m.progress >= m.target) {
                    m.progress = m.target;
                    m.completed = true;
                    if(m.reward.gold) user.gold = (user.gold||0) + m.reward.gold;
                    if(m.reward.mana) user.mana = (user.mana||0) + m.reward.mana;
                    if(m.reward.essence) user.essence = (user.essence||0) + m.reward.essence;
                    if(m.reward.xp) LumiaCore.addXP(user, m.reward.xp, "mission", socket);
                    
                    if(socket) socket.emit("notification", `🎯 Missão Cumprida: ${m.desc}!`);
                    logUserActivity(user, "QUEST", `Completou: ${m.desc}`);
                }
                updated = true;
            }
        });
        return updated;
    }
};

function logUserActivity(user, type, msg) {
    if (!user.history) user.history = [];
    const entry = { time: Date.now(), type, msg };
    user.history.unshift(entry);
    if (user.history.length > 50) user.history.pop();
    return entry;
}

function saveDB() {
  try { 
    const data = JSON.stringify(DATABASE, null, 2);
    fs.writeFileSync(DB_FILE, data); 
    // console.log(`[DB] Salvo com sucesso`); 
  } catch(e) { console.error("❌ ERRO CRÍTICO AO SALVAR DB:", e.message); }
}

const MATCHES = {};
const TRADES = {}; 
const TABLES = {};
const SOCKET_USER_MAP = {};
let LORCANA_CACHE = null; let LORCANA_CACHE_TIME = 0;
let POKEMON_CACHE = null; let POKEMON_CACHE_TIME = 0;

async function getPokemonAllCached() {
    const now = Date.now();
    if (POKEMON_CACHE && (now - POKEMON_CACHE_TIME) < 60 * 60 * 1000) return POKEMON_CACHE;
    try {
        const res = await fetchWithTimeout("https://api.tcgdex.net/v2/en/cards", 8000);
        let all = await res.json();
        if (Array.isArray(all)) {
            all = all.filter(c => c.image);
            POKEMON_CACHE = all; POKEMON_CACHE_TIME = now; return all;
        }
    } catch (e) { console.log("Pokemon API Error:", e.message); }
    return POKEMON_CACHE || [];
}

function uid() { return Math.random().toString(36).slice(2, 10); }

async function fetchWithTimeout(url, ms = 8000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
        const res = await fetchFn(url, { signal: ctrl.signal, headers: { 'User-Agent': 'BafoMultiverse/3.0' } });
        clearTimeout(t); return res;
    } catch (e) { clearTimeout(t); throw e; }
}

async function fetchJSON(url, timeoutMs = 5000) {
    const res = await fetchWithTimeout(url, timeoutMs);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
}

function generateLore(name, rarity, source) {
    const prefixes = ["O Artefato de", "A Relíquia de", "O Fragmento de", "A Lenda de", "O Eco de"];
    const places = ["Atlantis", "Valhalla", "Ciber-Espaço", "Reino Sombrio", "Nexus"];
    if (source === "Lorcana") return `Uma memória mágica preservada nos arquivos da Disney.`;
    return `${prefixes[Math.floor(Math.random()*prefixes.length)]} ${name}, encontrado em ${places[Math.floor(Math.random()*places.length)]}.`;
}

// --- PADRONIZAÇÃO DE CARTAS COM SETS E PREÇO DINÂMICO ---
function normalizeCard(card, realPrice = 0) {
    const safeStr = (v) => v ? String(v).trim() : "";
    let img = safeStr(card?.image || card?.image_uris?.normal);
    
    if (!img || img.length < 10) {
        img = "https://placehold.co/250x350/222/gold?text=" + encodeURIComponent(safeStr(card?.name));
    }
    
    const rarity = safeStr(card?.rarity) || "common";
    const name = safeStr(card?.name) || "Carta Misteriosa";
    const source = safeStr(card?.source) || "System";

    // --- LÓGICA DE SETS DETERMINÍSTICA ---
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    const positiveHash = Math.abs(hash);

    const setInfo = SET_CONFIG[source] || SET_CONFIG['System'];
    
    // Define a edição baseada no hash
    let editionIdx = positiveHash % 10; // 0-9
    let editionName = setInfo.editions[setInfo.editions.length - 1]; // Default: Última
    
    if (editionIdx < 4) {
        editionName = setInfo.editions[editionIdx]; // Cai em uma das 4 clássicas
    }

    // Número da carta na coleção (1 a 300 fixo pelo nome)
    const cardNum = (positiveHash % 300) + 1;

    // --- CÁLCULO DE VALOR DE MERCADO ---
    let estimatedValue = Math.max(10, Math.ceil(realPrice * 100));
    if (DATABASE.priceHistory && DATABASE.priceHistory[name]) {
        const history = DATABASE.priceHistory[name];
        if (history.length > 0) {
            const avg = history.reduce((a, b) => a + b, 0) / history.length;
            estimatedValue = Math.floor(avg);
        }
    }
    const minPrices = { 'common': 10, 'rare': 50, 'epic': 200, 'legend': 1000 };
    estimatedValue = Math.max(estimatedValue, minPrices[rarity] || 10);

    return {
        uid: uid(),
        name: name,
        image: img,
        rarity: rarity,
        source: source,
        lore: generateLore(name, rarity, source),
        baseValue: estimatedValue,
        
        // METADADOS DE COLEÇÃO
        set_id: setInfo.code, 
        set_name: editionName,
        number: cardNum,      
        total_in_set: 300,
        
        sleeve: null,
        acquiredAt: Date.now()
    };
}

// --- BOT TRADER & MARKET MAKER (MODO FEIRA LIVRE) ---
setInterval(() => {
    const bot = DATABASE.users[BOT_NAME];
    if (!bot) return;

    // 0. AUTO-ABASTECIMENTO (GARANTE QUE O BOT NUNCA FIQUE SEM PRODUTO)
    // Se o estoque estiver baixo, o bot "importa" cartas do sistema
    if (bot.collection.length < 100) {
        const sources = ['mtg', 'lorcana', 'pokemon'];
        const source = sources[Math.floor(Math.random() * sources.length)];
        _downloadCardRaw(source).then(c => {
            if(c) {
                c.sleeve = 'neon';
                c.originalOwner = BOT_NAME;
                bot.collection.push(c);
            }
        });
    }
    // Limpeza de estoque excessivo
    if (bot.collection.length > 800) bot.collection.splice(0, 100);

    const getFairPrice = (card) => {
        const marketIndex = DATABASE.marketIndex || 1;
        // Preço base + Inflação/Deflação Global
        const anchored = Math.floor((card.baseValue || 0) * marketIndex);
        let analyzed = 0;
        try { analyzed = botAnalyzePrice(card) || 0; } catch (e) { analyzed = 0; }
        // O preço justo considera a escassez real da carta no servidor
        return Math.max(anchored, analyzed, 20);
    };

    // 1. RENOVAÇÃO CONSTANTE (LIMPEZA DA BANCA)
    // Remove cartas paradas há 10 minutos para dar lugar a novas
    const STALE_TIME = 10 * 60 * 1000; 
    const now = Date.now();
    
    let botListings = DATABASE.market.filter(m => m.seller === BOT_NAME);
    let removedCount = 0;

    for (let i = botListings.length - 1; i >= 0; i--) {
        const listing = botListings[i];
        if (now - (listing.timestamp || 0) > STALE_TIME) {
            const globalIdx = DATABASE.market.findIndex(m => m.listingId === listing.listingId);
            if (globalIdx > -1) {
                DATABASE.market.splice(globalIdx, 1);
                // Devolve pro estoque (reciclagem)
                listing.card.acquiredAt = Date.now();
                bot.collection.push(listing.card); 
                removedCount++;
            }
        }
    }
    
    if (removedCount > 0) io.emit("market_update", DATABASE.market);

    // 2. BOT COMPRADOR (OPORTUNISTA)
    // Compra cartas de jogadores se estiverem muito baratas (ajuda a liquidar seus itens)
    const offers = DATABASE.market.filter(m => m.seller !== BOT_NAME);
    for (const item of offers) {
        if (!item.card) continue;
        const fairPrice = getFairPrice(item.card);
        // Compra se estiver 40% abaixo do valor (Sniper)
        if (item.price <= fairPrice * 0.6) {
            const idx = DATABASE.market.indexOf(item);
            if (idx > -1) {
                DATABASE.market.splice(idx, 1);
                bot.collection.push(item.card);
                if (DATABASE.users[item.seller]) {
                    DATABASE.users[item.seller].gold = (DATABASE.users[item.seller].gold || 0) + item.price;
                    const sid = DATABASE.users[item.seller].socketId;
                    if (sid) io.to(sid).emit("notification", `🤖 LumiaBot comprou sua oferta! (+${item.price}g)`);
                }
                saveDB();
                io.emit("market_update", DATABASE.market);
            }
        }
    }

    // 3. BOT VENDEDOR (ABASTECIMENTO EM MASSA)
    // Meta: Manter 70 slots ocupados na feira
    botListings = DATABASE.market.filter(m => m.seller === BOT_NAME);
    const TARGET_LISTINGS = 70;
    
    // Adiciona VÁRIAS cartas por vez (até 5) para preencher rápido
    let addedThisCycle = 0;
    
    while (botListings.length < TARGET_LISTINGS && bot.collection.length > 0 && addedThisCycle < 5) {
        const availableToSell = bot.collection.filter(c => !botListings.some(listing => listing.card.uid === c.uid));
        
        if (availableToSell.length === 0) break;

        // Prioridade: Diversidade (Evita listar 10 Charizards iguais se possível)
        const allMarketNames = new Set(DATABASE.market.map(m => m.card.name));
        let candidates = availableToSell.filter(c => !allMarketNames.has(c.name));

        if (candidates.length === 0) candidates = availableToSell; // Se não tiver inéditas, vai repetida mesmo

        const card = candidates[Math.floor(Math.random() * candidates.length)];
        
        // Tira do estoque e põe na banca
        const cIdx = bot.collection.indexOf(card);
        if (cIdx > -1) bot.collection.splice(cIdx, 1);

        const fairPrice = getFairPrice(card);
        
        // LÓGICA DE PRECIFICAÇÃO DINÂMICA
        // 10% de chance de "Promoção" (0.8x valor)
        // 90% de chance de preço normal com margem (1.0x a 1.3x)
        let priceMult = 1.0 + (Math.random() * 0.3);
        if (Math.random() < 0.1) priceMult = 0.8; 

        const sellPrice = Math.max(20, Math.floor(fairPrice * priceMult));

        const newItem = { 
            listingId: uid(), 
            seller: BOT_NAME, 
            card, 
            price: sellPrice, 
            timestamp: Date.now() 
        };

        DATABASE.market.push(newItem);
        botListings.push(newItem);
        addedThisCycle++;
    }

    if (addedThisCycle > 0) {
        saveDB();
        io.emit("market_update", DATABASE.market);
    }

}, 8000); // Ciclo rápido de 8 segundos

function mapRarity(raw) {
    if(!raw) return "common";
    const r = String(raw).toLowerCase();
    if (r.includes('hyper') || r.includes('secret') || r.includes('sir') || r.includes('special') || r.includes('gold') || r.includes('legend')) return 'legend';
    if (r.includes('ultra') || r.includes('illustration') || r.includes('full') || r.includes('vmax') || r.includes('ex') || r.includes('gx')) return 'epic';
    if (r.includes('rare') || r.includes('holo') || r.includes('double')) return 'rare';
    return 'common';
}

const CARD_POOL = { mtg: [], lorcana: [], pokemon: [] };
const POOL_LIMIT = 20;

async function _downloadCardRaw(source) {
    try {
        if (source === "mtg") {
            const c = await fetchJSON("https://api.scryfall.com/cards/random", 5000);
            let img = c?.image_uris?.normal || c?.image_uris?.large || c?.card_faces?.[0]?.image_uris?.normal;
            let price = parseFloat(c.prices?.usd || 0);
            if(img) return normalizeCard({ name: c.name, image: img, rarity: mapRarity(c.rarity), source: "Magic" }, price);
        }
        else if (source === "lorcana") {
            const all = await getLorcanaAllCached();
            if (all?.length) {
                const c = all[Math.floor(Math.random() * all.length)];
                let img = c.Image || `https://placehold.co/250x350/333/00cec9?text=${encodeURIComponent(c.Name)}`;
                return normalizeCard({ name: c.Name, image: img, rarity: mapRarity(c.Rarity), source: "Lorcana" }, 0);
            }
        }
        else if (source === "pokemon") {
            const all = await getPokemonAllCached();
            if (all?.length) {
                const c = all[Math.floor(Math.random() * all.length)];
                let img = c.image ? `${c.image}/high.png` : "";
                let rarity = c.rarity ? mapRarity(c.rarity) : (c.name.includes(" V") ? "epic" : "common");
                let price = 0;
                if(rarity !== 'common' && Math.random() > 0.5) { 
                    try { const d = await fetchJSON(`https://api.tcgdex.net/v2/en/cards/${c.id}`, 2000); if(d.rarity) rarity = mapRarity(d.rarity); } catch(e){} 
                }
                return normalizeCard({ name: c.name, image: img, rarity: rarity, source: "Pokemon" }, price);
            }
        }
    } catch (e) { return null; }
    return null;
}

function refillPool(source) {
    if (CARD_POOL[source].length < POOL_LIMIT) {
        setImmediate(() => {
            _downloadCardRaw(source).then(card => {
                if (card) {
                    CARD_POOL[source].push(card);
                    if(CARD_POOL[source].length < POOL_LIMIT) setTimeout(() => refillPool(source), 200);
                }
            });
        });
    }
}

setTimeout(() => { 
    ['mtg', 'lorcana', 'pokemon'].forEach(s => refillPool(s)); 
}, 2000);

async function fetchRandomCard(forcedSource) {
    const sources = ['mtg', 'lorcana', 'pokemon'];
    const source = forcedSource || sources[Math.floor(Math.random() * sources.length)];
    if (CARD_POOL[source].length > 0) {
        const card = CARD_POOL[source].shift();
        refillPool(source);
        return { ...card, uid: uid(), acquiredAt: Date.now() };
    }
    const freshCard = await _downloadCardRaw(source);
    return freshCard || normalizeCard({ name: "Carta Glitch", image: "", rarity: "common", source: "System" });
}

async function getLorcanaAllCached() {
    const now = Date.now();
    if (LORCANA_CACHE && (now - LORCANA_CACHE_TIME) < 60 * 60 * 1000) return LORCANA_CACHE;
    try {
        const res = await fetchWithTimeout("https://api.lorcana-api.com/cards/all", 6000);
        const all = await res.json();
        if (Array.isArray(all) && all.length > 0) { LORCANA_CACHE = all; LORCANA_CACHE_TIME = now; return all; }
    } catch (e) { console.log("Lorcana API Error:", e.message); }
    return LORCANA_CACHE || [];
}

async function fetchWithRetry(source, retries = 3) {
    for(let i=0; i<retries; i++) {
        const card = await fetchRandomCard(source);
        if(card && card.source !== "System" && !card.image.includes("placehold")) return card;
        await new Promise(r => setTimeout(r, 300));
    }
    return normalizeCard({ name: "Falha na Matriz", rarity: "common", source: "System" });
}

async function generateBooster(ownerName, weights) {
    let magicW = (weights?.magic !== undefined) ? weights.magic : 33;
    let lorcanaW = (weights?.lorcana !== undefined) ? weights.lorcana : 33;
    let pokemonW = (weights?.pokemon !== undefined) ? weights.pokemon : 33;
    
    const totalWeight = magicW + lorcanaW + pokemonW;
    const pickSource = () => {
        if (totalWeight <= 0) return 'mtg';
        const r = Math.random() * totalWeight;
        if (r < magicW) return 'mtg';
        if (r < magicW + lorcanaW) return 'lorcana';
        return 'pokemon';
    };

    const tasks = [];
    for(let i=0; i<3; i++) tasks.push(fetchWithRetry(pickSource()));
    const results = await Promise.all(tasks);
    
    return results.map(data => ({
        ...data,
        originalOwner: ownerName,
        flipped: false,
        sleeve: ownerName === "LumiaBot" ? 'neon' : 'default'
    }));
}

function getCardSupply(cardName) {
    let supply = 0;
    Object.values(DATABASE.users).forEach(u => {
        if(u.collection) supply += u.collection.filter(c => c.name === cardName).length;
    });
    return Math.max(1, supply);
}

function botAnalyzePrice(card) {
    const base = { common: 50, rare: 150, epic: 400, legend: 1200 }[card.rarity] || 80;
    const supply = getCardSupply(card.name);
    const scarcityMult = Math.max(0.5, 3.0 - (Math.log10(supply) * 0.8));
    let trendMult = 1.0;
    const trend = DATABASE.marketTrend;
    if (trend === 'bull') trendMult = 1.3;
    if (trend === 'bear') trendMult = 0.7;
    if (trend === 'crash') trendMult = 0.4;
    const noise = 0.9 + Math.random() * 0.2;
    return Math.floor(base * scarcityMult * trendMult * noise * DATABASE.marketIndex);
}

setInterval(() => {
    if (Math.random() < 0.1) {
        const currentStage = DATABASE.cycleStage || 0;
        const nextStage = (currentStage + 1) % MARKET_CYCLES.length;
        DATABASE.cycleStage = nextStage;
        DATABASE.marketTrend = MARKET_CYCLES[nextStage];
        
        let msg = "";
        switch(DATABASE.marketTrend) {
            case 'bull': msg = "📈 BULL RUN! Preços subindo!"; break;
            case 'bear': msg = "📉 Correção de mercado..."; break;
            case 'crash': msg = "💥 CRASH! Oportunidade de compra!"; break;
            default: msg = "⚖️ Mercado Estável.";
        }
        io.emit("notification", msg);
        io.emit("market_index_update", { index: DATABASE.marketIndex, trend: DATABASE.marketTrend });
    }
    
    if (DATABASE.marketTrend === 'bull') DATABASE.marketIndex *= 1.02;
    else if (DATABASE.marketTrend === 'bear') DATABASE.marketIndex *= 0.98;
    else if (DATABASE.marketTrend === 'crash') DATABASE.marketIndex *= 0.90;
    else DATABASE.marketIndex = (DATABASE.marketIndex + 1.0) / 2;

    DATABASE.marketIndex = Math.max(0.4, Math.min(3.0, DATABASE.marketIndex));
    saveDB();
}, 30000);

// --- HELPER: LISTA DE USUÁRIOS ONLINE ---
const broadcastOnlineList = () => {
    const list = Object.values(SOCKET_USER_MAP).map(uName => {
        const u = DATABASE.users[uName];
        return { 
            username: uName, 
            level: u?.level || 1, 
            avatar: u?.activeSleeve || 'default',
            status: 'Online' 
        };
    });
    io.emit("online_users_update", list);
};

const checkGlobalGoal = (ioInstance) => {
    const g = DATABASE.globalGoals.active;
    if (g.current >= g.target) {
        g.current = g.target;
        setTimeout(() => {
            DATABASE.globalGoals.active = { 
                type: 'market_volume', 
                target: g.target * 1.5, 
                current: 0, 
                desc: `Nova Meta: Movimentar ${Math.floor(g.target * 1.5)}g`, 
                reward: 'booster_gold' 
            };
            ioInstance.emit("global_goal_update", DATABASE.globalGoals.active);
            ioInstance.emit("notification", "Nova Meta Comunitária Iniciada!");
        }, 10000);
    }
};

// --- SOCKET IO ---
io.on("connection", (socket) => {
    io.emit("online_count", io.engine.clientsCount);
    socket.emit("market_index_update", { index: DATABASE.marketIndex, trend: DATABASE.marketTrend });
    socket.emit("global_goal_update", DATABASE.globalGoals.active);

    socket.on("login", async (data) => {
        const { username } = data || {}; 
        if(!username) return;

        let user = DATABASE.users[username];
        if(!user) {
            const d1 = await generateBooster(username); 
            user = { 
                username, gold: 1000, mana: 1000, essence: 1000, 
                collection: [...d1], lastLogin: "", wins: 0, elo: 1000, 
                marketScore: 0, xp: 0, level: 1,
                history: [], missions: { active: [], lastGen: 0 },
                activeSleeve: 'default', unlockedSleeves: ['default'], decks: [] 
            };
            DATABASE.users[username] = user;
        }

        if(!user.history) user.history = [];
        if(!user.missions) user.missions = { active: [], lastGen: 0 };
        LumiaMissions.generate(user);

        SOCKET_USER_MAP[socket.id] = username;
        user.socketId = socket.id;

        // Limpa sockets antigos
        for (const sid of Object.keys(SOCKET_USER_MAP)) {
            if (sid !== socket.id && SOCKET_USER_MAP[sid] === username) {
                delete SOCKET_USER_MAP[sid];
            }
        }
        saveDB();
        
        socket.emit("login_success", user);
        socket.emit("market_update", DATABASE.market);
        socket.emit("update_missions", user.missions.active);
        socket.emit("update_history", user.history);
        broadcastOnlineList();
    });

    socket.on("get_ranking", () => {
        const usersList = Object.values(DATABASE.users);
        const rankElo = [...usersList].sort((a, b) => (b.elo || 1000) - (a.elo || 1000)).slice(0, 50)
            .map(u => ({ username: u.username, val: u.elo || 1000, type: 'ELO', level: u.level || 1 }));
        const rankPower = [...usersList].sort((a, b) => LumiaCore.calculateCollectionPower(b) - LumiaCore.calculateCollectionPower(a)).slice(0, 50)
            .map(u => ({ username: u.username, val: LumiaCore.calculateCollectionPower(u), type: 'POWER', level: u.level || 1 }));
        const rankMarket = [...usersList].sort((a, b) => (b.marketScore || 0) - (a.marketScore || 0)).slice(0, 50)
            .map(u => ({ username: u.username, val: u.marketScore || 0, type: 'MARKET', level: u.level || 1 }));
        socket.emit("ranking_data", { elo: rankElo, power: rankPower, market: rankMarket });
    });

    socket.on("get_profile", (targetName) => {
        const u = DATABASE.users[targetName];
        if(u) {
            const totalValue = (u.collection || []).reduce((acc, c) => acc + (c.baseValue || 0), 0);
            socket.emit("profile_data", {
                username: u.username,
                level: u.level || 1,
                elo: u.elo || 1000,
                wins: u.wins || 0,
                totalCards: (u.collection || []).length,
                collectionValue: totalValue,
                favCard: u.collection && u.collection.length > 0 ? u.collection[0] : null
            });
        }
    });

    socket.on("trade_invite", (targetUser) => {
        const sender = SOCKET_USER_MAP[socket.id];
        const targetSocketId = Object.keys(SOCKET_USER_MAP).find(k => SOCKET_USER_MAP[k] === targetUser);
        if(targetSocketId) {
            io.to(targetSocketId).emit("trade_invitation", { from: sender });
            socket.emit("notification", `Convite enviado para ${targetUser}`);
        } else {
            socket.emit("notification", "Usuário offline.");
        }
    });

    socket.on("trade_accept", (fromUser) => {
        const p2 = SOCKET_USER_MAP[socket.id];
        const p1 = fromUser;
        const tradeId = "trade_" + uid();
        TRADES[tradeId] = {
            id: tradeId, p1: p1, p2: p2,
            offers: { [p1]: { gold: 0, cards: [], locked: false }, [p2]: { gold: 0, cards: [], locked: false } },
            status: 'active'
        };

        const s1 = Object.keys(SOCKET_USER_MAP).find(k => SOCKET_USER_MAP[k] === p1);
        const s2 = socket.id;
        if(s1 && s2) {
            [s1, s2].forEach(sid => {
                const s = io.sockets.sockets.get(sid);
                if(s) { s.join(tradeId); s.emit("trade_start", { tradeId, opponent: (SOCKET_USER_MAP[sid] === p1 ? p2 : p1) }); }
            });
        }
    });

    socket.on("trade_update_offer", (d) => {
        const t = TRADES[d.tradeId];
        if(!t || t.status !== 'active') return;
        const u = SOCKET_USER_MAP[socket.id];
        
        if(d.gold !== undefined) t.offers[u].gold = parseInt(d.gold);
        if(d.cardUID) {
            const exists = t.offers[u].cards.find(c => c.uid === d.cardUID);
            if(exists) t.offers[u].cards = t.offers[u].cards.filter(c => c.uid !== d.cardUID);
            else {
                const realCard = DATABASE.users[u].collection.find(c => c.uid === d.cardUID);
                if(realCard) t.offers[u].cards.push(realCard);
            }
        }
        t.offers[t.p1].locked = false;
        t.offers[t.p2].locked = false;
        io.to(t.id).emit("trade_sync", t.offers);
    });

    socket.on("trade_lock_toggle", (tradeId) => {
        const t = TRADES[tradeId];
        if(!t) return;
        const u = SOCKET_USER_MAP[socket.id];
        const userGold = DATABASE.users[u].gold || 0;
        if(t.offers[u].gold > userGold) return socket.emit("notification", "Gold insuficiente!");

        t.offers[u].locked = !t.offers[u].locked;
        io.to(t.id).emit("trade_sync", t.offers);

        if(t.offers[t.p1].locked && t.offers[t.p2].locked) {
            const u1 = DATABASE.users[t.p1];
            const u2 = DATABASE.users[t.p2];
            const o1 = t.offers[t.p1];
            const o2 = t.offers[t.p2];

            u1.gold -= o1.gold; u2.gold += o1.gold;
            u2.gold -= o2.gold; u1.gold += o2.gold;

            o1.cards.forEach(c => {
                const idx = u1.collection.findIndex(x => x.uid === c.uid);
                if(idx > -1) u1.collection.splice(idx, 1);
                c.originalOwner = t.p1;
                u2.collection.push(c);
            });
            o2.cards.forEach(c => {
                const idx = u2.collection.findIndex(x => x.uid === c.uid);
                if(idx > -1) u2.collection.splice(idx, 1);
                c.originalOwner = t.p2;
                u1.collection.push(c);
            });

            t.status = 'completed';
            saveDB();
            io.to(t.id).emit("trade_completed", { success: true });
            
            const s1 = Object.keys(SOCKET_USER_MAP).find(k => SOCKET_USER_MAP[k] === t.p1);
            const s2 = Object.keys(SOCKET_USER_MAP).find(k => SOCKET_USER_MAP[k] === t.p2);
            if(s1) io.to(s1).emit("update_profile", u1);
            if(s2) io.to(s2).emit("update_profile", u2);
        }
    });

    socket.on("currency_swap", (d) => {
        const u = DATABASE.users[SOCKET_USER_MAP[socket.id]];
        const amt = parseInt(d.amount); 
        if(u && amt > 0 && u[d.from] >= amt) {
            u[d.from] -= amt; 
            u[d.to] = (parseInt(u[d.to]) || 0) + amt;
            saveDB(); 
            socket.emit("update_profile", u);
            socket.emit("notification", `Troca realizada: ${amt} ${d.from} -> ${d.to}`);
        }
    });

    socket.on("buy_booster_multiverse", async (p) => {
        const u = DATABASE.users[SOCKET_USER_MAP[socket.id]];
        if (!u) return socket.emit("notification", "Sessão inválida.");
        
        const cost = { 
            gold: Math.max(0, parseInt(p?.gold)||0), 
            mana: Math.max(0, parseInt(p?.mana)||0), 
            essence: Math.max(0, parseInt(p?.essence)||0) 
        };

        if ((u.gold||0) < cost.gold || (u.mana||0) < cost.mana || (u.essence||0) < cost.essence) {
            return socket.emit("notification", "Recursos insuficientes.");
        }
        
        u.gold -= cost.gold; 
        u.mana -= cost.mana; 
        u.essence -= cost.essence;

        const c = await generateBooster(u.username, { pokemon: cost.gold, magic: cost.mana, lorcana: cost.essence });
        
        let totalXp = 0;
        c.forEach(card => {
            card.sleeve = u.activeSleeve || "default";
            const r = (card.rarity || 'common').toLowerCase();
            const xpVal = RARITY_XP[r] || 10;
            totalXp += xpVal;
        });

        if (!u.collection) u.collection = [];
        u.collection.push(...c);

        LumiaCore.addXP(u, totalXp, "open_pack", socket);
        LumiaMissions.check(u, "open_pack", null, socket);
        LumiaMissions.check(u, "collect_cards", { cards: c }, socket);
        logUserActivity(u, "BOOSTER", `Abriu pacote e ganhou ${c.length} cartas (+${totalXp} XP)`);
        
        saveDB();
        
        socket.emit("update_profile", u);
        socket.emit("booster_opened", c);
        socket.emit("update_history", u.history);
        if (u.missions?.active) socket.emit("update_missions", u.missions.active);
    });

    socket.on("save_deck", (deckData) => {
        const u = DATABASE.users[SOCKET_USER_MAP[socket.id]];
        if (!u) return;
        if (!u.decks) u.decks = [];
        const newDeck = { ...deckData, id: deckData.id || uid(), valid: true, updatedAt: Date.now() };
        const idx = u.decks.findIndex(d => d.id === newDeck.id);
        if (idx > -1) u.decks[idx] = newDeck; else u.decks.push(newDeck);
        saveDB();
        socket.emit("deck_saved", { deck: newDeck, msg: "Deck salvo com sucesso!" });
        socket.emit("update_profile", u);
    });

    // --- TABLETOP SIMULATOR LOGIC (MOVIDO PARA DENTRO) ---
    socket.on('table_create', (deckId) => {
        const u = DATABASE.users[SOCKET_USER_MAP[socket.id]];
        if (!u) return;

        const deckData = u.decks.find(d => d.id === deckId);
        if (!deckData) return socket.emit("notification", "Deck não encontrado.");

        const deckCards = deckData.main.map(uid => {
            const cardRef = u.collection.find(c => c.uid === uid);
            if (!cardRef) return null;
            return {
                instanceId: uid + "_" + Math.random().toString(36).substr(2, 5),
                ...cardRef,
                x: 0, y: 0, tapped: false, facedown: true, counters: 0
            };
        }).filter(Boolean);

        deckCards.sort(() => Math.random() - 0.5);

        const tableId = "table_" + uid();
        TABLES[tableId] = {
            id: tableId,
            players: [{
                socketId: socket.id,
                username: u.username,
                hp: 20,
                zones: {
                    deck: deckCards,
                    hand: [],
                    battlefield: [],
                    graveyard: []
                }
            }],
            pings: []
        };

        socket.join(tableId);
        socket.emit("table_joined", TABLES[tableId]);
        socket.emit("notification", "Mesa criada! Aguardando oponente...");
    });

    socket.on('table_join', (tableId) => {
        const t = TABLES[tableId];
        if (t && t.players.length < 2) {
            const u = DATABASE.users[SOCKET_USER_MAP[socket.id]];
            t.players.push({
                socketId: socket.id,
                username: u.username,
                hp: 20,
                zones: { deck: [], hand: [], battlefield: [], graveyard: [] }
            });
            socket.join(tableId);
            io.to(tableId).emit("table_update", t);
        }
    });

    socket.on('table_action', (d) => {
        const t = TABLES[d.tableId];
        if (!t) return;
        
        const pIndex = t.players.findIndex(p => p.socketId === socket.id);
        if (pIndex === -1) return;
        const player = t.players[pIndex];

        if (d.type === 'draw') {
            if (player.zones.deck.length > 0) {
                const card = player.zones.deck.pop();
                card.facedown = false;
                player.zones.hand.push(card);
            }
        }
        else if (d.type === 'move_card') {
            let card = null;
            if (card) {
                if (d.destZone === 'battlefield') {
                    card.x = d.x || (Math.random() * 200);
                    card.y = d.y || (Math.random() * 200);
                    card.tapped = false;
                    player.zones.battlefield.push(card);
                } 
                // NOVO: Volta para a mão
                else if (d.destZone === 'hand') {
                    card.tapped = false;
                    card.counters = 0; // Limpa os marcadores ao voltar pra mão
                    player.zones.hand.push(card);
                }
            }

else if (d.type === 'create_token') {
            const tokenCard = {
                instanceId: "token_" + Math.random().toString(36).substr(2, 5),
                name: "Token Genérico",
                // Imagem de placeholder verde para o token
                image: "https://placehold.co/250x350/2ecc71/000000?text=TOKEN", 
                rarity: "common",
                x: 150, 
                y: 150, 
                tapped: false, 
                facedown: false, 
                counters: 0,
                isToken: true
            };
            player.zones.battlefield.push(tokenCard);
        }
        }
        else if (d.type === 'update_card') {
            const card = player.zones.battlefield.find(c => c.instanceId === d.instanceId);
            if (card) {
                if (d.update.pos) { card.x = d.update.pos.x; card.y = d.update.pos.y; }
                if (d.update.tapped !== undefined) card.tapped = d.update.tapped;
                if (d.update.facedown !== undefined) card.facedown = d.update.facedown;
                if (d.update.counters !== undefined) card.counters = (card.counters || 0) + d.update.counters;
            }
        }
        else if (d.type === 'untap_all') {
            player.zones.battlefield.forEach(c => c.tapped = false);
        }
        else if (d.type === 'life') {
            player.hp += d.amount;
        }
        else if (d.type === 'ping') {
            io.to(t.id).emit("table_ping", { x: d.x, y: d.y, color: d.color, msg: d.msg });
            return;
        }

        io.to(t.id).emit("table_update", t);
    });

    socket.on("create_match", async (uids) => {
        try {
            const uName = SOCKET_USER_MAP[socket.id];
            const u = DATABASE.users[uName];
            if (!uName || !u) return socket.emit("notification", "Sessão inválida.");
            if (!uids || !Array.isArray(uids)) return socket.emit("notification", "Dados inválidos.");
            if (!u.collection) u.collection = [];

            const cards = uids.map(id => u.collection.find(c => c.uid === id)).filter(Boolean);
            if (cards.length === 0 || ![1, 3, 5].includes(cards.length)) return socket.emit("notification", "Selecione 1, 3 ou 5 cartas!");

            const rid = "room_" + uid();
            MATCHES[rid] = {
                id: rid, players: [socket.id], usernames: [uName],
                pot: [...cards], scores: { [uName]: 0 },
                started: false, isBotMatch: false,
                createdAt: Date.now(), lastTurnTime: Date.now()
            };

            socket.join(rid);
            socket.emit("waiting_opponent");

            setTimeout(async () => {
                try {
                    const r = MATCHES[rid];
                    if (!r || r.started || r.players.length >= 2) return;
                    const bot = DATABASE.users[BOT_NAME];
                    if (!bot) return;

                    if (bot.collection.length < 10) {
                        const booster = await generateBooster(BOT_NAME, { magic: 33, lorcana: 33, pokemon: 33 });
                        bot.collection.push(...booster);
                    }
                    const betSize = r.pot.length;
                    const botCards = [];
                    for (let i = 0; i < betSize; i++) {
                        if (bot.collection.length > 0) {
                            const rndIdx = Math.floor(Math.random() * bot.collection.length);
                            const picked = bot.collection.splice(rndIdx, 1)[0];
                            if (picked) botCards.push(picked);
                        }
                    }
                    while (botCards.length < betSize) {
                        botCards.push(normalizeCard({ name: "Bot Card", rarity: "common", source: "System" }));
                    }
                    botCards.forEach(c => { c.sleeve = 'neon'; c.originalOwner = BOT_NAME; });

                    r.players.push("BOT_ID");
                    r.usernames.push(BOT_NAME);
                    r.pot.push(...botCards);
                    r.scores[BOT_NAME] = 0;
                    r.started = true;
                    r.isBotMatch = true;
                    r.pot.sort(() => Math.random() - 0.5);
                    r.turnIndex = 0; r.turnId = uid(); r.lastTurnTime = Date.now();

                    saveDB();
                    io.to(r.id).emit("game_start", {
                        roomId: r.id, pot: r.pot, currentTurn: r.players[0],
                        turnId: r.turnId, usernames: r.usernames
                    });
                } catch (err) { delete MATCHES[rid]; socket.emit("notification", "Erro ao iniciar duelo."); }
            }, 3000);
        } catch (err) { socket.emit("notification", "Erro interno."); }
    });

    socket.on('action_blow', d => {
        if (!d || !d.roomId) return;
        const r = MATCHES[d.roomId];
        if (!r) return;
        r._turnHadAction = true;
        r.lastTurnTime = Date.now();
        io.to(d.roomId).emit("action_blow", d);
    });

    socket.on("bot_play_trigger", rid => {
        const r = MATCHES[rid];
        if(r && r.isBotMatch && r.players[r.turnIndex]==="BOT_ID") io.to(rid).emit("bot_should_play", { turnId: r.turnId });
    });

    socket.on("card_flip_claim", (d) => {
        if (!d || !d.roomId) return;
        const r = MATCHES[d.roomId]; 
        if (!r) return;
        r._turnHadAction = true;
        const idx = r.pot.findIndex(c => c.uid === d.cardUID);
        if (idx === -1) return;
        const card = r.pot.splice(idx, 1)[0];
        const wName = d.winnerIsBot ? BOT_NAME : SOCKET_USER_MAP[socket.id];
        const loserName = card.originalOwner;
        r.scores[wName] = (r.scores[wName] || 0) + 1;
        if(!r.winningsValue) r.winningsValue = {};
        if(!r.winningsValue[wName]) r.winningsValue[wName] = 0;
        r.winningsValue[wName] += (RARITY_WEIGHTS[card.rarity] || 1) * 10;
        const loser = DATABASE.users[loserName];
        if(loser && loser.collection) {
            const lIdx = loser.collection.findIndex(c => c.uid === card.uid);
            if(lIdx > -1) loser.collection.splice(lIdx, 1);
        }
        const winner = DATABASE.users[wName];
        if(winner) winner.collection.push({ ...card, originalOwner: wName, flipped: false, acquiredAt: Date.now() });
        saveDB();
        io.to(r.id).emit("card_won", { 
            cardUID: card.uid, 
            winnerId: d.winnerIsBot ? "BOT_ID" : socket.id, 
            cardData: card, 
            scores: r.scores 
        });
        if(r.pot.length === 0) endGame(r);
    });

    function endGame(r) {
        try {
            const p1 = r.usernames?.[0]; 
            const p2 = r.usernames?.[1];
            if (!p1 || !p2) { delete MATCHES[r.id]; return; }
            
            const u1 = DATABASE.users[p1]; 
            const u2 = DATABASE.users[p2];
            if (!u1 || !u2) { delete MATCHES[r.id]; return; }

            const s1 = Number(r.scores?.[p1] || 0); 
            const s2 = Number(r.scores?.[p2] || 0);
            const elo1 = parseInt(u1.elo) || 1000; 
            const elo2 = parseInt(u2.elo) || 1000;
            
            let matchResult1 = 0.5; 
            let matchResult2 = 0.5;
            if (s1 > s2) { matchResult1 = 1; matchResult2 = 0; }
            else if (s2 > s1) { matchResult1 = 0; matchResult2 = 1; }

            const K = 48;
            const expected1 = 1 / (1 + Math.pow(10, (elo2 - elo1) / 400));
            const expected2 = 1 / (1 + Math.pow(10, (elo1 - elo2) / 400));

            let delta1 = Math.round(K * (matchResult1 - expected1));
            let delta2 = Math.round(K * (matchResult2 - expected2));

            if (matchResult1 === 1 && delta1 < 10) delta1 = 10;
            if (matchResult2 === 1 && delta2 < 10) delta2 = 10;
            if (matchResult1 === 0 && delta1 > -10) delta1 = -10;
            if (matchResult2 === 0 && delta2 > -10) delta2 = -10;

            u1.elo = Math.max(0, elo1 + delta1); 
            u2.elo = Math.max(0, elo2 + delta2);
            
            const rewards = { [p1]: { elo: delta1, gold: 0 }, [p2]: { elo: delta2, gold: 0 } };
            const winGold = 250; 
            const drawGold = 100;

            if (s1 > s2) {
                u1.gold = (u1.gold || 0) + winGold + (r.winningsValue?.[p1] || 0);
                rewards[p1].gold = winGold;
                LumiaCore.addXP(u1, 300, "duel_win", null); 
                LumiaCore.addXP(u2, 50, "duel_loss", null);
                LumiaMissions.check(u1, "duel_win", null, null);
                logUserActivity(u1, "DUELO", `Venceu ${p2} (+${delta1} ELO)`);
                logUserActivity(u2, "DUELO", `Perdeu para ${p1} (${delta2} ELO)`);
            } else if (s2 > s1) {
                u2.gold = (u2.gold || 0) + winGold + (r.winningsValue?.[p2] || 0);
                rewards[p2].gold = winGold;
                LumiaCore.addXP(u2, 300, "duel_win", null); 
                LumiaCore.addXP(u1, 50, "duel_loss", null);
                LumiaMissions.check(u2, "duel_win", null, null);
                logUserActivity(u2, "DUELO", `Venceu ${p1} (+${delta2} ELO)`);
                logUserActivity(u1, "DUELO", `Perdeu para ${p2} (${delta1} ELO)`);
            } else {
                u1.gold = (u1.gold || 0) + drawGold; 
                u2.gold = (u2.gold || 0) + drawGold;
                rewards[p1].gold = drawGold; 
                rewards[p2].gold = drawGold;
                logUserActivity(u1, "DUELO", `Empate com ${p2}`);
                logUserActivity(u2, "DUELO", `Empate com ${p1}`);
            }

            saveDB();

            const sid1 = u1.socketId;
            const sid2 = u2.socketId;
            if (sid1) io.to(sid1).emit("elo_update", { elo: u1.elo, delta: delta1 });
            if (sid2) io.to(sid2).emit("elo_update", { elo: u2.elo, delta: delta2 });

            for (const [sid, uname] of Object.entries(SOCKET_USER_MAP)) {
              if (uname === p1 && sid !== sid1) io.to(sid).emit("elo_update", { elo: u1.elo, delta: delta1 });
              if (uname === p2 && sid !== sid2) io.to(sid).emit("elo_update", { elo: u2.elo, delta: delta2 });
            }

            io.to(r.id).emit("game_over", { 
                message: s1 > s2 ? `${p1} Venceu!` : (s2 > s1 ? `${p2} Venceu!` : "Empate!"), 
                rewards 
            });
            delete MATCHES[r.id];
        } catch (e) { 
            console.error("Erro no endGame:", e);
            try { delete MATCHES[r.id]; } catch(_) {} 
        }
    }
    socket.on("turn_end_request", d => {
        const r = MATCHES[d.roomId];
        if(r) {
            r.turnIndex = (r.turnIndex+1)%2; r.turnId = uid(); r.lastTurnTime = Date.now();
            io.to(r.id).emit("new_turn", { nextTurn: r.players[r.turnIndex], turnId: r.turnId });
        }
    });

    socket.on("market_sell", d => {
        const u = DATABASE.users[SOCKET_USER_MAP[socket.id]];
        if (!u) return;
        const idx = u.collection.findIndex(c => c.uid === d.cardUID);
        if(idx > -1) {
            const c = u.collection.splice(idx,1)[0];
            DATABASE.market.push({ listingId: uid(), seller: u.username, card: c, price: parseInt(d.price) });
            saveDB(); 
            socket.emit("update_profile", u); 
            io.emit("market_update", DATABASE.market);
        }
    });

    socket.on("market_cancel", (lid) => {
        const u = DATABASE.users[SOCKET_USER_MAP[socket.id]];
        if (!u) return;
        const idx = DATABASE.market.findIndex(m => m.listingId === lid);
        if (idx > -1 && DATABASE.market[idx].seller === u.username) {
            const item = DATABASE.market[idx];
            DATABASE.market.splice(idx, 1);
            item.card.acquiredAt = Date.now();
            u.collection.push(item.card);
            saveDB(); 
            socket.emit("update_profile", u); 
            io.emit("market_update", DATABASE.market);
            socket.emit("notification", "Item recuperado do mercado.");
        }
    });

    socket.on("market_buy", (lid) => {
        const buyerName = SOCKET_USER_MAP[socket.id];
        const buyer = DATABASE.users[buyerName];
        if (!buyer) return socket.emit("notification", "Sessão inválida.");
        const idx = DATABASE.market.findIndex(m => m.listingId === lid);
        if (idx === -1) return socket.emit("notification", "Oferta já vendida.");
        
        const item = DATABASE.market[idx];
        const sellerName = item.seller;
        const seller = DATABASE.users[sellerName]; 
        const price = Math.max(1, parseInt(item.price) || 0);

        if (sellerName === buyer.username) return socket.emit("notification", "Erro: Auto-compra.");
        if ((buyer.gold || 0) < price) return socket.emit("notification", "Gold insuficiente.");

        DATABASE.market.splice(idx, 1);
        buyer.gold -= price;
        item.card.originalOwner = sellerName;
        item.card.acquiredAt = Date.now(); 
        buyer.collection.push(item.card);
        buyer.marketScore = (buyer.marketScore || 0) + Math.ceil(price * 0.05);

        if(!DATABASE.priceHistory) DATABASE.priceHistory = {};
        if(!DATABASE.priceHistory[item.card.name]) DATABASE.priceHistory[item.card.name] = [];
        DATABASE.priceHistory[item.card.name].push(price);
        if(DATABASE.priceHistory[item.card.name].length > 20) DATABASE.priceHistory[item.card.name].shift();

        if (seller) {
            seller.gold = (parseInt(seller.gold) || 0) + price;
            const sSid = seller.socketId || Object.keys(SOCKET_USER_MAP).find(k => SOCKET_USER_MAP[k] === sellerName);
            if (sSid) {
                io.to(sSid).emit("update_profile", seller); 
                io.to(sSid).emit("notification", `💰 Venda realizada: ${item.card.name} (+${price}g)`);
            }
        }
        
        saveDB();
        socket.emit("update_profile", buyer);
        socket.emit("notification", "Compra realizada!");
        io.emit("market_update", DATABASE.market);
    });

    socket.on("chat_send", msg => {
        const u = SOCKET_USER_MAP[socket.id];
        if(u && msg) io.emit("chat_message", { user: u, text: msg.substring(0, 140) });
    });

    socket.on("disconnect", () => {
        const uname = SOCKET_USER_MAP[socket.id];
        delete SOCKET_USER_MAP[socket.id];
        if (uname && DATABASE.users[uname]) DATABASE.users[uname].socketId = null;
        io.emit("online_count", io.engine.clientsCount);
        broadcastOnlineList();
    });

}); // Fechamento do io.on connection

const PORT = process.env.PORT || 8080;
http.listen(PORT, "0.0.0.0", () => { console.log("Bafo Multiverse v3.1 - Economy & Social Update READY on " + PORT); });