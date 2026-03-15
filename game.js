// --- INICIALIZAÇÃO DE SEGURANÇA (EVITA ERROS DE UNDEFINED) ---
window.marketData = [];
window.currentBinderTab = 'mtg';
window.currentRarityFilter = 'all';
window.selectedBet = [];

// Variáveis Globais de Jogo
const socket = io();
const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d", { alpha: false }); 

let width, height, dpr;
let gameState = "TITLE"; 

// Ajuste de Tela
function resize() {
    width = window.innerWidth;
    height = window.innerHeight;
    dpr = Math.min(window.devicePixelRatio || 1, 1.25);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
}
window.addEventListener("resize", resize);
resize();

// Variáveis de Estado
let myUser = null;
let currentRoom = null;
let currentTable = null;
let isMyTurn = false;
let currentTurnId = null;
let opponentName = "Oponente";

// Física do Bafo
let physicsCards = [];
let particles = [];
let flyingCards = [];
let floatTexts = [];
let isProcessingTurnEnd = false;
let turnCheckTimer = null;
const camera = { x: 0, y: 0, zoom: 1, panX: 0, panY: 0 };
const input = { active: false, startT: 0, x: 0, y: 0 };
const BOT_ID = "BOT_ID";

// Variáveis de Trade e Deck
let currentTradeId = null;
let activeDeck = { main: [], side: [], format: 'standard', name: 'Novo Deck' };
let mixer = { gold: 166, mana: 167, essence: 167 }; // Mixer State

// Configurações Visuais
const SLEEVES = {
    'default': { color: '#bdc3c7', border: '#7f8c8d' },
    'neon': { color: '#2d3436', border: '#00cec9', glow: true },
    'gold': { color: '#f1c40f', border: '#b8860b', texture: 'linear-gradient' },
    'void': { color: '#000', border: '#6c5ce7', stars: true },
    'red': { color: '#c0392b', border: '#e74c3c' }
};
const TIERS = { common: '♦', rare: '♦♦', epic: '♦♦♦', legend: '♦♦♦♦' };
const RARITY_COLORS = { common: '#bdc3c7', rare: '#0984e3', epic: '#6c5ce7', legend: '#f1c40f' };

// --- SISTEMA DE IMAGENS (CACHE + PROXY) ---
const imgCache = {};
const placeholderCanvas = document.createElement("canvas");
placeholderCanvas.width = 140; placeholderCanvas.height = 200;
const pCtx = placeholderCanvas.getContext("2d");

function getPlaceholder(text = "?") {
    pCtx.clearRect(0,0,140,200); pCtx.fillStyle = "#222"; pCtx.fillRect(0,0,140,200);
    pCtx.strokeStyle = "#00cec9"; pCtx.lineWidth = 4; pCtx.strokeRect(5,5,130,190);
    pCtx.fillStyle = "#fff"; pCtx.font = "bold 18px Arial"; pCtx.textAlign = "center"; pCtx.fillText(text, 70, 100);
    const img = new Image(); img.src = placeholderCanvas.toDataURL(); return img;
}

// --- SISTEMA DE IMAGENS ROBUSTO ---
// Cria um canvas para o placeholder de "Carregando"
const loadingCanvas = document.createElement("canvas");
loadingCanvas.width = 140; loadingCanvas.height = 200;
const lCtx = loadingCanvas.getContext("2d");
lCtx.fillStyle = "#222"; lCtx.fillRect(0,0,140,200);
lCtx.fillStyle = "#aaa"; lCtx.font = "bold 16px Arial"; lCtx.textAlign = "center"; 
lCtx.fillText("CARREGANDO...", 70, 100);

function getCardImage(url) {
    if (!url || typeof url !== "string" || url.length < 5) return loadingCanvas; // Retorna loading se sem URL
    
    if (imgCache[url]) return imgCache[url];

    const img = new Image();
    img.crossOrigin = "anonymous";
    
    // Lógica de Proxy: Só usa weserv se for http/https e não for local/base64
    let finalUrl = url;
    if(url.startsWith('http') && !url.includes('weserv') && !url.includes('base64')) {
        // Encode correto para evitar erros de URL malformada
        finalUrl = `https://images.weserv.nl/?url=${encodeURIComponent(url)}&w=300&output=jpg`;
    }
    
    img.src = finalUrl;
    
    // Cache instantâneo do objeto imagem (mesmo carregando)
    imgCache[url] = img; 
    
    return img;
}
// --- AUDIO SYSTEM ---
const music = { intro: document.getElementById('audio-intro'), bgm: document.getElementById('audio-bgm') };
let musicVol = 0.5;

// ==========================================================
// --- SOCKET LISTENERS (CORE) ---
// ==========================================================

socket.on('connect', () => {
    console.log("Conectado!");

    // Se já tivermos dados de usuário na memória (reconnect), tenta logar direto
    if (myUser && myUser.username) {
        socket.emit("login", { username: myUser.username });
    } else {
        // Se for a primeira vez, garante que vai para a tela de TÍTULO ou LOGIN
        // E esconde qualquer outra tela que possa ter vazado
        document.querySelectorAll('.active').forEach(e => e.classList.remove('active'));
        
        // Verifica se devemos mostrar login direto ou intro
        const savedUser = localStorage.getItem("bafo_username");
        if(savedUser) {
            showLoginScreen(true);
        } else {
            document.getElementById('screen-title').style.display = 'flex';
            document.getElementById('screen-title').classList.add('active');
            gameState = "TITLE";
        }
    }
});


socket.on('disconnect', () => {
    notify("Conexão perdida! Tentando reconectar...");
    if (gameState === "PLAYING" || gameState === "TABLE" || gameState === "SEARCHING") return;
    showLoginScreen(true);
});

socket.on('login_success', u => { 
    myUser = u;
    if(music.intro) music.intro.pause();
    if(music.bgm && music.bgm.paused) music.bgm.play().catch(()=>{});

    if (gameState === 'PLAYING' || gameState === 'TABLE' || gameState === 'SEARCHING') {
        updateHUD(); return; 
    }

    document.querySelectorAll('.active').forEach(e => e.classList.remove('active')); 
    document.getElementById('screen-menu').classList.add('active'); 
    gameState = "MENU";
    
	function showLoginScreen(force = false) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById('screen-login')?.classList.add('active');
    gameState = "LOGIN";
}

    updateHUD();
    socket.emit("get_ranking"); 
    
    // Carrega dados extras se existirem
    if(u.missions) window.renderMissions(u.missions.active);
    if(u.history) window.renderHistory(u.history);
});

// --- GARANTIA DE ATUALIZAÇÃO (SOCKET LISTENERS) ---

// Quando o servidor mandar atualização de perfil (venda, compra, duelo)
socket.on("update_profile", (u) => {
    if (!myUser) myUser = {};
    // Mescla os dados novos com os atuais
    myUser = { ...myUser, ...u };
    updateHUD(); // Atualiza os números na tela
    
    // Se a coleção estiver aberta, re-renderiza ela também
    if (document.getElementById('screen-collection')?.classList.contains('active')) {
        window.renderCollection();
    }
});

// Quando o ELO mudar (pós duelo)
socket.on("elo_update", (d) => {
    if(!d) return;
    if(!myUser) myUser = {};
    myUser.elo = d.elo; // Atualiza o dado local
    updateHUD(); // Reflete na tela
    
    const delta = d.delta;
    if(delta !== 0) notify(`${delta > 0 ? "📈" : "📉"} ELO: ${delta > 0 ? "+" : ""}${delta}`);
});

socket.on('notification', m => notify(m));
// --- CORREÇÃO DO CHAT SOCIAL ---
socket.on("chat_message", m => {
    const el = document.getElementById('chat-messages');
    if(!el) return;
    el.innerHTML += `<div style="margin-bottom:5px"><b style="color:${m.user === 'LumiaBot' ? '#00cec9' : '#f1c40f'}">[${m.user}]</b> ${m.text}</div>`;
    el.scrollTop = el.scrollHeight; // Rola pro fim automaticamente
});

// --- BAFO GAMEPLAY SOCKETS ---
socket.on('waiting_opponent', () => {
    gameState = "SEARCHING";
    const timerEl = document.getElementById('search-timer');
    if (timerEl) { timerEl.style.display = 'block'; timerEl.innerText = "Procurando oponente..."; }
    notify("Buscando oponente...");
});

socket.on('game_start', r => {
    const timerEl = document.getElementById('search-timer');
    if (timerEl) timerEl.style.display = 'none';

    currentRoom = r;
    gameState = 'PLAYING';
    isMyTurn = (r.currentTurn === socket.id);
    currentTurnId = r.turnId;
    isProcessingTurnEnd = false;
    
    // --- PRÉ-CARREGAMENTO DAS IMAGENS ---
    // Força o browser a começar a baixar as imagens imediatamente
    r.pot.forEach(c => {
        if(c.image) getCardImage(c.image);
    });

    physicsCards = r.pot.map(c => new PhysCard(c, (Math.random()-0.5)*100, (Math.random()-0.5)*100));
    
    input.active = false;
    camera.x = 0; camera.y = 0; camera.zoom = 0.8;

    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById('game-hud').style.display = 'flex';
    document.getElementById('score-board').style.display = 'flex';
    updateScoreBoard(0, 0);
    updateTurnBadge();
    setTimeout(() => { if(window.checkBotMove) window.checkBotMove(); }, 600);
});

socket.on("new_turn", d => { 
    if(!currentRoom) return; 
    currentTurnId = d.turnId; 
    currentRoom.currentTurn = d.nextTurn; 
    isMyTurn = (d.nextTurn === socket.id); 
    isProcessingTurnEnd = false;
    currentRoom._turnHadAction = false;
    currentRoom._botActionStarted = false;
    physicsCards.forEach(c => { 
        if(c instanceof PhysCard) {
            c.settled = false; c.vx += (Math.random()-0.5)*0.5;
        }
    });
    updateTurnBadge(); 
    setTimeout(() => { if(window.checkBotMove) window.checkBotMove(); }, 500);
});

// --- CORREÇÃO DO TURNO (PASSA MESMO SE NÃO VIRAR NADA) ---
socket.on('action_blow', d => {
    // AQUI ESTÁ A CORREÇÃO: Avisa o jogo que o jogador/bot BATEU (mesmo que erre)
    if(currentRoom) currentRoom._turnHadAction = true; 
    
    const r = 280 * (0.8 + d.pressure * 0.5); 
    physicsCards.forEach(c => {
        if (c.dead || !(c instanceof PhysCard)) return; 
        const dist = Math.hypot(c.x - d.x, c.y - d.y);
        if (dist < r) {
            const f = (1 - dist / r);
            const dx = (c.x - d.x) / (dist || 1); const dy = (c.y - d.y) / (dist || 1);
            c.vx += dx * f * 18; c.vy += dy * f * 18; 
            c.vz += 35 * d.pressure * f; c.velAngleX += 45 * d.pressure * f; 
            c.settled = false;
        }
    });
    for (let i = 0; i < 20; i++) particles.push(new Particle(d.x, d.y));
    
    if(turnCheckTimer) clearTimeout(turnCheckTimer);
    // Checa se o turno deve acabar em 600ms
    turnCheckTimer = setTimeout(checkTurnEnd, 600);
});

