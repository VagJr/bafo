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

let physicsCards = [];
let particles = [];
let flyingCards = [];

const camera = { x: 0, y: 0, zoom: 1 };
const imgCache = {};

function createMagicalAtmosphere() {
    const layer = document.getElementById('magic-layer');
    if(!layer) return;
    layer.innerHTML = '';
    for(let i=0; i<50; i++) {
        const s = document.createElement('div');
        s.className = 'spore';
        s.style.left = Math.random() * 100 + '%';
        s.style.animationDuration = (5 + Math.random() * 10) + 's';
        s.style.animationDelay = (Math.random() * 5) + 's';
        layer.appendChild(s);
    }
}
createMagicalAtmosphere();

function getCardImage(url) {
    if (!url) return null;
    if (!imgCache[url]) {
        const i = new Image();
        i.src = url;
        imgCache[url] = i;
    }
    return imgCache[url];
}

const PHYSICS = {
    GRAVITY: 0.5,
    BOUNCE: 0.4, 
    FRICTION: 0.95, 
    TIPPING_FORCE: 3.5, // Força forte para derrubar
    SETTLE_SPEED: 0.05
};

class PhysCard {
    constructor(data, x, y) {
        this.data = data; this.uid = data.uid;
        this.x = x; this.y = y; this.z = 0;
        this.vx=0; this.vy=0; this.vz=0;
        
        this.angleX = 0; // 0=Costas, 180=Frente
        this.velAngleX = 0;
        this.angleZ = (Math.random()-0.5)*360; 
        this.velAngleZ = 0;
        
        this.w = 140; this.h = 200;
        this.settled = true; // Começa parado
        this.dead = false;
    }

    update() {
        if(this.dead) return;

        // Se está no chão e quase parando, verificar se está "de quina"
        const isMoving = Math.abs(this.vx) > PHYSICS.SETTLE_SPEED || Math.abs(this.vy) > PHYSICS.SETTLE_SPEED || Math.abs(this.vz) > PHYSICS.SETTLE_SPEED;
        const isRotating = Math.abs(this.velAngleX) > 0.5 || Math.abs(this.velAngleZ) > 0.5;

        if (this.settled && !isMoving && !isRotating && this.z === 0) return;

        // Movimento
        this.x += this.vx; this.y += this.vy; this.z += this.vz;
        this.angleX += this.velAngleX; this.angleZ += this.velAngleZ;

        // Gravidade
        if(this.z > 0) this.vz -= PHYSICS.GRAVITY;

        // Colisão Chão
        if(this.z <= 0) {
            this.z = 0;
            
            // Quique
            if(Math.abs(this.vz) > 1.5) {
                this.vz *= -PHYSICS.BOUNCE;
                this.velAngleX *= 0.6; // Perde rotação ao bater
                this.velAngleZ += (Math.random()-0.5)*4; // Caos lateral
            } else {
                this.vz = 0;
                // Atrito no chão
                this.vx *= 0.85; this.vy *= 0.85;
                this.velAngleX *= 0.85; this.velAngleZ *= 0.85;
            }

            // --- LÓGICA ANTI-QUINA (IMPORTANTE) ---
            // Calcula o quanto a carta está inclinada em relação ao chão (0 ou 180 é bom. 90 ou 270 é ruim)
            let norm = this.angleX % 360;
            if (norm < 0) norm += 360; // Normaliza positivos
            
            // Distância para os pontos de repouso (0 ou 180 ou 360)
            const distTo0 = norm;
            const distTo180 = Math.abs(norm - 180);
            const distTo360 = Math.abs(norm - 360);
            
            const minDist = Math.min(distTo0, distTo180, distTo360);

            // Se estiver perto de cair (velocidade baixa), mas o ângulo é ruim (> 20 graus de um plano)
            if (minDist > 10) {
                // Força a cair para o lado mais próximo
                // Se norm está entre 90 e 270, empurra pra 180. Se não, empurra pra 0/360.
                if (norm > 90 && norm < 270) {
                    // Quer ir pra 180
                    if (norm < 180) this.velAngleX += PHYSICS.TIPPING_FORCE;
                    else this.velAngleX -= PHYSICS.TIPPING_FORCE;
                } else {
                    // Quer ir pra 0 ou 360
                    if (norm <= 90) this.velAngleX -= PHYSICS.TIPPING_FORCE;
                    else this.velAngleX += PHYSICS.TIPPING_FORCE;
                }
                // Garante que não pare de se mover enquanto estiver torta
                this.settled = false;
            } else {
                // Está quase plana
                if (!isMoving && Math.abs(this.velAngleX) < 1) {
                    // SNAP: Arredonda o ângulo visual para ficar perfeito no chão
                    if (distTo180 < distTo0 && distTo180 < distTo360) this.angleX = 180;
                    else this.angleX = 0;
                    
                    this.velAngleX = 0;
                    this.vx = 0; this.vy = 0;
                    this.settled = true;
                    this.checkWinCondition();
                }
            }
        } else {
            // No ar (air drag)
            this.vx *= 0.99; this.vy *= 0.99;
        }
    }

