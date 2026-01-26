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
let searchTimerInterval = null;

let physicsCards = [];
let particles = [];
let flyingCards = [];
// --- INPUT STATE (FIX click/touch) ---
const input = {
    active: false,
    startT: 0,
    x: 0,
    y: 0
};

const camera = { x: 0, y: 0, zoom: 1 };
const imgCache = {};
const BOT_ID = "BOT_ID";
const RARITY_COLORS = { common: '#bdc3c7', rare: '#0984e3', epic: '#6c5ce7', legend: '#f1c40f' };

function getCardImage(url) {
    if (!url) return null;
    if (!imgCache[url]) { const i = new Image(); i.src = url; imgCache[url] = i; }
    return imgCache[url];
}

function updateHUD() {
    if(!myUser) return;
    document.getElementById('gold-display').innerText = myUser.gold || 0;
    document.getElementById('mana-display').innerText = myUser.mana || 0;
    document.getElementById('essence-display').innerText = myUser.essence || 0;
    document.getElementById('cards-display').innerText = myUser.collection.length;
}

// --- INSPECTOR 3D LOGIC ---
window.inspectCard = (url) => {
    const inspector = document.getElementById('card-inspector');
    const inspectImg = document.getElementById('inspector-img');
    inspectImg.style.backgroundImage = `url('${url}')`;
    inspectImg.style.transform = `rotateY(0deg) rotateX(0deg)`;
    inspector.classList.add('active');
};
window.closeInspector = () => document.getElementById('card-inspector').classList.remove('active');

document.getElementById('card-inspector').addEventListener('mousemove', (e) => {
    const el = document.getElementById('inspector-img');
    const xAxis = (window.innerWidth / 2 - e.clientX) / 25; 
    const yAxis = (window.innerHeight / 2 - e.clientY) / 25;
    el.style.transform = `rotateY(${xAxis}deg) rotateX(${yAxis}deg) scale(1.1)`;
});
document.getElementById('card-inspector').addEventListener('touchmove', (e) => {
    e.preventDefault();
    const el = document.getElementById('inspector-img');
    const touch = e.touches[0];
    const xAxis = (window.innerWidth / 2 - touch.clientX) / 25;
    const yAxis = (window.innerHeight / 2 - touch.clientY) / 25;
    el.style.transform = `rotateY(${xAxis}deg) rotateX(${yAxis}deg) scale(1.1)`;
}, { passive: false });

// --- BOOSTER LOGIC ---
let mixer = { gold: 166, mana: 167, essence: 167 }; 
window.openBoosterMixer = () => {
    document.querySelectorAll('.active').forEach(e=>e.classList.remove('active'));
    document.getElementById('screen-booster-mix').classList.add('active');
    updateMixerUI();
};
window.adjustMixer = (type, val) => {
    const total = 500;
    let v = parseInt(val); if(v<0)v=0; if(v>total)v=total;
    mixer[type] = v;
    const rem = total - v;
    const keys = Object.keys(mixer).filter(k=>k!==type);
    mixer[keys[0]] = Math.floor(rem/2);
    mixer[keys[1]] = rem - mixer[keys[0]];
    updateMixerUI();
};
function updateMixerUI() {
    ['gold','mana','essence'].forEach(k => {
        document.getElementById('mix-'+k).value = mixer[k];
        document.getElementById('val-'+k).innerText = mixer[k];
    });
}
window.confirmBoosterBuy = () => {
    socket.emit("buy_booster_multiverse", mixer);
    document.getElementById('screen-booster-mix').classList.remove('active');
    // DISPARA ANIMAÇÃO DE LOADING NOS ESPOROS
    if(window.sporeGather) window.sporeGather();
};