socket.on('card_won', d => {
    const i = physicsCards.findIndex(c => c.uid === d.cardUID);
    const myName = myUser.username;
    const p1Score = d.scores[myName] || 0;
    const p2Score = Object.entries(d.scores).find(([k,v]) => k !== myName)?.[1] || 0;
    updateScoreBoard(p1Score, p2Score);

    if(i > -1) {
        const card = physicsCards[i];
        card.dead = true; spawnFlyingCard(card, d.winnerId);
        
        const isMe = d.winnerId === socket.id;
        const color = isMe ? '#2ecc71' : '#e74c3c';
        const msg = isMe ? "MINE! (+1)" : "LOST!";
        floatTexts.push(new FloatingText(card.x, card.y - 50, msg, color, "40px"));
        for(let k=0; k<15; k++) particles.push(new Particle(card.x, card.y));
        if(isMe && window.sounds) window.sounds.win.play();

        physicsCards.splice(i, 1); 
        if(currentRoom) currentRoom._turnHadAction = true;
        
        if(physicsCards.length === 0) input.active = false;
        else setTimeout(checkTurnEnd, 800);
    }
});

socket.on('game_over', (d) => {
    notify(d?.message || "Fim de jogo!");
    setTimeout(() => {
        gameState = "MENU";
        currentRoom = null; isMyTurn = false; currentTurnId = null; isProcessingTurnEnd = false;
        document.getElementById('game-hud').style.display = 'none';
        document.getElementById('score-board').style.display = 'none';
        window.openMenu();
    }, 2500);
});

// --- TRADE 2.0 LISTENERS ---
socket.on("trade_invitation", (d) => {
    if(confirm(`Jogador ${d.from} quer negociar! Aceitar?`)) socket.emit("trade_accept", d.from);
});
socket.on("trade_start", (d) => {
    currentTradeId = d.tradeId;
    document.querySelectorAll('.active').forEach(e=>e.classList.remove('active'));
    document.getElementById('screen-trade-room').classList.add('active');
    
    const inv = document.getElementById('trade-inventory'); inv.innerHTML = '';
    myUser.collection.forEach(c => {
        const d = document.createElement('div'); d.className = 'grid-card'; d.style.backgroundImage = `url('${c.image}')`;
        d.onclick = () => socket.emit("trade_update_offer", { tradeId: currentTradeId, cardUID: c.uid });
        inv.appendChild(d);
    });
});
socket.on("trade_sync", (offers) => {
    const myName = myUser.username;
    const theirName = Object.keys(offers).find(k => k !== myName);
    const myOffer = offers[myName]; const theirOffer = offers[theirName];
    
    renderOfferGrid('trade-my-offer', myOffer.cards);
    document.getElementById('trade-my-lock').innerText = myOffer.locked ? "🔒 PRONTO" : "🔓 EDITANDO";
    renderOfferGrid('trade-their-offer', theirOffer.cards);
    document.getElementById('trade-their-gold').innerText = theirOffer.gold;
    document.getElementById('trade-their-lock').innerText = theirOffer.locked ? "🔒 PRONTO" : "🔓 EDITANDO";
    
    const btn = document.querySelector('#screen-trade-room .btn-green');
    btn.style.background = myOffer.locked ? "#e74c3c" : "#2ecc71";
    btn.innerText = myOffer.locked ? "DESTRAVAR" : "CONFIRMAR (TRAVAR)";
});
socket.on("trade_completed", () => { notify("Troca realizada com sucesso!"); window.openMenu(); });

// --- SOCIAL LISTENERS ---
socket.on("online_users_update", (list) => {
    const div = document.getElementById('online-users-list'); if(!div) return;
    div.innerHTML = '';
    list.forEach(u => {
        const row = document.createElement('div');
        row.style.padding = "5px"; row.style.borderBottom = "1px solid #444"; row.style.cursor = "pointer";
        row.innerHTML = `<span style="color:${u.username === myUser.username ? 'gold' : 'white'}">● ${u.username}</span> <span style="font-size:0.6rem; color:#888;">Lvl ${u.level}</span>`;
        row.onclick = () => { if(u.username !== myUser.username && confirm(`Convidar ${u.username} para troca?`)) socket.emit("trade_invite", u.username); };
        div.appendChild(row);
    });
    const badge = document.getElementById('online-counter'); if(badge) badge.innerText = `Online: ${list.length}`;
});
socket.on("global_goal_update", (goal) => {
    const pct = Math.min(100, (goal.current / goal.target) * 100);
    const bar = document.getElementById('goal-bar');
    const stats = document.getElementById('goal-stats');
    const desc = document.getElementById('goal-desc');
    if(bar) bar.style.width = pct + "%";
    if(stats) stats.innerText = `${Math.floor(goal.current)} / ${goal.target}`;
    if(desc) desc.innerText = goal.desc;
    if(pct >= 100 && !goal.animDone) { notify("🎉 META GLOBAL ATINGIDA!"); goal.animDone = true; }
});

// --- MARKET LISTENERS ---
socket.on('market_update', d => { 
    window.marketData = d;

    const screen = document.getElementById('screen-market');
    if(!screen || !screen.classList.contains('active')) return;

    // ✅ se estiver na aba meus itens -> renderiza meus itens
    if(window.marketTab === 'mine') {
        window.renderMyMarketItems();
    } else {
        window.renderMarket();
    }
});


// ==========================================================
// --- PHYSICS & GAME LOOP (BAFO) ---
// ==========================================================

class PhysCard {
    constructor(data, x, y) {
        this.data = data; this.uid = data.uid;
        this.x = x; this.y = y; this.z = 0;
        this.vx = 0; this.vy = 0; this.vz = 0;
        this.angleX = 0; this.velAngleX = 0;
        this.angleZ = Math.random() * 360; this.velAngleZ = 0;
        this.dead = false; this.settled = false;
    }
    update() {
        if (this.dead) return;
        if (this.settled && Math.abs(this.vz) < 0.1 && this.z === 0) return;
        this.x += this.vx; this.y += this.vy; this.z += this.vz;
        this.angleX += this.velAngleX; this.angleZ += this.velAngleZ;
        if (this.z > 0) this.vz -= 0.5;
        if (this.z <= 0) {
            this.z = 0;
            if (Math.abs(this.vz) > 1.5) { this.vz *= -0.4; } 
            else { 
                this.vz = 0; this.vx *= 0.7; this.vy *= 0.7; 
                this.velAngleX *= 0.6; this.velAngleZ *= 0.6; 
            }
            const mov = Math.abs(this.vx) + Math.abs(this.vy) + Math.abs(this.vz);
            if (mov < 0.5 && Math.abs(this.velAngleX) < 4.0) {
                this.vx=0; this.vy=0; this.vz=0; this.velAngleX=0; this.velAngleZ=0;
                let norm = this.angleX % 360; if (norm < 0) norm += 360;
                this.angleX = (norm > 90 && norm < 270) ? 180 : 0;
                this.settled = true; this.checkWin();
            } else {
                this.settled = false; this.velAngleX += (this.angleX % 180 > 90) ? 0.5 : -0.5;
            }
        } else { this.vx *= 0.99; this.vy *= 0.99; }
    }
    checkWin() {
        if (this.dead || !this.settled) return;
        const faceUp = Math.abs((this.angleX % 360) - 180) < 5;
        const turn = currentRoom?.currentTurn;
        const isBotTurn = (turn === BOT_ID || turn === "BOT_ID");
        if (faceUp && (isMyTurn || isBotTurn)) {
            socket.emit('card_flip_claim', { roomId: currentRoom.roomId || currentRoom.id, cardUID: this.uid, winnerIsBot: isBotTurn });
        }
    }
    draw(ctx) {
        if (this.dead) return;
        const d = 1 + (this.z / 600);
        const f = Math.cos(this.angleX * (Math.PI / 180));
        ctx.save(); ctx.translate(this.x, this.y - this.z); ctx.scale(d, Math.abs(f) * d); ctx.rotate(this.angleZ * Math.PI / 180);
        
        if (f < 0) { // FRENTE (Face Up)
            ctx.scale(-1, 1);
            
            const img = getCardImage(this.data.image);
            
            // Desenha a imagem SE estiver carregada, senão desenha o Loading
            if (img && img.complete && img.width > 0) {
                ctx.drawImage(img, -70, -100, 140, 200);
            } else {
                // Placeholder de Carregando (em vez de preto total)
                ctx.drawImage(loadingCanvas, -70, -100, 140, 200);
            }
            
            // Borda de Raridade
            ctx.lineWidth = 4; 
            ctx.strokeStyle = RARITY_COLORS[this.data.rarity] || '#ccc'; 
            ctx.strokeRect(-70, -100, 140, 200);
            
        } else { // VERSO (Sleeve)
            const sleeveID = this.data.sleeve || 'default';
            const style = SLEEVES[sleeveID] || SLEEVES['default'];
            ctx.fillStyle = style.color; ctx.fillRect(-70, -100, 140, 200);
            ctx.strokeStyle = style.border; ctx.lineWidth = 4; ctx.strokeRect(-65, -95, 130, 190);
            
            // Detalhe simples no verso pra não ficar chapado
            ctx.beginPath();
            ctx.arc(0, 0, 20, 0, Math.PI*2);
            ctx.fillStyle = "rgba(0,0,0,0.2)";
            ctx.fill();
        }
        ctx.restore();
    }
}

class Particle { 
    constructor(x, y) { this.x = x; this.y = y; this.life = 1; this.vx = (Math.random() - 0.5) * 10; this.vy = (Math.random() - 0.5) * 10; } 
    update() { this.x += this.vx; this.y += this.vy; this.life -= 0.08; } 
    draw(ctx) { if (this.life <= 0) return; ctx.save(); ctx.globalAlpha = this.life; ctx.fillStyle = 'gold'; ctx.fillRect(this.x - 3, this.y - 3, 6, 6); ctx.restore(); } 
}

class FloatingText {
    constructor(x, y, text, color, size = "20px") { this.x = x; this.y = y; this.text = text; this.color = color; this.life = 1.0; this.dy = -2; this.size = size; }
    update() { this.y += this.dy; this.life -= 0.02; }
    draw(ctx) { ctx.save(); ctx.globalAlpha = Math.max(0, this.life); ctx.font = `900 ${this.size} 'Titan One'`; ctx.fillStyle = this.color; ctx.strokeStyle = "black"; ctx.lineWidth = 4; ctx.strokeText(this.text, this.x, this.y); ctx.fillText(this.text, this.x, this.y); ctx.restore(); }
}

function updateCamera() {
    const targets = physicsCards.filter(c => !c.dead);
    const isMobile = Math.min(width, height) < 720;
    let targetX = 0, targetY = 0, targetZoom = 0.85;

    if (targets.length > 0) {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        targets.forEach(c => { if (c.x < minX) minX = c.x; if (c.x > maxX) maxX = c.x; if (c.y < minY) minY = c.y; if (c.y > maxY) maxY = c.y; });
        targetX = (minX + maxX) / 2; targetY = (minY + maxY) / 2;
        if (targets.length === 1) targetZoom = isMobile ? 1.0 : 1.2;
        else {
            const margin = isMobile ? 450 : 280;
            targetZoom = Math.min(width / ((maxX - minX) + margin), height / ((maxY - minY) + margin));
        }
        targetZoom = Math.max(isMobile ? 0.35 : 0.45, Math.min(1.1, targetZoom));
    }
    camera.x += (targetX + camera.panX - camera.x) * 0.08;
    camera.y += (targetY + camera.panY - camera.y) * 0.08;
    camera.zoom += (targetZoom - camera.zoom) * 0.06;
}