    checkWinCondition() {
        if(this.dead) return;
        // Normaliza para verificar se está virada
        // Como fizemos o SNAP acima, agora angleX é exatamente 0 ou 180 (ou múltiplos)
        const norm = Math.abs(this.angleX % 360);
        // Se for 180, está virada
        const isFaceUp = (Math.abs(norm - 180) < 5);
        
        this.data.flipped = isFaceUp;

        if(isFaceUp) {
            if(isMyTurn) {
                this.dead = true;
                spawnFlyingCard(this, socket.id);
                socket.emit('card_flip_claim', { roomId: currentRoom.roomId, cardUID: this.uid });
            }
        }
    }

    draw(ctx) {
        if(this.dead) return;
        const depth = 1 + (this.z / 600);
        const rad = this.angleX * (Math.PI/180);
        const flip = Math.cos(rad);
        
        ctx.save();
        if(this.z > 2) {
            ctx.translate(this.x + this.z/3, this.y + this.z/3); ctx.rotate(this.angleZ * Math.PI/180);
            ctx.fillStyle = `rgba(0,0,0,${Math.max(0, 0.4 - this.z/500)})`;
            ctx.beginPath(); ctx.roundRect(-this.w/2, -this.h/2, this.w, this.h, 8); ctx.fill();
            ctx.restore(); ctx.save();
        }
        ctx.translate(this.x, this.y - this.z); ctx.scale(depth, Math.abs(flip) * depth); ctx.rotate(this.angleZ * Math.PI/180);
        
        // Evita linha invisível no momento exato da virada (90 graus)
        if (Math.abs(flip) < 0.05) {
            ctx.fillStyle = '#ccc'; ctx.fillRect(-this.w/2, -this.h/2, this.w, this.h);
            ctx.strokeStyle = '#888'; ctx.lineWidth = 2; ctx.strokeRect(-this.w/2, -this.h/2, this.w, this.h);
            ctx.restore(); return;
        }
        
        const isFace = flip < 0; // Cosine negativo = verso aparecendo (pelo nosso giro)
        // Correção de orientação visual baseada na rotação
        if(isFace) {
            ctx.scale(-1, 1); // Espelha imagem para não ficar invertida
            ctx.fillStyle = "#fff"; ctx.fillRect(-this.w/2, -this.h/2, this.w, this.h);
            const img = getCardImage(this.data.image);
            if(img && img.complete && img.naturalWidth > 0) ctx.drawImage(img, -this.w/2, -this.h/2, this.w, this.h);
            else { ctx.fillStyle = "#333"; ctx.fillText("Carregando...", -30, 0); }
            const colors = { common: '#bdc3c7', rare: '#3498db', epic: '#9b59b6', legend: '#f1c40f' };
            ctx.strokeStyle = colors[this.data.rarity] || 'gold'; ctx.lineWidth = 5; ctx.strokeRect(-this.w/2, -this.h/2, this.w, this.h);
        } else {
            ctx.fillStyle = "#2d3436"; ctx.fillRect(-this.w/2, -this.h/2, this.w, this.h);
            ctx.strokeStyle = "#636e72"; ctx.lineWidth = 4; ctx.strokeRect(-this.w/2+5, -this.h/2+5, this.w-10, this.h-10);
            ctx.fillStyle = "#b2bec3"; ctx.font = "20px Arial"; ctx.textAlign="center"; ctx.fillText("BAFO", 0, 5);
        }
        ctx.restore();
    }
}