socket.on('booster_opened', newCards => {
    // DISPARA EXPLOSÃO
    if(window.sporeExplode) window.sporeExplode();

    document.querySelectorAll('.active').forEach(e=>e.classList.remove('active'));
    const display = document.getElementById('booster-display'); display.innerHTML = '';
    
    newCards.forEach((c, i) => {
        const el = document.createElement('div'); el.className = 'booster-card'; 
        el.innerHTML = `<div class="front" style="background-image:url(${c.image})"></div><div class="back"></div>`;
        el.style.opacity = '0';
        el.style.transform = `translateY(200px) rotateY(180deg)`;
        el.onclick = () => window.inspectCard(c.image);
        display.appendChild(el);

        setTimeout(() => {
            el.style.transition = 'all 0.8s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
            el.style.opacity = '1';
            el.style.transform = `translateY(0) rotateY(0deg)`;
        }, i * 300);
    });
    
    document.getElementById('screen-booster').classList.add('active');
});

// --- BANK / SWAP LOGIC ---
window.openBank = () => {
    document.querySelectorAll('.active').forEach(e=>e.classList.remove('active'));
    document.getElementById('screen-bank').classList.add('active');
};
window.performSwap = () => {
    const from = document.getElementById('swap-from').value;
    const to = document.getElementById('swap-to').value;
    const amount = document.getElementById('swap-amount').value;
    if(from === to) return notify("Troque moedas diferentes!");
    socket.emit("currency_swap", { from, to, amount });
};

// --- SEARCH TIMER ---
function startTimer() {
    const el = document.getElementById('search-timer');
    el.style.display = 'block';
    let s = 0; el.innerText = "Buscando: 0s";
    if(searchTimerInterval) clearInterval(searchTimerInterval);
    searchTimerInterval = setInterval(() => { s++; el.innerText = `Buscando: ${s}s`; }, 1000);
}
function stopTimer() { clearInterval(searchTimerInterval); document.getElementById('search-timer').style.display = 'none'; }

// --- SOCKETS MAIN ---
socket.on('login_success', u => { myUser=u; document.querySelectorAll('.active').forEach(e=>e.classList.remove('active')); document.getElementById('screen-menu').classList.add('active'); updateHUD(); });
socket.on('update_profile', u => { myUser=u; updateHUD(); if(document.getElementById('screen-collection').classList.contains('active')) window.renderCollection(); });
socket.on('notification', m => notify(m));
socket.on('waiting_opponent', () => { startTimer(); notify("Na fila..."); });
socket.on('game_start', r => { 
    stopTimer();
    currentRoom=r; gameState='PLAYING'; currentTurnId=r.turnId; isMyTurn=r.currentTurn===socket.id;
    opponentName = r.usernames.find(u => u !== myUser.username) || "Bot";
    document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active')); 
    document.getElementById('game-hud').style.display='flex';
    physicsCards = r.pot.map(c => new PhysCard(c, (Math.random()-0.5)*50, (Math.random()-0.5)*50));
    updateTurnBadge();
    checkBotMove();
});
// ✅ TURN SYSTEM (FIX: turno não passava)
socket.on("new_turn", (d) => {
    if (!currentRoom) return;

    currentTurnId = d.turnId;

    // atualiza quem é o turno
    currentRoom.currentTurn = d.nextTurn;

    // minha vez?
    isMyTurn = (d.nextTurn === socket.id);

    updateTurnBadge();

    // se for bot, dispara play
    checkBotMove();
});


// Chat
window.toggleChat = () => { document.getElementById('screen-chat').classList.toggle('active'); };
window.sendChat = () => { const t=document.getElementById('chat-input'); if(t.value){socket.emit('chat_send',t.value); t.value='';} };
socket.on('chat_message', d => {
    const div = document.createElement('div'); div.innerHTML = `<b style="color:#a29bfe">${d.user}:</b> ${d.text}`;
    const c = document.getElementById('chat-messages'); c.appendChild(div); c.scrollTop=c.scrollHeight;
});