function loop() {
    ctx.clearRect(0, 0, width, height);
    if (gameState === 'PLAYING') {
        updateCamera();
        ctx.save(); ctx.translate(width / 2, height / 2); ctx.scale(camera.zoom, camera.zoom); ctx.translate(-camera.x, -camera.y);
        
        particles.forEach((p, i) => { p.update(); p.draw(ctx); if (p.life <= 0) particles.splice(i, 1); });
        physicsCards.forEach(c => { c.update(); c.draw(ctx); });
        floatTexts.forEach((ft, i) => { ft.update(); ft.draw(ctx); if(ft.life <= 0) floatTexts.splice(i, 1); });

        if (input.active && isMyTurn) {
            const dt = Math.min(Date.now() - input.startT, 800); const w = screenToWorld(input.x, input.y);
            ctx.beginPath(); ctx.arc(w.x, w.y, 50 + (dt / 10), 0, Math.PI * 2); ctx.strokeStyle = 'rgba(0, 243, 255, 0.8)'; ctx.lineWidth = 5 / camera.zoom; ctx.stroke();
        }
        ctx.restore();

        // Hud de cartas fora da tela
        physicsCards.forEach(c => {
            if (c.dead) return;
            const tx = (c.x - camera.x) * camera.zoom + width / 2;
            const ty = (c.y - camera.y) * camera.zoom + height / 2;
            if (tx < 0 || tx > width || ty < 0 || ty > height) {
                const angle = Math.atan2(ty - height / 2, tx - width / 2);
                const ex = Math.max(45, Math.min(width - 45, tx)); const ey = Math.max(45, Math.min(height - 45, ty));
                ctx.save(); ctx.translate(ex, ey); ctx.rotate(angle); ctx.beginPath(); ctx.moveTo(15, 0); ctx.lineTo(-10, -12); ctx.lineTo(-10, 12); ctx.closePath();
                ctx.fillStyle = RARITY_COLORS[c.data.rarity] || 'gold'; ctx.fill(); ctx.restore();
            }
        });

        flyingCards.forEach((fc, i) => {
            fc.x += (fc.tx - fc.x) * 0.1; fc.y += (fc.ty - fc.y) * 0.1; fc.scale -= 0.02;
            ctx.save(); ctx.translate(fc.x, fc.y); ctx.scale(fc.scale, fc.scale);
            const img = getCardImage(fc.image); if (img) ctx.drawImage(img, -40, -60, 80, 120);
            ctx.restore();
            if (fc.scale <= 0) flyingCards.splice(i, 1);
        });
    }
    requestAnimationFrame(loop);
}
loop();

// ==========================================================
// --- INPUT HANDLING ---
// ==========================================================
let isDraggingCam = false; let lastCamX = 0, lastCamY = 0;

function startIn(x, y) {
    if (gameState !== 'PLAYING') return;
    const w = screenToWorld(x, y);
    const isOverCard = physicsCards.some(c => !c.dead && Math.hypot(c.x - w.x, c.y - w.y) < 130);
    if (isMyTurn && isOverCard) {
        input.active = true; input.startT = Date.now(); input.x = x; input.y = y; isDraggingCam = false;
    } else {
        isDraggingCam = true; lastCamX = x; lastCamY = y; input.active = false;
    }
}
function moveIn(x, y) {
    if (gameState !== 'PLAYING') return;
    if (input.active) { input.x = x; input.y = y; return; }
    if (isDraggingCam) {
        camera.panX -= (x - lastCamX) / camera.zoom; camera.panY -= (y - lastCamY) / camera.zoom;
        lastCamX = x; lastCamY = y;
    }
}
function endIn() {
    if (gameState !== 'PLAYING') return;
    if (input.active && isMyTurn && currentRoom) {
        const w = screenToWorld(input.x, input.y);
        socket.emit('action_blow', { roomId: currentRoom.roomId || currentRoom.id, turnId: currentTurnId, x: w.x, y: w.y, pressure: Math.min(Date.now() - input.startT, 800) / 800 });
    }
    isDraggingCam = false; input.active = false;
}

canvas.addEventListener('mousedown', e => startIn(e.clientX, e.clientY));
window.addEventListener('mousemove', e => moveIn(e.clientX, e.clientY));
window.addEventListener('mouseup', endIn);
canvas.addEventListener('touchstart', e => { startIn(e.touches[0].clientX, e.touches[0].clientY); if (input.active || isDraggingCam) e.preventDefault(); }, { passive: false });
canvas.addEventListener('touchmove', e => { if (input.active || isDraggingCam) { moveIn(e.touches[0].clientX, e.touches[0].clientY); e.preventDefault(); } }, { passive: false });
canvas.addEventListener('touchend', endIn);

// ==========================================================
// --- FUNÇÕES DE UI E LÓGICA DE JOGO (RESTAURADAS) ---
// ==========================================================

// --- CORREÇÃO DA HUD (VISUALIZAÇÃO DE STATUS) ---
function updateHUD() {
    if(!myUser) return;
    
    // 1. Recursos Básicos
    document.getElementById('gold-display').innerText = Math.floor(myUser.gold || 0);
    document.getElementById('mana-display').innerText = Math.floor(myUser.mana || 0);
    document.getElementById('essence-display').innerText = Math.floor(myUser.essence || 0);
    
    // 2. Rankings e Elos (Puxando dados reais)
    const eloEl = document.getElementById('elo-display');
    const marketEl = document.getElementById('market-score-display');
    const powerEl = document.getElementById('collection-power-display');

    // Elo de Duelo
    if(eloEl) eloEl.innerText = myUser.elo || 1000;
    
    // Elo de Mercado (Market Score)
    if(marketEl) marketEl.innerText = myUser.marketScore || 0;
    
    // Elo de Coleção (Cálculo em tempo real igual ao servidor)
    // Pesos: Comum=10, Rara=30, Épica=100, Lendária=500
    const powerWeights = { 'common': 10, 'rare': 30, 'epic': 100, 'legend': 500 };
    const power = (myUser.collection || []).reduce((acc, card) => {
        // Normaliza a raridade para lowercase para bater com a chave
        const r = (card.rarity || 'common').toLowerCase();
        return acc + (powerWeights[r] || 10);
    }, 0);
    
    if(powerEl) powerEl.innerText = power;

    // Atualiza também o contador total de cartas se existir
    const totalCardsEl = document.getElementById('total-cards-display');
    if(totalCardsEl) totalCardsEl.innerText = (myUser.collection || []).length;

    // 3. Barra de Nível e XP
    const lvl = myUser.level || 1;
    const xp = myUser.xp || 0;
    // Mesma fórmula do servidor: Base 100 * (Nível ^ 1.2)
    const nextXp = Math.floor(100 * Math.pow(lvl, 1.2)); 
    
    const lvlNum = document.getElementById('hud-level');
    const xpCurr = document.getElementById('hud-xp-curr');
    const xpMax = document.getElementById('hud-xp-max');
    const xpBar = document.getElementById('hud-xp-bar');

    if(lvlNum) lvlNum.innerText = lvl;
    if(xpCurr) xpCurr.innerText = Math.floor(xp);
    if(xpMax) xpMax.innerText = nextXp;
    
    if(xpBar) {
        const pct = Math.min(100, (xp / nextXp) * 100);
        xpBar.style.width = pct + '%';
    }
}
// --- NAVEGAÇÃO DE SETS (CORREÇÃO) ---
const SET_KEYS = ['mtg', 'pokemon', 'lorcana'];

window.nextSet = function() {
    let currentIdx = SET_KEYS.indexOf(window.currentBinderTab || 'mtg');
    if (currentIdx === -1) currentIdx = 0;
    
    // Avança para o próximo (loop circular)
    const nextIdx = (currentIdx + 1) % SET_KEYS.length;
    window.switchBinderTab(SET_KEYS[nextIdx]);
};

window.prevSet = function() {
    let currentIdx = SET_KEYS.indexOf(window.currentBinderTab || 'mtg');
    if (currentIdx === -1) currentIdx = 0;
    
    // Volta para o anterior (loop circular)
    const prevIdx = (currentIdx - 1 + SET_KEYS.length) % SET_KEYS.length;
    window.switchBinderTab(SET_KEYS[prevIdx]);
};
// --- BOOSTER MIXER (RESTAURADA) ---
window.openBoosterMixer = () => {
    document.querySelectorAll('.active').forEach(e=>e.classList.remove('active'));
    document.getElementById('screen-booster-mix').classList.add('active');
    mixer = { gold: 166, mana: 167, essence: 167 }; updateMixerUI();
};
window.adjustMixer = (type, val) => {
    const t = 500; let v = parseInt(val); if(v<0)v=0; if(v>t)v=t; mixer[type]=v;
    const r = t - v; const k = Object.keys(mixer).filter(key=>key!==type);
    mixer[k[0]] = Math.floor(r/2); mixer[k[1]] = r - mixer[k[0]];
    updateMixerUI();
};
function updateMixerUI() { ['gold','mana','essence'].forEach(k => { document.getElementById('mix-'+k).value=mixer[k]; document.getElementById('val-'+k).innerText=mixer[k]; }); }
window.confirmBoosterBuy = function() {
    const total = mixer.gold + mixer.mana + mixer.essence;
    if(total !== 500) return notify("O custo total deve ser exatamente 500!");
    if(!myUser || (myUser.gold||0) < mixer.gold || (myUser.mana||0) < mixer.mana || (myUser.essence||0) < mixer.essence) return notify("Recursos insuficientes.");
    if(window.sounds) window.sounds.openPack.play();
    if(window.sporeGather) window.sporeGather();
    socket.emit("buy_booster_multiverse", mixer);
    document.getElementById('screen-booster-mix').classList.remove('active');
};
socket.on('booster_opened', c => {
    if(window.sporeExplode) window.sporeExplode();
    document.querySelectorAll('.active').forEach(e=>e.classList.remove('active'));
    
    const d = document.getElementById('booster-display'); d.innerHTML='';
    
    c.forEach((card, i) => {
        const el = document.createElement('div'); el.className='booster-card';
        
        // Verifica se era nova ANTES de abrir (assumindo que o server já add na coleção, 
        // a gente verifica se count == 1, ou seja, essa é a única)
        // Como o server já adicionou, se count == 1 é NOVA. Se count > 1 é repetida.
        const count = myUser.collection.filter(x => x.name === card.name).length;
        const isNew = count === 1;
        
        const tag = isNew 
            ? `<span style="position:absolute; top:-10px; left:50%; transform:translateX(-50%); background:#00cec9; color:black; font-weight:bold; padding:2px 8px; border-radius:10px; font-size:0.7rem; box-shadow:0 0 10px #00cec9; z-index:20;">NOVA!</span>`
            : `<span style="position:absolute; top:-10px; left:50%; transform:translateX(-50%); background:#333; color:#aaa; font-weight:bold; padding:2px 8px; border-radius:10px; font-size:0.7rem; border:1px solid #555; z-index:20;">DUPLICATA</span>`;

        el.innerHTML = `
            ${tag}
            <div class="front">
                <img src="${card.image}" alt="">
                <span style="position:absolute;top:2px;left:2px;color:white;text-shadow:1px 1px 0 #000">${TIERS[card.rarity]}</span>
            </div>
            <div class="back"></div>
        `;
        
        el.style.opacity='0'; 
        el.style.transform = `scale(0.5) rotateY(180deg) translateY(100px)`;
        el.onclick = () => window.inspectCard(card.image, card.name, card.rarity, card.uid, card); // Passa 'card' completo para ver set_name
        d.appendChild(el);
        
        setTimeout(() => { 
            el.style.opacity='1'; 
            el.style.transform = `scale(1) rotateY(0deg) rotateZ(${(i-1)*5}deg)`; 
        }, i*200+100);
    });
    
    document.getElementById('screen-booster').classList.add('active');
});