class Particle {
    constructor(x, y) { this.x=x; this.y=y; this.life=1.0; this.vx=(Math.random()-0.5)*10; this.vy=(Math.random()-0.5)*10; }
    update() { this.x+=this.vx; this.y+=this.vy; this.life-=0.05; }
    draw(ctx) { ctx.globalAlpha=this.life; ctx.fillStyle='gold'; ctx.beginPath(); ctx.arc(this.x,this.y,Math.random()*5,0,Math.PI*2); ctx.fill(); ctx.globalAlpha=1; }
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
            const impact = (1 - dist/radius); // 1 = no centro, 0 = borda
            const dx = (c.x - x)/dist; const dy = (c.y - y)/dist;
            
            // ALEATORIEDADE NOS GIROS (O usuário pediu isso)
            const randSpin = (Math.random() - 0.5) * 50; // Giro aleatório inicial
            const spinDir = Math.random() > 0.5 ? 1 : -1;
            
            c.vx += dx * impact * 15; 
            c.vy += dy * impact * 15; 
            c.vz += force * impact * (0.8 + Math.random()*0.4); // Variação na altura
            
            // Adiciona rotação forte para tombar
            c.velAngleX += (force * 0.8 + Math.abs(randSpin)) * impact * spinDir; 
            c.velAngleZ += randSpin;
            
            c.settled = false;
        }
    });

    if(hitAny) for(let i=0;i<25;i++) particles.push(new Particle(x,y));
    if(isMyTurn && hasPlayed) setTimeout(checkTurnEnd, 2000);
}

function checkTurnEnd() {
    const allStopped = physicsCards.every(c => c.settled);
    if(allStopped) socket.emit('turn_end_request', { roomId: currentRoom.roomId }); else setTimeout(checkTurnEnd, 500);
}

function updateCamera() {
    if(physicsCards.length===0 && flyingCards.length===0) return;
    let minX=Infinity, maxX=-Infinity, minY=Infinity, maxY=-Infinity;
    let targets = physicsCards.filter(c => !c.dead);
    if(targets.length === 0) targets = flyingCards;
    targets.forEach(c => { minX=Math.min(minX,c.x); maxX=Math.max(maxX,c.x); minY=Math.min(minY,c.y); maxY=Math.max(maxY,c.y); });
    if(minX === Infinity) return;
    minX-=300; maxX+=300; minY-=300; maxY+=300;
    const tz = Math.max(0.3, Math.min(width/(maxX-minX), height/(maxY-minY), 1.2));
    const tx = (minX+maxX)/2; const ty = (minY+maxY)/2;
    camera.x += (tx-camera.x)*0.1; camera.y += (ty-camera.y)*0.1; camera.zoom += (tz-camera.zoom)*0.1;
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
        if(input.active) {
            const dt = Math.min(Date.now()-input.startT, 800); const w = screenToWorld(input.x, input.y);
            ctx.beginPath(); ctx.arc(w.x, w.y, 50+(dt/10), 0, Math.PI*2); ctx.strokeStyle=`rgba(255,200,0,${dt/800})`; ctx.lineWidth=5; ctx.stroke();
        }
        ctx.restore();
        flyingCards.forEach((fc,i)=>{
            fc.x += (fc.tx - fc.x)*0.1; fc.y += (fc.ty - fc.y)*0.1; fc.scale -= 0.02;
            ctx.save(); ctx.translate(fc.x, fc.y); ctx.scale(fc.scale, fc.scale);
            const img = getCardImage(fc.image);
            if(img) ctx.drawImage(img,-40,-60,80,120); else { ctx.fillStyle='white'; ctx.fillRect(-40,-60,80,120); }
            ctx.strokeStyle='gold'; ctx.strokeRect(-40,-60,80,120); ctx.restore();
            if(fc.scale<=0) flyingCards.splice(i,1);
        });
    }
    requestAnimationFrame(loop);
}

