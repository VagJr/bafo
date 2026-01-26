const socket = io();
const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");

let width = window.innerWidth, height = window.innerHeight;
canvas.width = width; canvas.height = height;

let gameState = "LOGIN";
let myUser = null;
let currentRoom = null;
let isMyTurn = false;
let currentTurnId = null;
let opponentName = "Oponente";

let physicsCards = [];
let particles = [];
let flyingCards = [];

const camera = { x: 0, y: 0, zoom: 1 };
const imgCache = {};
const BOT_ID = "BOT_ID";

// HELPER: Rarity Diamonds
const RARITY_HTML = {
    common: '<span style="color:#bdc3c7">♦</span>',
    rare: '<span style="color:#0984e3">♦♦</span>',
    epic: '<span style="color:#6c5ce7">♦♦♦</span>',
    legend: '<span style="color:#f1c40f; text-shadow:0 0 5px gold;">♦♦♦♦</span>'
};
const RARITY_COLORS = { common: '#bdc3c7', rare: '#0984e3', epic: '#6c5ce7', legend: '#f1c40f' };

function getCardImage(url) {
    if (!url) return null;
    if (!imgCache[url]) { const i = new Image(); i.src = url; imgCache[url] = i; }
    return imgCache[url];
}

const PHYSICS = { GRAVITY: 0.5, BOUNCE: 0.4, FRICTION: 0.95, TIPPING_FORCE: 3.5 };

class PhysCard {
    constructor(data, x, y) {
        this.data = data; this.uid = data.uid;
        this.x = x; this.y = y; this.z = 0;
        this.vx=0; this.vy=0; this.vz=0;
        this.angleX = 0; this.velAngleX = 0; this.angleZ = (Math.random()-0.5)*360; this.velAngleZ = 0;
        this.w = 140; this.h = 200; this.settled = true; this.dead = false;
    }
    update() {
        if(this.dead) return;
        const isMoving = Math.abs(this.vx)>0.05 || Math.abs(this.vy)>0.05 || Math.abs(this.vz)>0.05;
        if (this.settled && !isMoving && this.z === 0) return;
        
        this.x += this.vx; this.y += this.vy; this.z += this.vz;
        this.angleX += this.velAngleX; this.angleZ += this.velAngleZ;
        if(this.z > 0) this.vz -= PHYSICS.GRAVITY;
        if(this.z <= 0) {
            this.z = 0;
            if(Math.abs(this.vz) > 1.5) { this.vz *= -PHYSICS.BOUNCE; this.velAngleX *= 0.6; } 
            else { this.vz = 0; this.vx *= 0.85; this.vy *= 0.85; this.velAngleX *= 0.85; this.velAngleZ *= 0.85; }
            let norm = this.angleX % 360; if (norm < 0) norm += 360;
            const distTo0 = norm; const distTo180 = Math.abs(norm - 180); const distTo360 = Math.abs(norm - 360);
            const minDist = Math.min(distTo0, distTo180, distTo360);
            if (minDist > 10) {
                this.settled = false;
                if (norm > 90 && norm < 270) { if (norm < 180) this.velAngleX += PHYSICS.TIPPING_FORCE; else this.velAngleX -= PHYSICS.TIPPING_FORCE; } 
                else { if (norm <= 90) this.velAngleX -= PHYSICS.TIPPING_FORCE; else this.velAngleX += PHYSICS.TIPPING_FORCE; }
            } else {
                if (!isMoving && Math.abs(this.velAngleX) < 1) {
                    if (distTo180 < distTo0 && distTo180 < distTo360) this.angleX = 180; else this.angleX = 0;
                    this.velAngleX = 0; this.settled = true; this.checkWinCondition();
                }
            }
        } else { this.vx *= 0.99; this.vy *= 0.99; }
    }
    checkWinCondition() {
        if(this.dead) return;
        const norm = Math.abs(this.angleX % 360);
        const isFaceUp = (Math.abs(norm - 180) < 5);
        this.data.flipped = isFaceUp;
        if(isFaceUp) {
            const currentTurnIsBot = (currentRoom.currentTurn === BOT_ID);
            if(isMyTurn || currentTurnIsBot) {
                this.dead = true;
                const winnerId = isMyTurn ? socket.id : BOT_ID;
                spawnFlyingCard(this, winnerId);
                socket.emit('card_flip_claim', { roomId: currentRoom.roomId, cardUID: this.uid, winnerIsBot: currentTurnIsBot });
            }
        }
    }
    draw(ctx) {
        if(this.dead) return;
        const depth = 1 + (this.z / 600); const rad = this.angleX * (Math.PI/180); const flip = Math.cos(rad);
        ctx.save();
        ctx.translate(this.x, this.y - this.z); ctx.scale(depth, Math.abs(flip) * depth); ctx.rotate(this.angleZ * Math.PI/180);
        if(flip < 0) { // FRENTE
            ctx.scale(-1, 1);
            const img = getCardImage(this.data.image);
            if(img) ctx.drawImage(img, -this.w/2, -this.h/2, this.w, this.h);
            else { ctx.fillStyle = "white"; ctx.fillRect(-this.w/2, -this.h/2, this.w, this.h); }
            ctx.strokeStyle = RARITY_COLORS[this.data.rarity] || 'gold';
            ctx.lineWidth=5; ctx.strokeRect(-this.w/2, -this.h/2, this.w, this.h);
        } else { // COSTAS
            ctx.fillStyle = "#2d3436"; ctx.fillRect(-this.w/2, -this.h/2, this.w, this.h);
            ctx.strokeStyle = "#636e72"; ctx.lineWidth=4; ctx.strokeRect(-this.w/2+5, -this.h/2+5, this.w-10, this.h-10);
        }
        ctx.restore();
    }
}