// Physics
class PhysCard {
    constructor(data, x, y) {
        this.data = data; this.uid = data.uid; this.x = x; this.y = y; this.z = 0;
        this.vx=0; this.vy=0; this.vz=0; this.angleX = 0; this.velAngleX = 0; this.angleZ = (Math.random()-0.5)*360; this.velAngleZ = 0;
        this.w = 140; this.h = 200; this.settled = true; this.dead = false;
    }
    update() {
        if(this.dead) return;
        const isMoving = Math.abs(this.vx)>0.05 || Math.abs(this.vy)>0.05 || Math.abs(this.vz)>0.05;
        if (this.settled && !isMoving && this.z === 0) return;
        this.x += this.vx; this.y += this.vy; this.z += this.vz;
        this.angleX += this.velAngleX; this.angleZ += this.velAngleZ;
        if(this.z > 0) this.vz -= 0.5;
        if(this.z <= 0) {
            this.z = 0;
            if(Math.abs(this.vz) > 1.5) { this.vz *= -0.4; this.velAngleX *= 0.6; } 
            else { this.vz = 0; this.vx *= 0.85; this.vy *= 0.85; this.velAngleX *= 0.85; this.velAngleZ *= 0.85; }
            let norm = this.angleX % 360; if (norm < 0) norm += 360;
            const distTo0 = norm; const distTo180 = Math.abs(norm - 180);
            if (Math.min(distTo0, distTo180) > 10) {
                this.settled = false;
                if (norm > 90 && norm < 270) { if (norm < 180) this.velAngleX += 3.5; else this.velAngleX -= 3.5; } 
                else { if (norm <= 90) this.velAngleX -= 3.5; else this.velAngleX += 3.5; }
            } else {
                if (!isMoving && Math.abs(this.velAngleX) < 1) {
                    if (distTo180 < distTo0) this.angleX = 180; else this.angleX = 0;
                    this.velAngleX = 0; this.settled = true; this.checkWinCondition();
                }
            }
        } else { this.vx *= 0.99; this.vy *= 0.99; }
    }
    checkWinCondition() {
        if(this.dead) return;
        const norm = Math.abs(this.angleX % 360);
        const isFaceUp = (Math.abs(norm - 180) < 5);
        if(isFaceUp && (isMyTurn || currentRoom.currentTurn === BOT_ID)) {
            this.dead = true;
            spawnFlyingCard(this, isMyTurn ? socket.id : BOT_ID);
            socket.emit('card_flip_claim', { roomId: currentRoom.roomId, cardUID: this.uid, winnerIsBot: currentRoom.currentTurn === BOT_ID });
        }
    }
    draw(ctx) {
        if(this.dead) return;
        const depth = 1 + (this.z / 600); const rad = this.angleX * (Math.PI/180); const flip = Math.cos(rad);
        ctx.save(); ctx.translate(this.x, this.y - this.z); ctx.scale(depth, Math.abs(flip) * depth); ctx.rotate(this.angleZ * Math.PI/180);
        if(flip < 0) { 
            ctx.scale(-1, 1);
            const img = getCardImage(this.data.image);
            if(img) ctx.drawImage(img, -this.w/2, -this.h/2, this.w, this.h); else ctx.fillRect(-this.w/2, -this.h/2, this.w, this.h);
            ctx.lineWidth=5; ctx.strokeStyle = RARITY_COLORS[this.data.rarity] || 'gold'; ctx.strokeRect(-this.w/2, -this.h/2, this.w, this.h);
        } else { 
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

function startIn(x,y) { if(gameState!=='PLAYING' || !isMyTurn) return; input.active=true; input.startT=Date.now(); input.x=x; input.y=y; }
function moveIn(x,y) { if(input.active){input.x=x; input.y=y;} }
function endIn() {
    if(!input.active) return;
    input.active = false;

    armTurnSafety(); // ✅ evita travar turno

    const dt = Math.min(Date.now()-input.startT, 800);
    const pressure = dt/800;
    const world = screenToWorld(input.x, input.y);

    socket.emit('action_blow', { roomId: currentRoom.roomId, turnId: currentTurnId, x: world.x, y: world.y, pressure });
}


// ✅ safety timeout: nunca deixa turno preso
let turnSafetyTimer = null;

function armTurnSafety() {
    if (turnSafetyTimer) clearTimeout(turnSafetyTimer);
    turnSafetyTimer = setTimeout(() => {
        if (currentRoom && isMyTurn) {
            socket.emit("turn_end_request", { roomId: currentRoom.roomId });
        }
    }, 7000); // 7s no máximo por turno
}

// ✅ FIX TURN: checkTurnEnd (was missing)
// ✅ checkTurnEnd correto: passa turno quando as cartas param
function checkTurnEnd() {
    if (!currentRoom) return;

    // Só o dono do turno pode finalizar o turno
    if (!isMyTurn && currentRoom.currentTurn !== BOT_ID) return;

    // Espera todas as cartas pararem
    const allStopped = physicsCards.every(c => c.dead || c.settled);

    if (allStopped) {
        socket.emit("turn_end_request", { roomId: currentRoom.roomId });
    } else {
        setTimeout(checkTurnEnd, 400);
    }
}


function createExplosion(x, y, pressure) {
    const radius = 250 * (0.8 + pressure * 0.5); const force = 30 * pressure; let hitAny = false;
    physicsCards.forEach(c => {
        if(c.dead) return;
        const dist = Math.hypot(c.x-x, c.y-y);
        if(dist < radius) {
            hitAny = true; const impact = (1 - dist/radius);
            const dx = (c.x - x)/dist; const dy = (c.y - y)/dist;
            c.vx += dx * impact * 15; c.vy += dy * impact * 15; c.vz += force * impact * 1.2;
            c.velAngleX += force * impact; c.settled = false;
        }
    });
    if(hitAny) for(let i=0;i<25;i++) particles.push(new Particle(x,y));
    setTimeout(checkTurnEnd, 2000);
}

function loop() {
    ctx.clearRect(0,0,width,height);
    if(gameState==='PLAYING') {
        updateCamera();
        ctx.save(); ctx.translate(width/2, height/2); ctx.scale(camera.zoom, camera.zoom); ctx.translate(-camera.x, -camera.y);
        particles.forEach((p,i)=>{p.update(); p.draw(ctx); if(p.life<=0)particles.splice(i,1)});
        physicsCards.forEach(c=>{ c.update(); c.draw(ctx); });
        if(input.active && isMyTurn) {
            const dt = Math.min(Date.now()-input.startT, 800); const w = screenToWorld(input.x, input.y);
            ctx.beginPath(); ctx.arc(w.x, w.y, 50+(dt/10), 0, Math.PI*2); ctx.strokeStyle='yellow'; ctx.lineWidth=5; ctx.stroke();
        }
        ctx.restore();
        flyingCards.forEach((fc,i)=>{
            fc.x += (fc.tx - fc.x)*0.1; fc.y += (fc.ty - fc.y)*0.1; fc.scale -= 0.02;
            ctx.save(); ctx.translate(fc.x, fc.y); ctx.scale(fc.scale, fc.scale);
            const img = getCardImage(fc.image);
            if(img) ctx.drawImage(img,-40,-60,80,120); else ctx.fillRect(-40,-60,80,120);
            ctx.restore();
            if(fc.scale<=0) flyingCards.splice(i,1);
        });
    }
    requestAnimationFrame(loop);
}

function updateCamera() {
    // Escolhe alvos: cartas vivas (na mesa). Se não tiver, segue as flying.
    let targets = physicsCards.filter(c => c && !c.dead);
    if (targets.length === 0) targets = flyingCards;

    if (!targets || targets.length === 0) return;

    // bounding box dos alvos
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;

    targets.forEach(c => {
        const x = c.x ?? 0;
        const y = c.y ?? 0;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
    });

    if (minX === Infinity) return;

    // margem extra pra "não perder carta" quando sai da tela
    const margin = 380;
    minX -= margin;
    maxX += margin;
    minY -= margin;
    maxY += margin;

    const boxW = Math.max(1, (maxX - minX));
    const boxH = Math.max(1, (maxY - minY));

    // centro desejado
    const targetX = (minX + maxX) / 2;
    const targetY = (minY + maxY) / 2;

    // zoom desejado para caber no canvas
    const zx = width / boxW;
    const zy = height / boxH;
    let targetZoom = Math.min(zx, zy);

    // limita zoom pra não ficar absurdo
    targetZoom = Math.max(0.45, Math.min(1.15, targetZoom));

    // suavização cinematográfica
    camera.x += (targetX - camera.x) * 0.08;
    camera.y += (targetY - camera.y) * 0.08;
    camera.zoom += (targetZoom - camera.zoom) * 0.06;
}

function screenToWorld(sx, sy) { return { x: (sx-width/2)/camera.zoom + camera.x, y: (sy-height/2)/camera.zoom + camera.y }; }

socket.on('action_blow', d => createExplosion(d.x, d.y, d.pressure));
socket.on('card_won', d => { const idx = physicsCards.findIndex(c => c.uid === d.cardUID); if(idx > -1) { physicsCards[idx].dead = true; spawnFlyingCard(physicsCards[idx], d.winnerId); } });
socket.on('new_turn', d => { currentRoom.currentTurn = d.nextTurn; isMyTurn = d.nextTurn === socket.id; currentTurnId = d.turnId; updateTurnBadge(); checkBotMove(); });
socket.on('game_over', d => { 
    notify(d.message); 
    setTimeout(()=>{ gameState="MENU"; currentRoom=null; physicsCards=[]; document.getElementById('game-hud').style.display='none'; window.openMenu(); }, 3000); 
});
function checkBotMove() { if (currentRoom.currentTurn === BOT_ID) { socket.emit("bot_play_trigger", currentRoom.roomId); } }
socket.on('bot_should_play', d => { setTimeout(() => { if(physicsCards.some(c=>!c.dead)) { const t = physicsCards.find(c=>!c.dead); socket.emit("action_blow", { roomId: currentRoom.roomId, turnId: d.turnId, x: t.x, y: t.y, pressure: 1.0 }); } }, 1000); });

function notify(m) { const d=document.createElement('div'); d.className='toast'; d.innerText=m; document.getElementById('toast-area').appendChild(d); setTimeout(()=>d.remove(),3000); }
function spawnFlyingCard(c, wId) { flyingCards.push({ x: c.x, y: c.y, image: c.data.image, tx: width/2, ty: wId===socket.id?height-50:50, scale: 1 }); }
function updateTurnBadge() { const b = document.getElementById('turn-badge'); b.innerText = isMyTurn ? "SUA VEZ!" : `${opponentName}...`; b.style.color = isMyTurn ? "#00cec9" : "#aaa"; }

// Collection & Betting Helpers
function groupCards(collection) {
    const groups = {};
    collection.forEach(c => {
        const key = c.name + c.rarity;
        if (!groups[key]) groups[key] = { ...c, count: 0, uids: [] };
        groups[key].count++; groups[key].uids.push(c.uid);
    });
    return Object.values(groups);
}
window.renderCollection = () => {
    const g = document.getElementById('collection-grid'); g.innerHTML = '';
    groupCards(myUser.collection).forEach(item => {
        const div = document.createElement('div'); div.className = 'collection-item';
        const cardImg = document.createElement('div'); cardImg.className = 'grid-card';
        cardImg.style.backgroundImage = `url('${item.image}')`;
        if(item.count > 1) cardImg.innerHTML = `<div class="card-count">x${item.count}</div>`;
        cardImg.onclick = () => window.inspectCard(item.image);
        
        const btnSell = document.createElement('button'); btnSell.className = 'sell-btn-small';
        btnSell.innerText = "VENDER 1"; btnSell.onclick = () => window.sellCard(item.uids[0]);
        div.appendChild(cardImg); div.appendChild(btnSell); g.appendChild(div);
    });
};
window.openBetting = () => { 
    const g = document.getElementById('bet-grid'); g.innerHTML=''; window.selectedBet = [];
    groupCards(myUser.collection).forEach(item => {
        const d = document.createElement('div'); d.className = 'grid-card'; d.style.backgroundImage = `url('${item.image}')`;
        const counter = document.createElement('div'); counter.className = 'card-count'; counter.innerText = item.count; d.appendChild(counter);
        d.onclick = () => {
            const selCount = window.selectedBet.filter(uid => item.uids.includes(uid)).length;
            if (selCount < item.count && window.selectedBet.length < 5) {
                window.selectedBet.push(item.uids[selCount]);
                d.style.borderColor = '#00cec9'; d.style.boxShadow = '0 0 15px #00cec9';
            } else {
                window.selectedBet = window.selectedBet.filter(uid => !item.uids.includes(uid));
                d.style.borderColor = '#555'; d.style.boxShadow = 'none';
            }
            const left = item.count - window.selectedBet.filter(uid => item.uids.includes(uid)).length;
            counter.innerText = left;
        };
        g.appendChild(d);
    });
    document.querySelectorAll('.active').forEach(e=>e.classList.remove('active')); document.getElementById('screen-bet').classList.add('active');
};

let marketData = [];
socket.on('market_update', d => { marketData = d; if(document.getElementById('screen-market').classList.contains('active')) window.renderMarket(); });
window.renderMarket = () => { const g=document.getElementById('market-grid'); g.innerHTML=''; marketData.forEach(m => { if(m.seller===myUser.username) return; const d=document.createElement('div'); d.className='market-card'; d.innerHTML=`<div class="m-img" style="background-image:url('${m.card.image}')"></div><div class="m-info"><b>${m.card.name}</b><br>💰${m.price}</div>`; d.onclick=()=>socket.emit('market_buy', m.listingId); g.appendChild(d); }); };

window.doLogin = () => { const u=document.getElementById('login-user').value; if(u) socket.emit('login',{username:u}); };
window.buyBooster = () => window.openBoosterMixer();

window.createMatch = () => { if(![1,3,5].includes(window.selectedBet.length)) return notify("Escolha 1, 3 ou 5 cartas!"); socket.emit('create_match', window.selectedBet); };
window.openMarket = () => { document.querySelectorAll('.active').forEach(e=>e.classList.remove('active')); document.getElementById('screen-market').classList.add('active'); window.renderMarket(); };
window.openCollection = () => { document.querySelectorAll('.active').forEach(e=>e.classList.remove('active')); document.getElementById('screen-collection').classList.add('active'); window.renderCollection(); };
window.sellCard = (uid) => { const p=prompt("Preço (Gold):"); if(p) socket.emit('market_sell', { cardUID: uid, price: parseInt(p) }); window.openMenu(); };
window.openMenu = () => { document.querySelectorAll('.active').forEach(e=>e.classList.remove('active')); document.getElementById('screen-menu').classList.add('active'); };

canvas.addEventListener('mousedown',e=>startIn(e.clientX,e.clientY)); canvas.addEventListener('mousemove',e=>moveIn(e.clientX,e.clientY)); canvas.addEventListener('mouseup',endIn);
canvas.addEventListener('touchstart',e=>{e.preventDefault();startIn(e.touches[0].clientX,e.touches[0].clientY)},{passive:false}); canvas.addEventListener('touchmove',e=>{e.preventDefault();moveIn(e.touches[0].clientX,e.touches[0].clientY)},{passive:false}); canvas.addEventListener('touchend',endIn);
window.addEventListener('resize', () => { width=window.innerWidth; height=window.innerHeight; canvas.width=width; canvas.height=height; });
loop();