// --- BANK (RESTAURADA) ---
window.openBank = () => { 
    document.querySelectorAll('.active').forEach(e=>e.classList.remove('active')); 
    document.getElementById('screen-bank').classList.add('active'); 
    window.switchBankTab('exchange');
};
window.switchBankTab = function(t) {
    document.querySelectorAll('.bank-content').forEach(c => c.classList.remove('active'));
    document.getElementById('view-' + t).classList.add('active');
    if (t === 'vault') startVault(); else vaultActive = false;
};
window.performSwap = function() {
    const amt = parseInt(document.getElementById('swap-amount').value || "0");
    const from = document.getElementById('swap-from').value;
    const to = document.getElementById('swap-to').value;
    if(!amt || amt <= 0 || from === to) return notify("Troca inválida.");
    if(window.sounds) window.sounds.swap.play();
    socket.emit("currency_swap", { from, to, amount: amt });
};

// --- COLLECTION RENDER ---
// --- NOVO RENDERIZADOR DE ÁLBUM (COM GAPS E DADOS) ---
const SET_INFOS = {
    'mtg': { name: 'Magic: The Gathering', total: 300, release: 'Alpha Edition', color: '#f1c40f' },
    'pokemon': { name: 'Pokémon TCG', total: 1025, release: 'National Dex', color: '#00cec9' },
    'lorcana': { name: 'Disney Lorcana', total: 204, release: 'The First Chapter', color: '#bd00ff' }
};