class Particle {
    constructor(x, y) { this.x=x; this.y=y; this.life=1.0; this.vx=(Math.random()-0.5)*10; this.vy=(Math.random()-0.5)*10; }
    update() { this.x+=this.vx; this.y+=this.vy; this.life-=0.05; }
    draw(ctx) { ctx.globalAlpha=this.life; ctx.fillStyle='gold'; ctx.beginPath(); ctx.arc(this.x,this.y,3,0,Math.PI*2); ctx.fill(); ctx.globalAlpha=1; }
}

const input = { active: false, startT: 0, x: 0, y: 0 };
let hasPlayed = false;

function startIn(x,y) { if(gameState!=='PLAYING' || !isMyTurn || hasPlayed) return; input.active=true; input.startT=Date.now(); input.x=x; input.y=y; }
function moveIn(x,y) { if(input.active){input.x=x; input.y=y;} }
function endIn() {
    if(!input.active) return;
    input.active=false; hasPlayed=true;
    const dt = Math.min(Date.now()-input.startT, 800); const pressure = dt/800;
    const world = screenToWorld(input.x, input.y);
    socket.emit('action_blow', { roomId: currentRoom.roomId, turnId: currentTurnId, x: world.x, y: world.y, pressure });
}

function createExplosion(x, y, pressure) {
    const chaos = (Math.random() * 0.3) + 0.8; 
    const radius = 250 * (0.8 + pressure * 0.5) * chaos; 
    const force = 30 * pressure * chaos; 
    let hitAny = false;
    physicsCards.forEach(c => {
        if(c.dead) return;
        const dist = Math.hypot(c.x-x, c.y-y);
        if(dist < radius) {
            hitAny = true;
            const impact = (1 - dist/radius);
            const dx = (c.x - x)/dist; const dy = (c.y - y)/dist;
            const randSpin = (Math.random() - 0.5) * 50;
            c.vx += dx * impact * 15; c.vy += dy * impact * 15; c.vz += force * impact * 1.2;
            c.velAngleX += (force + Math.abs(randSpin)) * impact; c.velAngleZ += randSpin;
            c.settled = false;
        }
    });
    if(hitAny) for(let i=0;i<25;i++) particles.push(new Particle(x,y));
    setTimeout(checkTurnEnd, 2000);
}

function checkTurnEnd() {
    const allStopped = physicsCards.every(c => c.settled);
    if(allStopped) {
        if (isMyTurn || currentRoom.currentTurn === BOT_ID) {
            socket.emit('turn_end_request', { roomId: currentRoom.roomId });
        }
    } else { setTimeout(checkTurnEnd, 500); }
}

function updateCamera() {
    if(physicsCards.length===0 && flyingCards.length===0) return;
    let minX=Infinity, maxX=-Infinity, minY=Infinity, maxY=-Infinity;
    let targets = physicsCards.filter(c => !c.dead); if(targets.length === 0) targets = flyingCards;
    targets.forEach(c => { minX=Math.min(minX,c.x); maxX=Math.max(maxX,c.x); minY=Math.min(minY,c.y); maxY=Math.max(maxY,c.y); });
    if(minX === Infinity) return;
    minX-=300; maxX+=300; minY-=300; maxY+=300;
    const tx = (minX+maxX)/2; const ty = (minY+maxY)/2;
    camera.x += (tx-camera.x)*0.1; camera.y += (ty-camera.y)*0.1;
}
function screenToWorld(sx, sy) { return { x: (sx-width/2)/camera.zoom + camera.x, y: (sy-height/2)/camera.zoom + camera.y }; }