// UI Inputs
canvas.addEventListener('mousedown',e=>startIn(e.clientX,e.clientY));
canvas.addEventListener('mousemove',e=>moveIn(e.clientX,e.clientY));
canvas.addEventListener('mouseup',endIn);
canvas.addEventListener('touchstart',e=>{e.preventDefault();startIn(e.touches[0].clientX,e.touches[0].clientY)},{passive:false});
canvas.addEventListener('touchmove',e=>{e.preventDefault();moveIn(e.touches[0].clientX,e.touches[0].clientY)},{passive:false});
canvas.addEventListener('touchend',endIn);

function notify(m) { const d=document.createElement('div'); d.className='toast'; d.innerText=m; document.getElementById('toast-area').appendChild(d); setTimeout(()=>d.remove(),3000); }
function updateHUD() { document.getElementById('coins-display').innerText = myUser.coins; document.getElementById('cards-display').innerText = myUser.collection.length; }
function spawnFlyingCard(cardObj, winnerId) { flyingCards.push({ x: cardObj.x, y: cardObj.y, image: cardObj.data.image, tx: width/2, ty: winnerId===socket.id ? height-50 : 50, scale: 1 }); }

socket.on('login_success', u=>{ myUser=u; document.querySelectorAll('.active').forEach(e=>e.classList.remove('active')); document.getElementById('screen-menu').classList.add('active'); updateHUD(); });
socket.on('update_profile', u=>{ myUser=u; updateHUD(); window.renderCollection(); }); 
socket.on('booster_opened', newCards => {
    document.querySelectorAll('.active').forEach(e=>e.classList.remove('active'));
    const screen = document.getElementById('screen-booster');
    const display = document.getElementById('booster-display');
    display.innerHTML = '';
    newCards.forEach((c, i) => {
        const el = document.createElement('div');
        el.className = 'booster-card';
        el.style.backgroundImage = `url(${c.image})`;
        el.style.animationDelay = (i * 0.3) + 's';
        el.classList.add('reveal');
        display.appendChild(el);
    });
    screen.classList.add('active');
});

socket.on('game_start', r=>{
    currentRoom=r; gameState='PLAYING'; currentTurnId=r.turnId; isMyTurn=r.currentTurn===socket.id;
    document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active')); document.getElementById('game-hud').style.display='flex';
    hasPlayed=false;
    // Posição inicial espalhada
    physicsCards = r.pot.map((c,i)=>{ const a=Math.random()*Math.PI*2; const d=Math.random()*40; return new PhysCard(c, Math.cos(a)*d, Math.sin(a)*d); });
    notify(isMyTurn?"Sua Vez!":"Oponente..."); document.getElementById('turn-badge').innerText = isMyTurn?"SUA VEZ!":"AGUARDE...";
});
socket.on('action_blow', d => createExplosion(d.x, d.y, d.pressure));
socket.on('card_won', d => { const idx = physicsCards.findIndex(c => c.uid === d.cardUID); if(idx > -1) { physicsCards[idx].dead = true; spawnFlyingCard(physicsCards[idx], d.winnerId); } });
socket.on('new_turn', d => { isMyTurn = d.nextTurn === socket.id; currentTurnId = d.turnId; hasPlayed = false; document.getElementById('turn-badge').innerText = isMyTurn?"SUA VEZ!":"AGUARDE..."; if(isMyTurn) notify("Sua vez!"); });
socket.on('game_over', d => { notify(d.message); setTimeout(()=>window.location.reload(), 3000); });