window.renderCollection = function() {
    const g = document.getElementById('collection-grid');
    if(!g || !myUser) return;
    g.innerHTML = '';

    const sourceMap = { 'mtg': 'Magic', 'pokemon': 'Pokemon', 'lorcana': 'Lorcana' };
    const currentSource = sourceMap[window.currentBinderTab || 'mtg'];

    // Filtra as cartas do Universo atual
    const myCards = myUser.collection.filter(c => c.source === currentSource);

    if(myCards.length === 0) {
        g.innerHTML = `<div style="grid-column: 1/-1; text-align:center; padding:30px; color:#777; font-family:'Cinzel';">Nenhuma relíquia desta dimensão encontrada. Abra mais pacotes!</div>`;
        return;
    }

    // 1. Agrupa as cartas pelas Edições (Sets) Reais
    const sets = {};
    myCards.forEach(c => {
        const sName = c.set_name || 'Edição Base';
        if(!sets[sName]) sets[sName] = { cards: [], uniqueMap: {} };
        sets[sName].cards.push(c);
        
        // Agrupa duplicatas da mesma carta
        if(!sets[sName].uniqueMap[c.name]) sets[sName].uniqueMap[c.name] = [];
        sets[sName].uniqueMap[c.name].push(c);
    });

    // 2. Renderiza cada Edição como uma sessão do Fichário
    Object.keys(sets).sort().forEach(setName => {
        const setData = sets[setName];
        const uniqueStacks = Object.values(setData.uniqueMap);
        
        // Tenta pegar o total de cartas do set (vem do server), fallback pra '???'
        const totalInSet = uniqueStacks[0][0].total_in_set || '???'; 
        let pct = 0;
        let isComplete = false;

        if (totalInSet !== '???' && !isNaN(totalInSet)) {
            pct = Math.floor((uniqueStacks.length / totalInSet) * 100);
            if (pct >= 100) { pct = 100; isComplete = true; }
        }

        // --- CRIA O CABEÇALHO DA EDIÇÃO (DIVISÓRIA) ---
        const setDiv = document.createElement('div');
        setDiv.className = 'set-group';
        setDiv.innerHTML = `
            <div class="set-header">
                <div class="set-title-row">
                    <span class="set-name">${setName.toUpperCase()}</span>
                    <span class="set-progress-text">${uniqueStacks.length} / ${totalInSet}</span>
                </div>
                <div class="set-bar-bg">
                    <div class="set-bar-fill ${isComplete ? 'complete' : ''}" style="width: ${totalInSet === '???' ? 100 : pct}%;"></div>
                </div>
            </div>
            <div class="set-grid"></div>
        `;
        g.appendChild(setDiv);

        const setGrid = setDiv.querySelector('.set-grid');

        // --- RENDERIZA AS CARTAS DENTRO DA EDIÇÃO ---
        // Tenta ordenar pelo número da carta
        uniqueStacks.sort((a,b) => parseInt(a[0].number || 0) - parseInt(b[0].number || 0)).forEach(stack => {
            const item = stack[0];
            
            // Filtro de raridade visual
            if (window.currentRarityFilter !== 'all' && item.rarity !== window.currentRarityFilter) return;

            const d = document.createElement('div');
            d.className = `binder-slot rarity-${item.rarity}`;

            // Proxy de imagem seguro
            let bgUrl = item.image;
            if(bgUrl && bgUrl.startsWith('http') && !bgUrl.includes('weserv')) {
                 bgUrl = `https://images.weserv.nl/?url=${encodeURIComponent(bgUrl)}&w=200&output=jpg`;
            }

            d.innerHTML = `
                <div class="binder-card" style="background-image:url('${bgUrl}')">
                    <div style="position:absolute; top:2px; left:2px; font-size:0.6rem; text-shadow:1px 1px 0 #000; color:${RARITY_COLORS[item.rarity]}">${TIERS[item.rarity]}</div>
                    <div style="position:absolute; bottom:2px; right:2px; font-size:0.6rem; background:rgba(0,0,0,0.8); padding:1px 4px; border-radius:4px; border:1px solid rgba(255,255,255,0.2);">#${item.number || '?'}</div>
                </div>
                <div class="binder-info">
                    <span class="b-name">${item.name}</span>
                    <span class="b-count" style="${stack.length > 1 ? '' : 'color:#555; text-shadow:none;'}">x${stack.length}</span>
                </div>`;
            
            d.onclick = () => window.inspectCard(item.image, item.name, item.rarity, item.uid, item);
            setGrid.appendChild(d);
        });
    });
};
window.switchBinderTab = function(t) { window.currentBinderTab = t; document.querySelectorAll('.binder-tab').forEach(b => b.classList.remove('active')); document.getElementById('tab-' + t).classList.add('active'); window.renderCollection(); };
window.filterCollection = function(rarity, btn) { window.currentRarityFilter = rarity; document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active')); btn.classList.add('active'); window.renderCollection(); };

// --- MARKET RENDER ---
window.renderMarket = function() {
    const g = document.getElementById('market-grid'); if(!g) return; g.innerHTML = '';
    (window.marketData || []).forEach(m => {
        const d = document.createElement('div'); d.className = 'market-card';
        d.innerHTML = `<div class="grid-card" style="background-image:url('${m.card.image}')"></div><div class="m-info"><div>${m.card.name.slice(0,12)}</div><button class="btn btn-green" onclick="socket.emit('market_buy','${m.listingId}')">💰${m.price}</button></div>`;
        g.appendChild(d);
    });
};

// ✅ Mercado: Tabs
window.marketTab = 'all';

window.switchMarketTab = function(tab){
  window.marketTab = tab;
  const gridAll = document.getElementById('market-grid');
  const gridMine = document.getElementById('market-my-grid');
  if(!gridAll || !gridMine) return;

  if(tab === 'mine'){
    gridAll.style.display = 'none';
    gridMine.style.display = 'grid';
    window.renderMyMarketItems();
  } else {
    gridAll.style.display = 'grid';
    gridMine.style.display = 'none';
    window.renderMarket();
  }
};

// ✅ Render: Meus Itens
window.renderMyMarketItems = function(){
  const g = document.getElementById('market-my-grid');
  if(!g) return;
  g.innerHTML = '';

  const me = (myUser && myUser.username) ? myUser.username : null;

  if(!me){
    g.innerHTML = `<div style="padding:15px; color:#aaa;">Faça login para ver seus itens.</div>`;
    return;
  }

  const mine = (window.marketData || []).filter(m => m.seller === me);

  if(mine.length === 0){
    g.innerHTML = `<div style="padding:15px; color:#777;">Você não tem itens listados.</div>`;
    return;
  }

  mine.forEach(m => {
    const d = document.createElement('div');
    d.className = 'market-card';

    d.innerHTML = `
      <div class="grid-card" style="
        background-image:url('${m.card.image}');
        width:100%;
        aspect-ratio:2.5/3.5;
        background-size:cover;
        background-position:center;
        border-radius:6px;
        border: 2px solid ${RARITY_COLORS[m.card.rarity] || '#555'};
      "></div>

      <div class="m-info" style="margin-top:5px; text-align:center;">
        <div style="font-size:0.7rem; color:#ccc; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
          ${m.card.name}
        </div>

        <div style="font-size:0.75rem; color:gold; margin-top:2px;">💰 ${m.price}g</div>

        <button class="btn" style="padding:2px 10px; font-size:0.75rem; margin-top:5px; background:#e74c3c;"
          onclick="socket.emit('market_cancel','${m.listingId}')">
          ❌ RETIRAR
        </button>
      </div>
    `;

    g.appendChild(d);
  });
};


// --- INSPECTOR ---
// ==========================================================
// --- INSPECTOR 3D (INTERATIVO) ---
// ==========================================================
let inspRot = { x: 0, y: 0 };
let isInspDragging = false;
let lastInspPos = { x: 0, y: 0 };

// --- INSPECTOR APRIMORADO ---
window.inspectCard = function(url, name, rarity, uid, cardData) {
    const insp = document.getElementById('card-inspector');
    const img = document.getElementById('inspector-img');
    const data = document.getElementById('inspector-data');
    
    // Reset da rotação
    inspRot = { x: 0, y: 0 };
    img.style.transform = `rotateX(0deg) rotateY(0deg)`;
    img.classList.remove('fullscreen'); 
    
    img.style.backgroundImage = `url('${url}')`;
    
    // --- MONTAGEM DOS DADOS EXTRAS ---
    let extraInfoHtml = "";
    
    if(cardData) {
        // Dados de Mercado
        const baseVal = cardData.baseValue || 0;
        
        // Dados de Coleção (Edição e Numeração)
        // Fallback: Se não tiver set_name, usa o source. Se não tiver numero, usa "?".
        const setName = cardData.set_name || cardData.source || "Desconhecido";
        const setCode = cardData.set_id || "???";
        const cardNum = cardData.number || "??";
        const totalSet = cardData.total_in_set || "??";
        
        extraInfoHtml = `
            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px; margin-top:15px; text-align:left; background:rgba(0,0,0,0.3); padding:10px; border-radius:8px;">
                <div style="font-size:0.6rem; color:#aaa;">COLEÇÃO</div>
                <div style="font-size:0.6rem; color:#aaa; text-align:right;">NÚMERO</div>
                
                <div style="font-size:0.8rem; color:white; font-weight:bold; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${setName}</div>
                <div style="font-size:0.8rem; color:white; font-weight:bold; text-align:right;">#${cardNum} <span style="color:#666">/ ${totalSet}</span></div>
            </div>

            <div style="margin-top:10px; padding:8px; background:rgba(46, 204, 113, 0.15); border:1px solid #2ecc71; border-radius:5px; display:flex; justify-content:space-between; align-items:center;">
                <span style="font-size:0.7rem; color:#2ecc71; font-weight:bold;">VALOR ESTIMADO</span>
                <span style="font-size:1.1rem; color:white; font-family:'Titan One'; text-shadow:0 0 5px #2ecc71;">${baseVal} G</span>
            </div>
        `;
    }

    data.style.display = 'block';
    data.innerHTML = `
        <h2 style="margin:0; font-family:'Titan One'; font-size:1.4rem; color:white; text-shadow:0 2px 4px black; line-height:1.1;">${name}</h2>
        <div style="color:${RARITY_COLORS[rarity] || '#ccc'}; font-size:0.8rem; margin-top:5px; letter-spacing:2px; font-weight:bold;">${rarity.toUpperCase()}</div>
        
        ${extraInfoHtml}
    `;
    
    // Botão de vender (se for minha carta)
    if (myUser && myUser.collection && myUser.collection.some(c => c.uid === uid)) {
        data.innerHTML += `<div style="margin-top:15px;"><button class="btn btn-green" onclick="window.sellCurrentCard('${uid}')">💰 VENDER NO MERCADO</button></div>`;
    }
    
    insp.classList.add('active');
};

// Toggle Fullscreen e Ativa Rotação
window.toggleInspectorFullscreen = function() { 
    const img = document.getElementById('inspector-img');
    const data = document.getElementById('inspector-data');
    
    img.classList.toggle('fullscreen');
    // Se estiver fullscreen, esconde dados para focar na arte
    if(img.classList.contains('fullscreen')) {
        data.style.display = 'none';
        notify("Arraste para girar a carta!");
    } else {
        data.style.display = 'block';
        // Reseta rotação ao sair
        inspRot = { x: 0, y: 0 };
        img.style.transform = `rotateX(0deg) rotateY(0deg)`;
    }
};

// Listeners de Rotação 3D
const inspEl = document.getElementById('card-inspector');

function handleInspStart(x, y) {
    const img = document.getElementById('inspector-img');
    if(img.classList.contains('fullscreen')) {
        isInspDragging = true;
        lastInspPos = { x, y };
    }
}

function handleInspMove(x, y) {
    if(!isInspDragging) return;
    const dx = x - lastInspPos.x;
    const dy = y - lastInspPos.y;
    
    // Sensibilidade
    inspRot.y += dx * 0.5; // Eixo Y gira horizontalmente
    inspRot.x -= dy * 0.5; // Eixo X gira verticalmente
    
    // TRAVA RADIAL (Limite de 60 graus para não ver verso)
    inspRot.x = Math.max(-60, Math.min(60, inspRot.x));
    inspRot.y = Math.max(-60, Math.min(60, inspRot.y));
    
    const img = document.getElementById('inspector-img');
    img.style.transform = `perspective(1000px) rotateX(${inspRot.x}deg) rotateY(${inspRot.y}deg)`;
    
    lastInspPos = { x, y };
}

function handleInspEnd() { isInspDragging = false; }

// Adiciona Listeners ao Inspector
inspEl.addEventListener('mousedown', e => handleInspStart(e.clientX, e.clientY));
inspEl.addEventListener('mousemove', e => handleInspMove(e.clientX, e.clientY));
inspEl.addEventListener('mouseup', handleInspEnd);
inspEl.addEventListener('touchstart', e => { handleInspStart(e.touches[0].clientX, e.touches[0].clientY); }, {passive:false});
inspEl.addEventListener('touchmove', e => { handleInspMove(e.touches[0].clientX, e.touches[0].clientY); e.preventDefault(); }, {passive:false});
inspEl.addEventListener('touchend', handleInspEnd);
window.sellCurrentCard = function(uid) {
    const p = prompt("Valor de Venda (Gold):"); if(p) { socket.emit('market_sell', { cardUID: uid, price: parseInt(p) }); window.closeInspector(); notify("Carta listada!"); }
};
window.closeInspector = function() { document.getElementById('card-inspector').classList.remove('active'); };
window.toggleInspectorFullscreen = function() { 
    const img = document.getElementById('inspector-img');
    img.classList.toggle('fullscreen');
};

// --- MISSIONS & HISTORY ---
window.renderMissions = (list) => {
    const el = document.getElementById('missions-list'); if(!el) return; el.innerHTML = '';
    if(!list || list.length===0) { el.innerHTML = "Nenhuma missão."; return; }
    list.forEach(m => { el.innerHTML += `<div class="mission-card ${m.completed?'completed':''}"><div class="m-title">${m.desc}</div><div class="m-desc">${m.progress}/${m.target}</div></div>`; });
};
window.renderHistory = (list) => {
    const el = document.getElementById('history-list'); if(!el) return; el.innerHTML = '';
    list.forEach(h => {
        const date = new Date(h.time);
        el.innerHTML += `<div class="log-item"><div class="log-time">${date.getHours()}:${date.getMinutes()}</div><div class="log-tag">${h.type}</div><div>${h.msg}</div></div>`;
    });
};

// --- NAVIGATION & TRADE ---
window.openMenu = () => { document.querySelectorAll('.active').forEach(e=>e.classList.remove('active')); document.getElementById('screen-menu').classList.add('active'); updateHUD(); };
window.openCollection = () => { document.querySelectorAll('.active').forEach(e=>e.classList.remove('active')); document.getElementById('screen-collection').classList.add('active'); window.renderCollection(); };
window.openMarket = () => { document.querySelectorAll('.active').forEach(e=>e.classList.remove('active')); document.getElementById('screen-market').classList.add('active'); window.renderMarket(); };
window.openMissions = () => { document.querySelectorAll('.active').forEach(e=>e.classList.remove('active')); document.getElementById('screen-missions').classList.add('active'); };
window.openHistory = () => { document.querySelectorAll('.active').forEach(e=>e.classList.remove('active')); document.getElementById('screen-history').classList.add('active'); };
window.openRanking = () => { socket.emit("get_ranking"); document.querySelectorAll('.active').forEach(e=>e.classList.remove('active')); document.getElementById('screen-ranking').classList.add('active'); };
window.doLogin = () => { const u = document.getElementById('login-user').value; if(u) socket.emit("login", { username: u }); };
window.toggleChat = () => document.getElementById('screen-chat').classList.toggle('active');
window.sendChat = () => { const t=document.getElementById('chat-input'); if(t.value){socket.emit('chat_send',t.value); t.value='';} };
window.createMatch = () => { 
    // Validação de Regras (1, 3 ou 5 cartas)
    if(window.selectedBet && [1, 3, 5].includes(window.selectedBet.length)) {
        socket.emit('create_match', window.selectedBet); 
        
        // Feedback de Busca
        const timer = document.getElementById('search-timer');
        if(timer) {
            timer.style.display = 'block';
            timer.innerText = "🔍 Buscando oponente digno...";
        }
        notify("Entrando na fila ranqueada...");
        
        // Desabilita botão para evitar spam
        const btn = document.querySelector('#screen-bet .btn-green');
        if(btn) { 
            const oldText = btn.innerText;
            btn.innerText = "BUSCANDO..."; 
            btn.disabled = true;
            // Destrava depois de 5s caso falhe
            setTimeout(() => { btn.innerText = oldText; btn.disabled = false; }, 5000);
        }
        
    } else {
        notify("Regra: Selecione exatamente 1, 3 ou 5 cartas para apostar!");
    }
};
// --- SISTEMA DE APOSTAS RANKED (CORRIGIDO) ---
// --- SISTEMA DE APOSTAS RANKED (CORRIGIDO) ---
// --- SISTEMA DE APOSTAS RANKED (GRID COMPACTO) ---
// --- SISTEMA DE APOSTAS RANKED (COM FILTROS) ---
// --- SISTEMA DE APOSTAS RANKED (CORRIGIDO E FIXADO) ---
// --- SISTEMA DE APOSTAS RANKED (CORRIGIDO) ---
window.currentBetFilter = 'all';

window.openBetting = () => { 
    if(!myUser || !myUser.collection) return notify("Erro: Coleção não carregada. Faça login novamente.");
    
    window.selectedBet = []; 
    
    // 1. Reseta o botão para o estado inicial
    const btn = document.querySelector('#screen-bet .btn-green');
    if(btn) { 
        btn.innerText = "JOGAR RANKED (0/5)"; 
        btn.disabled = false; 
    }

    // 2. Renderiza as cartas
    renderBettingGrid();

    // 3. Só AGORA abre a tela (dentro da função, não fora!)
    document.querySelectorAll('.active').forEach(e => e.classList.remove('active')); 
    document.getElementById('screen-bet').classList.add('active');
};

window.filterBet = (rarity, btn) => {
    window.currentBetFilter = rarity;
    document.querySelectorAll('#screen-bet .filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderBettingGrid();
};

function renderBettingGrid() {
    const g = document.getElementById('bet-grid'); 
    if(!g) return;
    g.innerHTML = ''; 
    
    // Segurança contra crash se collection for null
    let list = [...(myUser.collection || [])];

    // 1. Lógica de Filtros
    if (window.currentBetFilter === 'duplicates') {
        // Conta quantas vezes cada carta aparece
        const counts = {};
        list.forEach(c => { counts[c.name] = (counts[c.name] || 0) + 1; });
        
        // Filtra apenas as que têm mais de 1 cópia
        list = list.filter(c => counts[c.name] > 1);
    } 
    else if (window.currentBetFilter !== 'all') {
        // Filtro normal de raridade
        list = list.filter(c => c.rarity === window.currentBetFilter);
    }

    // 2. Ordenação (Raridade Alta primeiro)
    list.sort((a,b) => {
        const weights = { legend: 4, epic: 3, rare: 2, common: 1 };
        return (weights[b.rarity] || 0) - (weights[a.rarity] || 0);
    });

    if(list.length === 0) {
        g.innerHTML = '<div style="color:#777; padding:20px; grid-column: 1 / -1; text-align:center;">Nenhuma carta encontrada com este filtro.</div>';
        return;
    }

    list.forEach(c => { 
        const d = document.createElement('div'); 
        d.className = `bet-card ${window.selectedBet.includes(c.uid) ? 'selected' : ''}`; 
        
        let bgUrl = c.image;
        if(bgUrl && bgUrl.startsWith('http') && !bgUrl.includes('weserv')) {
             bgUrl = `https://images.weserv.nl/?url=${encodeURIComponent(bgUrl)}&w=200&output=jpg`;
        }
        
        d.style.backgroundImage = `url('${bgUrl}')`;
        d.style.borderColor = RARITY_COLORS[c.rarity] || '#555';

        // Tag de Quantidade
        const count = myUser.collection.filter(x => x.name === c.name).length;
        if(count > 1) {
            d.innerHTML = `<span style="position:absolute; bottom:2px; right:2px; background:rgba(0,0,0,0.8); color:white; font-size:0.6rem; padding:1px 4px; border-radius:4px;">x${count}</span>`;
        }

        d.onclick = () => { 
            if(window.selectedBet.includes(c.uid)) { 
                window.selectedBet = window.selectedBet.filter(x => x !== c.uid); 
                d.classList.remove('selected');
            } else {
                if(window.selectedBet.length < 5) { 
                    window.selectedBet.push(c.uid); 
                    d.classList.add('selected');
                } else {
                    notify("Máximo de 5 cartas!");
                }
            }
            const btn = document.querySelector('#screen-bet .btn-green');
            if(btn) btn.innerText = `JOGAR RANKED (${window.selectedBet.length}/5)`;
        }; 
        g.appendChild(d); 
    });
}
    
    // Abre a tela
    document.querySelectorAll('.active').forEach(e => e.classList.remove('active')); 
    document.getElementById('screen-bet').classList.add('active');
    
    // Reseta botão
    const btn = document.querySelector('#screen-bet .btn-green');
    if(btn) { btn.innerText = "JOGAR RANKED (0/5)"; btn.disabled = false; }
window.startTitleScreen = () => { 
    if(music.intro) { music.intro.volume = musicVol; music.intro.currentTime = 0; music.intro.play().catch(e=>{}); }
    document.getElementById('intro-logo-container').classList.add('exploding-logo');
    setTimeout(() => { 
        document.getElementById('screen-title').style.display='none'; 
        showLoginScreen(true);
    }, 1500); 
};
function showLoginScreen(prefill) {
    gameState = "LOGIN";
    const loginScreen = document.getElementById('screen-login');
    loginScreen.classList.add('active');
    const inp = document.getElementById('login-user');
    if (inp && prefill) inp.value = localStorage.getItem("bafo_username") || "";
}

// --- HELPER: STATUS DA COLEÇÃO ---
function getOwnershipTag(cardName) {
    if (!myUser || !myUser.collection) return "";
    const count = myUser.collection.filter(c => c.name === cardName).length;
    
    // Se count == 0: NOVA (Verde Neon)
    if (count === 0) return `<span style="position:absolute; top:-5px; left:-5px; background:#00cec9; color:black; font-size:0.6rem; font-weight:bold; padding:2px 6px; border-radius:4px; z-index:10; box-shadow:0 2px 5px black;">NOVA</span>`;
    
    // Se count > 0: Já Tem (Cinza Discreto)
    return `<span style="position:absolute; top:-5px; right:-5px; background:rgba(0,0,0,0.6); color:#aaa; font-size:0.6rem; padding:2px 4px; border-radius:4px; border:1px solid #444;">x${count}</span>`;
}

// Trade 2.0 UI
function renderOfferGrid(elemId, cards) {
    const el = document.getElementById(elemId); el.innerHTML = '';
    cards.forEach(c => {
        const d = document.createElement('div'); d.className = 'mini-card'; 
        d.style.backgroundImage = `url('${c.image}')`; d.style.width = '60px'; d.style.height = '84px';
        el.appendChild(d);
    });
}
window.updateTradeGold = (val) => socket.emit("trade_update_offer", { tradeId: currentTradeId, gold: val });
window.toggleTradeLock = () => socket.emit("trade_lock_toggle", currentTradeId);

// --- VAULT LOGIC (SIMPLE) ---
// ==========================================================
// --- VAULT LOGIC (FÍSICA RESTAURADA) ---
// ==========================================================
class VaultCoin {
    constructor(x, y, type) {
        this.x = x; this.y = y; this.type = type;
        this.vx = (Math.random()-0.5)*8; 
        this.vy = (Math.random()-0.5)*8;
        this.radius = 12; 
        this.color = type === 'gold' ? '#f1c40f' : (type === 'mana' ? '#00cec9' : '#a29bfe');
    }
    update(w, h) {
        // Gravidade e atrito
        this.vy += 0.5; this.vx *= 0.95; this.vy *= 0.95; 
        this.x += this.vx; this.y += this.vy;
        
        // Colisão Paredes
        if (this.y + this.radius > h) { this.y = h - this.radius; this.vy *= -0.6; }
        if (this.y - this.radius < 0) { this.y = this.radius; this.vy *= -0.6; }
        
        // Paredes verticais baseadas no tipo (dividir em 3 colunas)
        let minX = 0, maxX = w;
        if (this.type === 'gold') maxX = w / 3;
        else if (this.type === 'mana') { minX = w / 3; maxX = 2 * w / 3; }
        else minX = 2 * w / 3;
        
        if (this.x - this.radius < minX) { this.x = minX + this.radius; this.vx *= -0.6; }
        if (this.x + this.radius > maxX) { this.x = maxX - this.radius; this.vx *= -0.6; }
    }
    draw(ctx) {
        ctx.beginPath(); ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
        ctx.fillStyle = this.color; ctx.fill(); 
        ctx.strokeStyle = 'white'; ctx.lineWidth = 1; ctx.stroke();
        // Brilho
        ctx.beginPath(); ctx.arc(this.x - 3, this.y - 3, 3, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.fill();
    }
}

function startVault() {
    if (vaultActive) return; vaultActive = true;
    vaultCanvas = document.getElementById('vault-canvas'); 
    vaultCtx = vaultCanvas.getContext('2d');
    const rect = vaultCanvas.parentElement.getBoundingClientRect();
    vaultCanvas.width = rect.width; vaultCanvas.height = rect.height;
    
    // Popula moedas baseado no saldo real
    vaultCoins = [];
    if(myUser) {
        const add = (amt, type, offset) => {
            const count = Math.min(50, Math.max(5, Math.floor(amt / 100))); // Limite visual
            for(let i=0; i<count; i++) 
                vaultCoins.push(new VaultCoin(offset + Math.random()*50, 50, type));
        };
        add(myUser.gold || 0, 'gold', 20);
        add(myUser.mana || 0, 'mana', vaultCanvas.width/3 + 20);
        add(myUser.essence || 0, 'essence', 2*vaultCanvas.width/3 + 20);
    }
    requestAnimationFrame(vaultLoop);
}

function vaultLoop() {
    if (!vaultActive) return;
    vaultCtx.clearRect(0, 0, vaultCanvas.width, vaultCanvas.height);
    
    // Divisórias
    vaultCtx.strokeStyle = 'rgba(255,255,255,0.1)'; vaultCtx.lineWidth = 2;
    vaultCtx.beginPath(); vaultCtx.moveTo(vaultCanvas.width/3, 0); vaultCtx.lineTo(vaultCanvas.width/3, vaultCanvas.height); vaultCtx.stroke();
    vaultCtx.beginPath(); vaultCtx.moveTo(2*vaultCanvas.width/3, 0); vaultCtx.lineTo(2*vaultCanvas.width/3, vaultCanvas.height); vaultCtx.stroke();

    // Texto Saldo
    if(myUser) {
        vaultCtx.font = "bold 16px 'Titan One'"; vaultCtx.textAlign = "center";
        vaultCtx.fillStyle = "#f1c40f"; vaultCtx.fillText(Math.floor(myUser.gold), vaultCanvas.width/6, 30);
        vaultCtx.fillStyle = "#00cec9"; vaultCtx.fillText(Math.floor(myUser.mana), vaultCanvas.width/2, 30);
        vaultCtx.fillStyle = "#a29bfe"; vaultCtx.fillText(Math.floor(myUser.essence), 5*vaultCanvas.width/6, 30);
    }

    vaultCoins.forEach(c => { c.update(vaultCanvas.width, vaultCanvas.height); c.draw(vaultCtx); });
    requestAnimationFrame(vaultLoop);
}

// --- UTILS ---
function notify(m) { const d=document.createElement('div'); d.className='toast'; d.innerText=m; document.getElementById('toast-area').appendChild(d); setTimeout(()=>d.remove(),3000); }
function screenToWorld(sx,sy){ return {x:(sx-width/2)/camera.zoom+camera.x, y:(sy-height/2)/camera.zoom+camera.y}; }
function spawnFlyingCard(c,wId){ flyingCards.push({x:c.x, y:c.y, image:c.data.image, tx:width/2, ty:wId===socket.id?height-50:50, scale:1}); }
function updateTurnBadge(){ const b=document.getElementById('turn-badge'); b.innerText=isMyTurn?"SUA VEZ!":`${opponentName}...`; b.style.color=isMyTurn?"#00cec9":"#aaa"; }
// Listener de segurança para forçar check
socket.on("force_check_turn", () => {
    isProcessingTurnEnd = false; // Destrava
    checkTurnEnd();
});

function checkTurnEnd() {
    if (!currentRoom || gameState !== 'PLAYING' || isProcessingTurnEnd) return;
    
    const isBotTurn = (currentRoom.currentTurn === BOT_ID || currentRoom.currentTurn === "BOT_ID");
    
    // Só verifica se for meu turno ou turno do bot
    if (!(isMyTurn || isBotTurn)) return;

    // Se houve ação OU se já passou muito tempo (fallback de segurança)
    if (currentRoom._turnHadAction) {
        // Verifica se todas as cartas pararam
        const allSettled = physicsCards.length === 0 || physicsCards.every(c => c.settled);
        
        if (allSettled) {
            console.log("Turno finalizado. Enviando request.");
            isProcessingTurnEnd = true; 
            socket.emit("turn_end_request", { roomId: currentRoom.roomId || currentRoom.id });
            currentRoom._turnHadAction = false; 
        } else {
            // Ainda tem carta se mexendo, checa de novo em breve
            if(turnCheckTimer) clearTimeout(turnCheckTimer);
            turnCheckTimer = setTimeout(checkTurnEnd, 500);
        }
    } 
}
socket.on('bot_should_play', (d) => {
    setTimeout(() => {
        if (!currentRoom) return;
        const target = physicsCards.find(c => !c.dead);
        currentRoom._turnHadAction = true; 
        const randomPressure = 0.65 + Math.random() * 0.35;
        const errorX = (Math.random() - 0.5) * 20; 
        const errorY = (Math.random() - 0.5) * 20;
        socket.emit("action_blow", {
            roomId: currentRoom.roomId || currentRoom.id,
            turnId: d.turnId,
            x: (target ? target.x : 0) + errorX,
            y: (target ? target.y : 0) + errorY,
            pressure: randomPressure
        });
    }, 800); 
});

// --- DECKBUILDER & TABLETOP SUPPORT ---
function renderDeckList() {
    const list = document.getElementById('deck-list-content'); list.innerHTML = '';
    const newBtn = document.createElement('div'); newBtn.className = 'deck-item new'; newBtn.innerHTML = '+ CRIAR'; newBtn.onclick = () => openDeckBuilder(null); list.appendChild(newBtn);
    if(myUser && myUser.decks) {
        myUser.decks.forEach(d => {
            const el = document.createElement('div'); el.className = 'deck-item';
            el.innerHTML = `<div>${d.name}</div><button class="btn btn-green" style="padding:2px;" onclick="event.stopPropagation();socket.emit('table_create', '${d.id}')">JOGAR</button>`;
            el.onclick = () => openDeckBuilder(d); list.appendChild(el);
        });
    }
}
// --- DECKBUILDER CORRIGIDO ---
function openDeckBuilder(d) {
    document.querySelectorAll('.active').forEach(e => e.classList.remove('active'));
    document.getElementById('screen-deckbuilder').classList.add('active');
    
    // Garante clone profundo para não editar por referência antes de salvar
    activeDeck = d ? JSON.parse(JSON.stringify(d)) : { id: null, main: [], format: 'standard', name: 'Novo Deck' };
    
    if(d) {
        document.getElementById('deck-name-input').value = d.name;
        document.getElementById('deck-format-input').value = d.format || 'standard';
    }
    
    renderBuilderUI();
}

// --- DECKBUILDER PREMIUM (COM SEPARAÇÃO DE TCG) ---
window.builderTcgFilter = 'Magic';

window.setBuilderTcg = function(tcg) { 
    window.builderTcgFilter = tcg; 
    renderBuilderUI(); 
};


// --- DECKBUILDER PREMIUM (COM SEPARAÇÃO DE TCG E CARTAS VISÍVEIS) ---
window.builderTcgFilter = 'Magic';

window.setBuilderTcg = function(tcg) { 
    window.builderTcgFilter = tcg; 
    renderBuilderUI(); 
};

function openDeckBuilder(d) {
    document.querySelectorAll('.active').forEach(e => e.classList.remove('active'));
    document.getElementById('screen-deckbuilder').classList.add('active');
    
    // Garante clone profundo
    activeDeck = d ? JSON.parse(JSON.stringify(d)) : { id: null, main: [], format: 'standard', name: 'Novo Deck' };
    
    if(d) {
        document.getElementById('deck-name-input').value = d.name;
        document.getElementById('deck-format-input').value = d.format || 'standard';
    }
    
    // Reseta os grids para garantir que o menu superior renderize
    const colGrid = document.getElementById('builder-collection');
    if (colGrid) colGrid.parentElement.innerHTML = `
        <div style="font-size:0.7rem; color:#777; padding:5px; text-align:center;">SUA COLEÇÃO</div>
        <div id="builder-tcg-tabs" style="display:flex; justify-content:space-around; margin-bottom:5px; background:rgba(0,0,0,0.5); padding:5px; border-radius:5px; font-weight:bold; font-size:0.8rem;">
            <span onclick="window.setBuilderTcg('Magic')" style="cursor:pointer; transition:0.2s;" id="tab-build-Magic">MAGIC</span>
            <span onclick="window.setBuilderTcg('Pokemon')" style="cursor:pointer; transition:0.2s;" id="tab-build-Pokemon">POKÉMON</span>
            <span onclick="window.setBuilderTcg('Lorcana')" style="cursor:pointer; transition:0.2s;" id="tab-build-Lorcana">LORCANA</span>
        </div>
        <div class="grid" id="builder-collection" style="padding:5px; display:grid; grid-template-columns:repeat(auto-fill, minmax(60px, 1fr)); gap:5px; max-height:300px; overflow-y:auto; align-content: start;"></div>
    `;

    const deckGrid = document.getElementById('builder-deck');
    if(deckGrid) {
        deckGrid.style.display = 'grid';
        deckGrid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(60px, 1fr))';
        deckGrid.style.gap = '5px';
    }

    renderBuilderUI();
}

function renderBuilderUI() {
    if (!myUser || !myUser.collection) return;
    document.getElementById('deck-count-main').innerText = activeDeck.main.length;
    
    // Atualiza a cor das abas ativas
    ['Magic', 'Pokemon', 'Lorcana'].forEach(t => {
        const el = document.getElementById('tab-build-' + t);
        if(el) el.style.color = (window.builderTcgFilter === t) ? '#00cec9' : '#888';
    });

    const newColGrid = document.getElementById('builder-collection');
    const deckGrid = document.getElementById('builder-deck');
    if (!newColGrid || !deckGrid) return;
    
    newColGrid.innerHTML = '';
    deckGrid.innerHTML = '';

    // Filtra pelo TCG
    const currentTcg = window.builderTcgFilter || 'Magic';
    const availableCards = myUser.collection.filter(c => c.source === currentTcg);
    
    // Agrupa iguais
    const uniqueMap = new Map();
    availableCards.forEach(item => { if (!uniqueMap.has(item.name)) uniqueMap.set(item.name, item); });
    
    // Renderiza a Coleção (Só exibe as que sobraram)
    Array.from(uniqueMap.values()).forEach(c => {
        const count = availableCards.filter(x => x.name === c.name).length;
        const used = activeDeck.main.filter(uid => {
            const card = myUser.collection.find(x => x.uid === uid);
            return card && card.name === c.name;
        }).length;
        
        if (count - used > 0) {
            const d = document.createElement('div'); 
            d.style.width = '100%'; d.style.aspectRatio = '2.5/3.5'; d.style.backgroundSize = 'cover'; 
            d.style.borderRadius = '4px'; d.style.cursor = 'pointer'; d.style.border = '1px solid #555'; 
            d.style.position = 'relative'; d.style.backgroundImage = `url('${c.image}')`;
            d.innerHTML = `<span style="position:absolute; bottom:0; right:0; background:#000; color:white; font-size:0.6rem; padding:2px 4px; border-radius:4px;">x${count - used}</span>`;
            
            d.onclick = () => { 
                const cardInstance = availableCards.find(x => x.name === c.name && !activeDeck.main.includes(x.uid));
                if(cardInstance) { activeDeck.main.push(cardInstance.uid); renderBuilderUI(); }
            }; 
            newColGrid.appendChild(d);
        }
    });

    // Renderiza Deck Atual
    activeDeck.main.forEach((uid, idx) => {
        const c = myUser.collection.find(x => x.uid === uid);
        if (c) { 
            const d = document.createElement('div'); 
            d.style.width = '100%'; d.style.aspectRatio = '2.5/3.5'; d.style.backgroundSize = 'cover'; 
            d.style.borderRadius = '4px'; d.style.cursor = 'pointer'; d.style.border = '2px solid #00cec9'; 
            d.style.backgroundImage = `url('${c.image}')`; 
            
            d.onclick = () => { activeDeck.main.splice(idx, 1); renderBuilderUI(); }; 
            deckGrid.appendChild(d); 
        }
    });
}
window.saveDeck = () => { activeDeck.name = document.getElementById('deck-name-input').value; activeDeck.format = document.getElementById('deck-format-input').value; socket.emit('save_deck', activeDeck); };
window.openDecks = () => { document.querySelectorAll('.active').forEach(e=>e.classList.remove('active')); document.getElementById('screen-decks').classList.add('active'); renderDeckList(); };
socket.on('deck_saved', (res) => { notify(res.msg); if(res.deck.valid) window.openDecks(); });
socket.on('table_joined', (t) => { currentTable = t; document.querySelectorAll('.active').forEach(e=>e.classList.remove('active')); document.getElementById('screen-tabletop').classList.add('active'); renderTable(); });
socket.on('table_update', (t) => { currentTable = t; renderTable(); });

// --- TABLETOP ENGINE ---

// Recebe Ping do servidor
socket.on('table_ping', (d) => {
    showPing(d.x, d.y, d.color, d.msg);
    if(window.sounds) window.sounds.click.play().catch(()=>{});
});

function renderTable() {
    if(!currentTable) return;
    const board = document.getElementById('table-board'); board.innerHTML = '';
    const handDiv = document.getElementById('table-hand'); handDiv.innerHTML = '';
    
    // Identifica Player e Oponente
    const myP = currentTable.players.find(p => p.username === myUser.username);
    const oppP = currentTable.players.find(p => p.username !== myUser.username);
    
    // --- RENDERIZAÇÃO DO JOGADOR (NÓS) ---
    if(myP) {
        document.getElementById('table-hp').innerText = myP.hp;
        document.getElementById('table-deck-count').innerText = myP.zones.deck.length;
        
        // Mão
        myP.zones.hand.forEach(c => {
            const el = document.createElement('div'); 
            el.className = 'table-card-hand'; 
            el.style.backgroundImage = `url('${c.image}')`;
            // Clicar na mão joga para a mesa numa posição aleatória segura
            el.onclick = () => {
                socket.emit('table_action', { 
                    type: 'move_card', 
                    tableId: currentTable.id, 
                    instanceId: c.instanceId, 
                    srcZone: 'hand', 
                    destZone: 'battlefield', 
                    x: 50 + Math.random()*100, 
                    y: 200 + Math.random()*50 
                });
            };
            handDiv.appendChild(el);
        });

        // Campo de Batalha (Meus Cards)
        myP.zones.battlefield.forEach(c => renderCardOnBoard(c, board, false));
    }

    // --- RENDERIZAÇÃO DO OPONENTE ---
    if(oppP) {
        document.getElementById('table-opponent').innerHTML = `
            <div style="font-weight:bold; color:#e74c3c;">❤️ ${oppP.hp}</div>
            <div style="font-size:1rem; color:white;">${oppP.username}</div>
            <div style="color:#aaa;">✋ ${oppP.zones.hand.length} | 📚 ${oppP.zones.deck.length}</div>
        `;
        // Campo de Batalha (Oponente - Invertido visualmente se quiser, mas aqui mantemos coordenadas absolutas do server)
        // Nota: Em tabletop real, geralmente giramos a visão. Aqui vamos renderizar onde o servidor diz.
        oppP.zones.battlefield.forEach(c => renderCardOnBoard(c, board, true));
    }

    // Adiciona listener de PING no tabuleiro vazio
    board.onclick = (e) => {
        if(e.target === board) {
            // Envia ping na posição clicada
            const rect = board.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            socket.emit('table_action', { type: 'ping', tableId: currentTable.id, x, y, color: '#00cec9', msg: 'Atenção aqui!' });
        }
    };
}

function renderCardOnBoard(c, container, isOpp) {
    const el = document.createElement('div'); 
    el.className = `table-card-board ${c.tapped?'tapped':''} ${c.facedown?'facedown':''}`;
    el.id = `card-${c.instanceId}`;
    
    if(!c.facedown) el.style.backgroundImage = `url('${c.image}')`;
    
    // Posicionamento
    el.style.left = c.x + 'px'; 
    el.style.top = c.y + 'px';
    
    // Marcadores (+1/+1 ou danos)
    if(c.counters && c.counters !== 0) {
        const badge = document.createElement('div');
        badge.className = 'counter-badge';
        badge.innerText = c.counters > 0 ? `+${c.counters}` : c.counters;
        el.appendChild(badge);
    }

    // Interações (Só permitimos mexer nas nossas, a menos que seja GM mode)
    if(!isOpp) {
        // Double Click / Tap Rápido para Virar (Tap)
        let lastTap = 0;
        el.addEventListener('click', (e) => {
            e.stopPropagation(); // Evita ping no board
            const now = Date.now();
            if (now - lastTap < 300) {
                // Double tap: Vira a carta
                socket.emit('table_action', { type: 'update_card', tableId: currentTable.id, instanceId: c.instanceId, update: { tapped: !c.tapped } });
            } else {
                // Single tap: Pinga na carta ("Uso esta!")
                socket.emit('table_action', { type: 'ping', tableId: currentTable.id, x: c.x + 30, y: c.y + 40, color: '#f1c40f', msg: 'Ativando!' });
            }
            lastTap = now;
        });

        // Context Menu (Botão Direito ou Long Press no mobile)
        el.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            openContextMenu(e.clientX, e.clientY, c);
        });

        enableDrag(el, c.instanceId);
    } else {
        // Se for carta do oponente, clicar apenas pinga nela
        el.onclick = (e) => {
            e.stopPropagation();
            socket.emit('table_action', { type: 'ping', tableId: currentTable.id, x: c.x + 30, y: c.y + 40, color: '#e74c3c', msg: 'Alvo!' });
        };
    }
    
    container.appendChild(el);
}