function loop() {
    ctx.clearRect(0,0,width,height);
    if(gameState==='PLAYING') {
        updateCamera();
        ctx.save(); ctx.translate(width/2, height/2); ctx.scale(camera.zoom, camera.zoom); ctx.translate(-camera.x, -camera.y);
        ctx.beginPath(); ctx.arc(0,0,900,0,Math.PI*2); ctx.strokeStyle='rgba(255,255,255,0.2)'; ctx.lineWidth=10; ctx.stroke();
        particles.forEach((p,i)=>{p.update(); p.draw(ctx); if(p.life<=0)particles.splice(i,1)});
        physicsCards.forEach(c=>{ c.update(); c.draw(ctx); });
        
        if(input.active && isMyTurn) {
            const dt = Math.min(Date.now()-input.startT, 800); const w = screenToWorld(input.x, input.y);
            ctx.beginPath(); ctx.arc(w.x, w.y, 50+(dt/10), 0, Math.PI*2); ctx.strokeStyle=`rgba(255,200,0,${dt/800})`; ctx.lineWidth=5; ctx.stroke();
        }
        ctx.restore();
        
        flyingCards.forEach((fc,i)=>{
            fc.x += (fc.tx - fc.x)*0.1; fc.y += (fc.ty - fc.y)*0.1; fc.scale -= 0.02;
            ctx.save(); ctx.translate(fc.x, fc.y); ctx.scale(fc.scale, fc.scale);
            const img = getCardImage(fc.image);
            if(img) ctx.drawImage(img,-40,-60,80,120); else ctx.fillRect(-40,-60,80,120);
            ctx.strokeStyle='gold'; ctx.strokeRect(-40,-60,80,120); ctx.restore();
            if(fc.scale<=0) flyingCards.splice(i,1);
        });
    }
    requestAnimationFrame(loop);
}

// EVENTS
canvas.addEventListener('mousedown',e=>startIn(e.clientX,e.clientY)); canvas.addEventListener('mousemove',e=>moveIn(e.clientX,e.clientY)); canvas.addEventListener('mouseup',endIn);
canvas.addEventListener('touchstart',e=>{e.preventDefault();startIn(e.touches[0].clientX,e.touches[0].clientY)},{passive:false}); canvas.addEventListener('touchmove',e=>{e.preventDefault();moveIn(e.touches[0].clientX,e.touches[0].clientY)},{passive:false}); canvas.addEventListener('touchend',endIn);

function notify(m) { const d=document.createElement('div'); d.className='toast'; d.innerText=m; document.getElementById('toast-area').appendChild(d); setTimeout(()=>d.remove(),3000); }
function updateHUD() { document.getElementById('coins-display').innerText = myUser.coins; document.getElementById('cards-display').innerText = myUser.collection.length; }
function spawnFlyingCard(cardObj, winnerId) { 
    let targetY = (winnerId === socket.id) ? height - 50 : 50;
    flyingCards.push({ x: cardObj.x, y: cardObj.y, image: cardObj.data.image, tx: width/2, ty: targetY, scale: 1 }); 
}

socket.on('login_success', u=>{ myUser=u; document.querySelectorAll('.active').forEach(e=>e.classList.remove('active')); document.getElementById('screen-menu').classList.add('active'); updateHUD(); });
socket.on('update_profile', u=>{ myUser=u; updateHUD(); if(document.getElementById('screen-collection').classList.contains('active')) window.renderCollection(); }); 
socket.on('notification', m => notify(m));
socket.on('booster_opened', newCards => {
    document.querySelectorAll('.active').forEach(e=>e.classList.remove('active'));
    const display = document.getElementById('booster-display'); display.innerHTML = '';
    newCards.forEach((c, i) => {
        const el = document.createElement('div'); el.className = 'booster-card'; 
        el.innerHTML = `<div class="front" style="background-image:url(${c.image})"></div><div class="back"></div>`;
        el.style.animationDelay = (i * 0.2) + 's'; el.classList.add('reveal'); display.appendChild(el);
    });
    document.getElementById('screen-booster').classList.add('active');
});