let marketData = [];
socket.on('market_update', list => { 
    marketData = list; 
    if(document.getElementById('screen-market').classList.contains('active')) window.renderMarket(); 
});

window.doLogin = () => { const u=document.getElementById('login-user').value; if(u) socket.emit('login',{username:u}); };
window.buyBooster = () => socket.emit('buy_booster');
window.openBetting = () => { 
    const g=document.getElementById('bet-grid'); g.innerHTML=''; window.selectedBet=[];
    myUser.collection.forEach(c => {
        const d=document.createElement('div'); d.className='slot'; d.style.backgroundImage=`url(${c.image})`; d.style.backgroundSize='cover';
        d.onclick=()=>{ if(window.selectedBet.includes(c.uid)){ window.selectedBet=window.selectedBet.filter(i=>i!==c.uid); d.style.borderColor='transparent';} else { if(window.selectedBet.length<5) {window.selectedBet.push(c.uid); d.style.borderColor='#00cec9';} } };
        g.appendChild(d);
    });
    document.querySelectorAll('.active').forEach(e=>e.classList.remove('active')); document.getElementById('screen-bet').classList.add('active');
};
window.createMatch = () => { if(![1,3,5].includes(window.selectedBet.length)) return notify("Escolha 1, 3 ou 5 cartas!"); socket.emit('create_match', window.selectedBet); };
window.openMarket = () => { document.querySelectorAll('.active').forEach(e=>e.classList.remove('active')); document.getElementById('screen-market').classList.add('active'); window.renderMarket(); };
window.renderMarket = () => {
    const g = document.getElementById('market-grid'); g.innerHTML = '';
    if(marketData.length === 0) g.innerHTML = '<div style="padding:20px; color:#666">Nenhuma oferta no momento.</div>';
    
    marketData.forEach(m => {
        // Não mostrar minhas próprias ofertas
        if(m.seller === myUser.username) return; 

        const d = document.createElement('div'); d.className='market-card';
        d.innerHTML = `
            <div class="m-img" style="background-image:url(${m.card.image})"></div>
            <div class="m-info">
                <div><b>${m.card.name}</b></div>
                <div style="font-size:12px; color:#aaa">${m.card.source} • ${m.seller}</div>
                <div style="color:gold; margin-top:5px;">💰 ${m.price}</div>
            </div>
        `;
        d.onclick = () => { 
            if(myUser.coins < m.price) return notify("Sem grana!");
            if(confirm(`Comprar ${m.card.name} por ${m.price}?`)) socket.emit('market_buy', m.listingId); 
        };
        g.appendChild(d);
    });
};
window.openCollection = () => { document.querySelectorAll('.active').forEach(e=>e.classList.remove('active')); document.getElementById('screen-collection').classList.add('active'); window.renderCollection(); };
window.renderCollection = () => {
    const g = document.getElementById('collection-grid'); g.innerHTML = '';
    myUser.collection.forEach(c => {
        const d = document.createElement('div'); d.className='collection-card';
        d.innerHTML = `<div class="collection-img" style="background-image:url(${c.image})"></div><div class="collection-top">${c.name}</div><button class="sell-btn" onclick="window.sellCard('${c.uid}')">VENDER</button>`;
        g.appendChild(d);
    });
};
window.sellCard = (uid) => { 
    const price = prompt("Valor de venda:"); 
    if(price && !isNaN(price) && parseInt(price) > 0) { 
        socket.emit('market_sell', { cardUID: uid, price: parseInt(price) }); 
        window.openMenu(); 
    }
};
window.openMenu = () => { document.querySelectorAll('.active').forEach(e=>e.classList.remove('active')); document.getElementById('screen-menu').classList.add('active'); };
window.closeAll = () => window.location.reload();
window.addEventListener('resize', () => { width=window.innerWidth; height=window.innerHeight; canvas.width=width; canvas.height=height; });
loop();