// Drag & Drop Melhorado
function enableDrag(el, instanceId) {
    let startX, startY, initLeft, initTop;
    
    const start = (clientX, clientY) => {
        startX = clientX; startY = clientY;
        initLeft = parseInt(el.style.left || 0);
        initTop = parseInt(el.style.top || 0);
        draggedItem = { el, instanceId, startX, startY, initLeft, initTop };
        el.style.zIndex = 1000; // Traz para frente
    };

    el.addEventListener('mousedown', e => { if(e.button===0) start(e.clientX, e.clientY); });
    el.addEventListener('touchstart', e => { start(e.touches[0].clientX, e.touches[0].clientY); }, {passive: false});

    const move = (clientX, clientY) => {
        if(!draggedItem || draggedItem.instanceId !== instanceId) return;
        const dx = clientX - startX;
        const dy = clientY - startY;
        el.style.left = (initLeft + dx) + 'px';
        el.style.top = (initTop + dy) + 'px';
    };

    window.addEventListener('mousemove', e => { if(draggedItem) move(e.clientX, e.clientY); });
    window.addEventListener('touchmove', e => { if(draggedItem) { e.preventDefault(); move(e.touches[0].clientX, e.touches[0].clientY); } }, {passive: false});

    const end = () => {
        if(!draggedItem || draggedItem.instanceId !== instanceId) return;
        el.style.zIndex = '';
        // Salva nova posição no servidor
        socket.emit('table_action', { 
            type: 'update_card', 
            tableId: currentTable.id, 
            instanceId, 
            update: { pos: { x: parseInt(el.style.left), y: parseInt(el.style.top) } } 
        });
        draggedItem = null;
    };

    window.addEventListener('mouseup', end);
    window.addEventListener('touchend', end);
}