socket.on('game_start', r=>{
    currentRoom=r; gameState='PLAYING'; currentTurnId=r.turnId; isMyTurn=r.currentTurn===socket.id;
    opponentName = r.usernames.find(u => u !== myUser.username) || "LumiaBot";
    document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active')); document.getElementById('game-hud').style.display='flex';
    hasPlayed=false;
    physicsCards = r.pot.map((c,i)=>{ const a=Math.random()*Math.PI*2; const d=Math.random()*40; return new PhysCard(c, Math.cos(a)*d, Math.sin(a)*d); });
    updateTurnBadge();
    checkBotMove();
});
socket.on('action_blow', d => createExplosion(d.x, d.y, d.pressure));
socket.on('card_won', d => { const idx = physicsCards.findIndex(c => c.uid === d.cardUID); if(idx > -1) { physicsCards[idx].dead = true; spawnFlyingCard(physicsCards[idx], d.winnerId); } });
socket.on('new_turn', d => { 
    currentRoom.currentTurn = d.nextTurn; isMyTurn = d.nextTurn === socket.id; currentTurnId = d.turnId; hasPlayed = false; updateTurnBadge(); checkBotMove();
});
socket.on('game_over', d => {
    notify(d.message);

    // Fecha estado da partida sem deslogar
    gameState = "MENU";
    currentRoom = null;
    currentTurnId = null;
    isMyTurn = false;
    hasPlayed = false;

    // Limpa elementos da partida
    physicsCards = [];
    particles = [];
    flyingCards = [];

    // Esconde HUD do game e volta pro menu
    document.getElementById('game-hud').style.display = 'none';
    window.openMenu();
});


function checkBotMove() {
    if (currentRoom.currentTurn === BOT_ID) { socket.emit("bot_play_trigger", currentRoom.roomId); }
}
socket.on('bot_should_play', (d) => {
    setTimeout(() => {
        const targets = physicsCards.filter(c => !c.dead);
        if(targets.length > 0) {
            const target = targets[Math.floor(Math.random()*targets.length)];
            socket.emit("action_blow", {
                roomId: currentRoom.roomId, turnId: d.turnId,
                x: target.x + (Math.random()-0.5)*20,
                y: target.y + (Math.random()-0.5)*20,
                pressure: 0.8 + Math.random()*0.2
            });
        }
    }, 1000);
});

function updateTurnBadge() {
    const badge = document.getElementById('turn-badge');
    if(isMyTurn) { badge.innerText = "SUA VEZ!"; badge.style.color = "#00cec9"; }
    else { badge.innerText = `${opponentName}...`; badge.style.color = "#aaa"; }
}

// --- NOVOS RENDERIZADORES DE GRID (VISUAL ATUALIZADO) ---
let marketData = [];
socket.on('market_update', d => { marketData = d; if(document.getElementById('screen-market').classList.contains('active')) window.renderMarket(); });

function createCardElement(c, onClickStr, price) {
    const rarityIcon = RARITY_HTML[c.rarity] || RARITY_HTML['common'];
    const borderCol = RARITY_COLORS[c.rarity] || '#888';
    
    // Grid Item
    const div = document.createElement('div');
    div.className = 'grid-card';
    div.style.backgroundImage = `url('${c.image}')`;
    div.style.borderColor = borderCol;
    div.onclick = () => eval(onClickStr); // Simplificação pro exemplo

    // Overlay info
    div.innerHTML = `
        <div class="card-overlay">
            <div style="font-size:0.8rem; font-weight:bold; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${c.name}</div>
            <div style="display:flex; justify-content:space-between; margin-top:2px;">
                <span>${rarityIcon}</span>
                ${price ? `<span style="color:gold; font-weight:bold;">💰${price}</span>` : ''}
            </div>
        </div>
    `;
    return div;
}

window.renderMarket = () => {
    const g = document.getElementById('market-grid'); g.innerHTML = '';
    marketData.forEach(m => {
        if(m.seller === myUser.username) return;
        // Passa o listingId no onclick
        const el = createCardElement(m.card, `if(confirm('Comprar?')) socket.emit('market_buy', '${m.listingId}')`, m.price);
        g.appendChild(el);
    });
};

window.renderCollection = () => {
    const g = document.getElementById('collection-grid'); g.innerHTML = '';
    myUser.collection.forEach(c => {
        const el = createCardElement(c, `window.sellCard('${c.uid}')`);
        g.appendChild(el);
    });
};

// TRADE UI
let currentTradeId = null;
window.openTrading = () => { document.querySelectorAll('.active').forEach(e=>e.classList.remove('active')); document.getElementById('screen-trade-lobby').classList.add('active'); };
window.createTrade = () => { socket.emit('trade_create'); };
window.joinTrade = () => { const tid = prompt("ID da Sala:"); if(tid) socket.emit('trade_join', tid); };
socket.on('trade_created', tid => enterTradeRoom(tid));
socket.on('trade_joined', data => { enterTradeRoom(currentTradeId); document.getElementById('trade-status').innerText = `Negociando: ${data.p1} vs ${data.p2}`; });