// Menu de Contexto
window.currentCtxCard = null;
function openContextMenu(x, y, card) {
    window.currentCtxCard = card;
    const menu = document.getElementById('context-menu');
    menu.style.display = 'flex';
    menu.style.left = Math.min(x, window.innerWidth - 150) + 'px'; // Previne sair da tela
    menu.style.top = Math.min(y, window.innerHeight - 200) + 'px';
}



// Funções de Controle da Mesa
window.tableLife = (amt) => socket.emit('table_action', { type: 'life', tableId: currentTable.id, amount: amt });
// --- 1. Função para entrar na mesa pelo Input ---
window.joinTableInput = () => {
    const tableId = document.getElementById('join-table-id').value.trim();
    if (tableId) {
        socket.emit('table_join', tableId);
    } else {
        notify("Digite um ID de mesa válido!");
    }
};

// --- 2. Atualização do ctxAction para suportar "Devolver para a mão" ---
window.ctxAction = (action, val) => {
    if(!currentTable || !window.currentCtxCard) return;
    const cid = window.currentCtxCard.instanceId;
    
    if(action === 'tap') socket.emit('table_action', { type: 'update_card', tableId: currentTable.id, instanceId: cid, update: { tapped: !window.currentCtxCard.tapped } });
    if(action === 'counter') socket.emit('table_action', { type: 'update_card', tableId: currentTable.id, instanceId: cid, update: { counters: val } });
    if(action === 'flip') socket.emit('table_action', { type: 'update_card', tableId: currentTable.id, instanceId: cid, update: { facedown: !window.currentCtxCard.facedown } });
    
    // NOVO: Devolver para a mão
    if(action === 'hand') {
        socket.emit('table_action', { 
            type: 'move_card', 
            tableId: currentTable.id, 
            instanceId: cid, 
            srcZone: 'battlefield', 
            destZone: 'hand' 
        });
    }
    
    document.getElementById('context-menu').style.display = 'none';
};

// --- 3. Lógica do Botão de Criar Token ---
window.createToken = () => {
    if(!currentTable) return;
    socket.emit('table_action', { type: 'create_token', tableId: currentTable.id });
};
window.tableDice = () => {
    const res = Math.floor(Math.random() * 20) + 1;
    socket.emit('table_action', { type: 'ping', tableId: currentTable.id, x: 200, y: 200, color: 'white', msg: `🎲 D20: ${res}` });
};

// Efeito Visual de Ping
function showPing(x, y, color, msg) {
    const board = document.getElementById('table-board');
    if(!board) return;
    
    const el = document.createElement('div');
    el.className = 'ping-anim';
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.style.borderColor = color || '#fff';
    
    if(msg) {
        const txt = document.createElement('div');
        txt.innerText = msg;
        txt.style.position = 'absolute';
        txt.style.top = '-20px';
        txt.style.left = '50%';
        txt.style.transform = 'translateX(-50%)';
        txt.style.color = color || '#fff';
        txt.style.fontWeight = 'bold';
        txt.style.textShadow = '0 2px 2px black';
        txt.style.fontSize = '0.8rem';
        txt.style.whiteSpace = 'nowrap';
        el.appendChild(txt);
    }
    
    board.appendChild(el);
    setTimeout(() => el.remove(), 1500);
}

// Fecha context menu ao clicar fora
window.addEventListener('click', (e) => {
    const menu = document.getElementById('context-menu');
    if(menu && menu.style.display === 'flex') menu.style.display = 'none';
});
function updateScoreBoard(s1, s2) {
    const el1 = document.querySelector('#sb-p1 .score-val');
    const el2 = document.querySelector('#sb-p2 .score-val');
    
    // Animação visual se o valor mudar
    if(el1 && el1.innerText != s1) {
        el1.innerText = s1;
        el1.parentElement.classList.remove('pop');
        void el1.parentElement.offsetWidth; // Trigger reflow
        el1.parentElement.classList.add('pop');
    }
    if(el2 && el2.innerText != s2) {
        el2.innerText = s2;
        el2.parentElement.classList.remove('pop');
        void el2.parentElement.offsetWidth;
        el2.parentElement.classList.add('pop');
    }
}

// 2. CORREÇÃO DO RANKING (Renderização da Lista)
socket.on('ranking_data', (data) => {
    // Salva em cache global se precisar trocar abas
    window.currentRankData = data; 
    renderRankingList(data.elo || []);
});

window.switchRank = function(type, btn) {
    document.querySelectorAll('.rank-switch').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    
    const data = window.currentRankData || { elo:[], market:[], power:[] };
    const list = data[type] || [];
    renderRankingList(list, type);
};

function renderRankingList(list, type = 'elo') {
    const el = document.getElementById('ranking-list');
    if(!el) return;
    el.innerHTML = '';
    
    if(!list || list.length === 0) {
        el.innerHTML = '<div style="padding:20px; color:#777;">Carregando...</div>';
        return;
    }

    list.forEach((u, i) => {
        let valDisplay = type === 'elo' ? `${u.val} ELO` : (type === 'market' ? `💰 ${u.val}` : `⚡ ${u.val}`);
        let color = i === 0 ? '#f1c40f' : (i === 1 ? '#bdc3c7' : (i === 2 ? '#e67e22' : 'white'));
        
        el.innerHTML += `
            <div class="ranking-row" style="display:flex; justify-content:space-between; padding:10px; border-bottom:1px solid rgba(255,255,255,0.1);">
                <div>
                    <span style="color:${color}; font-weight:bold; width:25px; display:inline-block;">#${i+1}</span>
                    <span style="color:white;">${u.username}</span>
                    <span style="font-size:0.7rem; color:#aaa; margin-left:5px;">(Lvl ${u.level||1})</span>
                </div>
                <div style="font-weight:bold; color:${type==='market'?'#2ecc71':(type==='power'?'#9b59b6':'orange')}">${valDisplay}</div>
            </div>`;
    });
}

// 3. CORREÇÃO DO MERCADO (Grid Visual)
window.renderMarket = function() {
    const g = document.getElementById('market-grid'); 
    if(!g) return; 
    g.innerHTML = '';
    
    (window.marketData || []).forEach(m => {
        const d = document.createElement('div'); 
        d.className = 'market-card';
        
        const tagHtml = getOwnershipTag(m.card.name); // <--- AQUI

        d.innerHTML = `
            <div class="grid-card" style="
                background-image:url('${m.card.image}'); 
                width:100%; 
                aspect-ratio:2.5/3.5; 
                background-size:cover; 
                background-position:center;
                border-radius:6px;
                border: 2px solid ${RARITY_COLORS[m.card.rarity] || '#555'};
                position: relative;
            ">
                ${tagHtml}
            </div>
            <div class="m-info" style="margin-top:5px; text-align:center;">
                <div style="font-size:0.7rem; color:#ccc; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${m.card.name}</div>
                <div style="font-size:0.65rem; color:#888;">${m.card.set_name || 'Base'}</div>
                <button class="btn btn-green" style="padding:2px 10px; font-size:0.8rem; margin-top:3px;" onclick="socket.emit('market_buy','${m.listingId}')">💰${m.price}</button>
            </div>`;
        g.appendChild(d);
    });
};

function renderCardOnBoard(c, container, isOpp) {
    const el = document.createElement('div'); el.className = `table-card-board ${c.tapped?'tapped':''} ${c.facedown?'facedown':''}`;
    if(!c.facedown) el.style.backgroundImage = `url('${c.image}')`;
    el.style.left = c.x + 'px'; el.style.top = (isOpp ? 50 : 250) + c.y + 'px';
    if(!isOpp) {
        el.onclick = () => socket.emit('table_action', { type: 'update_card', tableId: currentTable.id, instanceId: c.instanceId, update: { tapped: !c.tapped } });
        enableDrag(el, c.instanceId);
    }
    container.appendChild(el);
}
let draggedItem = null;
function enableDrag(el, instanceId) {
    let startX, startY;
    el.addEventListener('touchstart', (e) => { const touch = e.touches[0]; startX = touch.clientX - el.offsetLeft; startY = touch.clientY - el.offsetTop; draggedItem = { el, instanceId, startX, startY }; });
    el.addEventListener('touchmove', (e) => { if(!draggedItem) return; e.preventDefault(); const touch = e.touches[0]; el.style.left = (touch.clientX - startX) + 'px'; el.style.top = (touch.clientY - startY) + 'px'; });
    el.addEventListener('touchend', (e) => { if(!draggedItem) return; socket.emit('table_action', { type: 'update_card', tableId: currentTable.id, instanceId, update: { pos: { x: parseInt(el.style.left), y: parseInt(el.style.top) } } }); draggedItem = null; });
}
window.tableDraw = () => socket.emit('table_action', { type: 'draw', tableId: currentTable.id });
window.tableUntapAll = () => socket.emit('table_action', { type: 'untap_all', tableId: currentTable.id });
// Adicione este som na lista existente no final do arquivo
window.sounds = { 
    openPack: new Audio('https://assets.mixkit.co/active_storage/sfx/2019/2019-preview.mp3'), 
    swap: new Audio('https://assets.mixkit.co/active_storage/sfx/2014/2014-preview.mp3'), 
    click: new Audio('https://assets.mixkit.co/active_storage/sfx/2568/2568-preview.mp3'), 
    win: new Audio('https://assets.mixkit.co/active_storage/sfx/2018/2018-preview.mp3'),
    // NOVO SOM DE XP (Um som de "Level Up" ou "Chime" agradável)
    xp: new Audio('https://assets.mixkit.co/active_storage/sfx/1435/1435-preview.mp3') 
};

// --- LISTENER DE GANHO DE XP ---
socket.on('xp_gain', (d) => {
    // d = { amount, source, current, max, level }
    
    // 1. Toca o som
    if(window.sounds && window.sounds.xp) {
        window.sounds.xp.volume = 0.6;
        window.sounds.xp.play().catch(()=>{}); 
    }

    // 2. Cria elemento visual flutuante (Animation)
    const hud = document.getElementById('game-hud'); // Referência para posição ou centro da tela
    const floatEl = document.createElement('div');
    
    floatEl.innerHTML = `+${d.amount} XP`;
    floatEl.style.position = 'fixed';
    floatEl.style.top = '50%';
    floatEl.style.left = '50%';
    floatEl.style.transform = 'translate(-50%, -50%)';
    floatEl.style.color = '#00cec9'; // Cor Cyan Neon
    floatEl.style.fontFamily = "'Titan One', cursive";
    floatEl.style.fontSize = '3rem';
    floatEl.style.textShadow = '0 0 20px #00cec9, 0 4px 0 black';
    floatEl.style.pointerEvents = 'none';
    floatEl.style.zIndex = '9999';
    floatEl.style.opacity = '1';
    floatEl.style.transition = 'all 1.5s cubic-bezier(0.19, 1, 0.22, 1)';
    
    document.body.appendChild(floatEl);

    // Animação CSS via JS
    requestAnimationFrame(() => {
        floatEl.style.top = '40%'; // Sobe um pouco
        floatEl.style.opacity = '0';
        floatEl.style.transform = 'translate(-50%, -50%) scale(1.5)'; // Aumenta
    });

    // Remove do DOM após animação
    setTimeout(() => {
        floatEl.remove();
    }, 1500);

    // 3. Atualiza HUD se o usuário já subiu de nível na mesma ação
    if(myUser) {
        myUser.xp = d.current;
        myUser.level = d.level;
        updateHUD();
    }
});

window.checkBotMove = function() {
    // Validações de segurança
    if (!currentRoom || gameState !== 'PLAYING') return;

    // Verifica se é a vez do Bot (ID fixo ou string "BOT_ID")
    if (currentRoom.currentTurn === BOT_ID || currentRoom.currentTurn === "BOT_ID") {
        console.log("🤖 É a vez do Bot. Solicitando jogada...");
        
        // Envia o gatilho para o servidor processar a IA
        // O servidor responderá com 'bot_should_play'
        socket.emit("bot_play_trigger", currentRoom.roomId || currentRoom.id);
    }
};