function enterTradeRoom(tid) {
    currentTradeId = tid;
    document.querySelectorAll('.active').forEach(e=>e.classList.remove('active')); document.getElementById('screen-trade-room').classList.add('active');
    document.getElementById('trade-id-display').innerText = tid;
    renderMyTradeCollection();
}

function renderMyTradeCollection() {
    const g = document.getElementById('trade-collection'); g.innerHTML = '';
    myUser.collection.forEach(c => {
        const el = createCardElement(c, `socket.emit('trade_offer', { tradeId: '${currentTradeId}', cardUID: '${c.uid}' })`);
        g.appendChild(el);
    });
}

socket.on('trade_updated', data => {
    const mySlot = document.getElementById('my-offer-slot');
    const theirSlot = document.getElementById('their-offer-slot');
    
    // Lógica simplificada de visualização: se eu sou dono da offer1, offer1 é minha.
    let myOffer = null, theirOffer = null;
    if(data.offer1 && data.offer1.originalOwner === myUser.username) { myOffer = data.offer1; theirOffer = data.offer2; }
    else if (data.offer2 && data.offer2.originalOwner === myUser.username) { myOffer = data.offer2; theirOffer = data.offer1; }
    else if (data.offer1) theirOffer = data.offer1; // Entrando agora

    updateTradeSlot(mySlot, myOffer);
    updateTradeSlot(theirSlot, theirOffer);
});

function updateTradeSlot(div, card) {
    if(card) {
        div.style.backgroundImage = `url('${card.image}')`;
        div.innerHTML = `<div style="margin-top:auto; background:rgba(0,0,0,0.7); width:100%; font-size:10px;">${card.name}</div>`;
        div.style.border = `2px solid ${RARITY_COLORS[card.rarity]}`;
    } else {
        div.style.backgroundImage = ''; div.innerHTML = 'Vazio'; div.style.border = '2px dashed #666';
    }
}
socket.on('trade_completed', () => { notify("Troca realizada!"); setTimeout(window.openMenu, 2000); });
window.confirmTrade = () => socket.emit('trade_confirm', currentTradeId);

window.doLogin = () => { const u=document.getElementById('login-user').value; if(u) socket.emit('login',{username:u}); };
window.buyBooster = () => socket.emit('buy_booster');
// Aposta usa o mesmo visual grid agora
window.openBetting = () => { 
    const g=document.getElementById('bet-grid'); g.innerHTML=''; window.selectedBet=[];
    myUser.collection.forEach(c => {
        const el = createCardElement(c, `toggleBet('${c.uid}', this)`);
        g.appendChild(el);
    });
    document.querySelectorAll('.active').forEach(e=>e.classList.remove('active')); document.getElementById('screen-bet').classList.add('active');
};
window.toggleBet = (uid, el) => {
    if(window.selectedBet.includes(uid)) { 
        window.selectedBet = window.selectedBet.filter(i=>i!==uid); 
        el.style.transform = 'scale(1)'; el.style.boxShadow = 'none';
    } else { 
        if(window.selectedBet.length<5) { 
            window.selectedBet.push(uid); 
            el.style.transform = 'scale(0.9)'; el.style.boxShadow = '0 0 15px #00cec9'; 
        } 
    }
};
window.createMatch = () => { if(![1,3,5].includes(window.selectedBet.length)) return notify("Escolha 1, 3 ou 5!"); socket.emit('create_match', window.selectedBet); };
window.openMarket = () => { document.querySelectorAll('.active').forEach(e=>e.classList.remove('active')); document.getElementById('screen-market').classList.add('active'); window.renderMarket(); };
window.openCollection = () => { document.querySelectorAll('.active').forEach(e=>e.classList.remove('active')); document.getElementById('screen-collection').classList.add('active'); window.renderCollection(); };
window.sellCard = (uid) => { const p = prompt("Valor:"); if(p) socket.emit('market_sell', { cardUID: uid, price: parseInt(p) }); window.openMenu(); };
window.openMenu = () => { document.querySelectorAll('.active').forEach(e=>e.classList.remove('active')); document.getElementById('screen-menu').classList.add('active'); };
window.closeAll = () => window.location.reload();
window.addEventListener('resize', () => { width=window.innerWidth; height=window.innerHeight; canvas.width=width; canvas.height=height; });
loop();