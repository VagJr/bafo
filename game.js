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
const images = {};
["card1.png", "card2.png", "card3.png", "card4.png", "card5.png"].forEach(n => {
    const i = new Image(); i.src = `assets/${n}`; images[n] = i;
});

const PHYSICS = {
    GRAVITY: 0.5,
    BOUNCE: 0.4, 
    FRICTION: 0.94,
    SETTLE_THRESHOLD: 0.1, // Velocidade mínima para considerar parada
    TIPPING_FORCE: 2 // Força para tombar a carta se ficar de pé
};

// --- CLASSE CARTA ---
class PhysCard {
    constructor(data, x, y) {
        this.data = data; this.uid = data.uid;
        this.x = x; this.y = y; this.z = 0;
        this.vx=0; this.vy=0; this.vz=0;
        
        // Rotação: 0 = Costas, 180 = Frente
        // Inicializa sempre virada para baixo (0) ou levemente inclinada
        this.angleX = 0; 
        this.velAngleX = 0;
        this.angleZ = (Math.random()-0.5)*360; // Rotação na mesa 
        this.velAngleZ = 0;
        
        this.w = 130; this.h = 180;
        this.settled = true;
        this.dead = false; // Se true, foi ganha
    }

    update() {
        if(this.dead) return;

        // Se move apenas se tiver velocidade ou estiver no ar
        if (!this.settled || this.z > 0.01 || Math.abs(this.vx)>0.01) {
            
            this.x += this.vx;
            this.y += this.vy;
            this.z += this.vz;
            this.angleX += this.velAngleX;
            this.angleZ += this.velAngleZ;

            // Gravidade
            if(this.z > 0) this.vz -= PHYSICS.GRAVITY;

            // Colisão Chão
            if(this.z <= 0) {
                this.z = 0;
                
                // Quique
                if(Math.abs(this.vz) > 1.0) {
                    this.vz *= -PHYSICS.BOUNCE;
                    // Ao bater no chão, perde rotação mas ganha "caos" no angulo Z
                    this.velAngleX *= 0.5;
                    this.velAngleZ += (Math.random()-0.5)*2; 
                } else {
                    this.vz = 0;
                    // Atrito forte no chão
                    this.vx *= 0.8;
                    this.vy *= 0.8;
                    this.velAngleX *= 0.8;
                    this.velAngleZ *= 0.8;
                }
            } else {
                // Ar
                this.vx *= 0.99; this.vy *= 0.99;
            }

            // --- LÓGICA DE TOMBAMENTO (ANTI-ACHATAMENTO) ---
            // Se a velocidade angular está baixa, força a cair
            if(this.z === 0 && Math.abs(this.velAngleX) < 2) {
                const normAngle = Math.abs(this.angleX % 360);
                
                // Se estiver "em pé" (perto de 90 ou 270)
                if ((normAngle > 70 && normAngle < 110) || (normAngle > 250 && normAngle < 290)) {
                    // Empurra para o lado mais próximo
                    if (normAngle < 90 || normAngle > 270) this.velAngleX -= PHYSICS.TIPPING_FORCE;
                    else this.velAngleX += PHYSICS.TIPPING_FORCE;
                } 
                else if (Math.abs(this.vx) < 0.1 && Math.abs(this.vy) < 0.1) {
                    this.settled = true;
                    this.checkWinCondition();
                }
            }
        }
    }

    checkWinCondition() {
        if(this.dead) return;
        
        // Normaliza ângulo
        const norm = Math.abs(this.angleX % 360);
        // Se estiver entre 90 e 270, é frente (VIRADA)
        const isFaceUp = (norm > 90 && norm < 270);
        
        this.data.flipped = isFaceUp;

        // Se virou, reseta ângulo visual para 180 (perfeitamente virada) e CLAMA
        if(isFaceUp) {
            this.angleX = 180;
            if(isMyTurn) {
                this.dead = true;
                spawnFlyingCard(this, socket.id);
                socket.emit('card_flip_claim', { 
                    roomId: currentRoom.roomId, 
                    cardUID: this.uid 
                });
            }
        } else {
            this.angleX = 0; // Perfeitamente de costas
        }
        
        this.velAngleX = 0;
    }

    draw(ctx) {
        if(this.dead) return;

        const depth = 1 + (this.z / 600);
        const rad = this.angleX * (Math.PI/180);
        const flip = Math.cos(rad); // -1 (Frente) a 1 (Verso)
        
        ctx.save();
        
        // 1. Sombra
        if(this.z > 2) {
            ctx.translate(this.x + this.z/3, this.y + this.z/3);
            ctx.rotate(this.angleZ * Math.PI/180);
            ctx.fillStyle = `rgba(0,0,0,${Math.max(0, 0.4 - this.z/500)})`;
            ctx.beginPath(); ctx.roundRect(-this.w/2, -this.h/2, this.w, this.h, 8); ctx.fill();
            ctx.restore();
            ctx.save();
        }

        ctx.translate(this.x, this.y - this.z);
        ctx.scale(depth, Math.abs(flip) * depth); // Efeito 3D
        ctx.rotate(this.angleZ * Math.PI/180);

        // --- RENDERIZAÇÃO DE BORDA (Anti-Achatamento Visual) ---
        // Se flip estiver muito perto de 0, desenha apenas uma linha grossa (a borda)
        if (Math.abs(flip) < 0.05) {
            ctx.fillStyle = '#ccc'; // Cor da borda do papel
            ctx.fillRect(-this.w/2, -this.h/2, this.w, this.h);
            ctx.strokeStyle = '#888';
            ctx.lineWidth = 2;
            ctx.strokeRect(-this.w/2, -this.h/2, this.w, this.h);
            ctx.restore();
            return;
        }

        const isFace = flip < 0;
        const img = images[`card${this.data.cardId}.png`];

        if(isFace) {
            // FRENTE
            ctx.fillStyle = "#fff";
            ctx.fillRect(-this.w/2, -this.h/2, this.w, this.h);
            if(img && img.complete) ctx.drawImage(img, -this.w/2, -this.h/2, this.w, this.h);
            
            // Borda de Raridade
            ctx.strokeStyle = "gold"; ctx.lineWidth = 4; ctx.strokeRect(-this.w/2, -this.h/2, this.w, this.h);
        } else {
            // VERSO
            ctx.fillStyle = "#2d3436";
            ctx.fillRect(-this.w/2, -this.h/2, this.w, this.h);
            ctx.strokeStyle = "#fab1a0"; ctx.lineWidth = 3; ctx.strokeRect(-this.w/2, -this.h/2, this.w, this.h);
            ctx.fillStyle = "#fab1a0"; ctx.font = "40px Arial"; ctx.textAlign="center"; ctx.fillText("?", 0, 15);
        }
        ctx.restore();
    }
}

// --- PARTICULAS ---
class Particle {
    constructor(x, y) {
        this.x=x; this.y=y; this.life=1.0;
        this.vx=(Math.random()-0.5)*10; this.vy=(Math.random()-0.5)*10;
    }
    update() { this.x+=this.vx; this.y+=this.vy; this.life-=0.05; }
    draw(ctx) {
        ctx.globalAlpha=this.life; ctx.fillStyle='gold';
        ctx.beginPath(); ctx.arc(this.x,this.y,4,0,Math.PI*2); ctx.fill();
        ctx.globalAlpha=1;
    }
}

// --- INPUT & EXPLOSÃO ---
const input = { active: false, startT: 0, x: 0, y: 0 };
let hasPlayed = false;

function startIn(x,y) {
    if(gameState!=='PLAYING' || !isMyTurn || hasPlayed) return;
    input.active=true; input.startT=Date.now(); input.x=x; input.y=y;
}
function moveIn(x,y) { if(input.active){input.x=x; input.y=y;} }
function endIn() {
    if(!input.active) return;
    input.active=false; hasPlayed=true;

    const dt = Math.min(Date.now()-input.startT, 800);
    const pressure = dt/800;
    const world = screenToWorld(input.x, input.y);

    socket.emit('action_blow', {
        roomId: currentRoom.roomId,
        turnId: currentTurnId,
        x: world.x, y: world.y, pressure
    });
}

function createExplosion(x, y, pressure) {
    // Adiciona variação aleatória no raio e na força para não haver "repeat logic"
    const chaos = (Math.random() * 0.2) + 0.9; // 0.9x a 1.1x
    const radius = 220 * (0.8 + pressure * 0.4) * chaos;
    const force = 25 * pressure * chaos;
    
    let hitAny = false;

    physicsCards.forEach(c => {
        if(c.dead) return;
        const dist = Math.hypot(c.x-x, c.y-y);
        
        if(dist < radius) {
            hitAny = true;
            const impact = (1 - dist/radius);
            
            // Vetor de empurrão
            const dx = (c.x - x)/dist;
            const dy = (c.y - y)/dist;

            // Ângulo aleatório para evitar padrão
            const spinDir = Math.random() > 0.5 ? 1 : -1;
            
            c.vx += dx * impact * 12;
            c.vy += dy * impact * 12;
            c.vz += force * impact; // Pulo
            c.velAngleX += force * impact * 2.5 * spinDir; // Giro
            
            c.settled = false;
        }
    });

    if(hitAny) for(let i=0;i<20;i++) particles.push(new Particle(x,y));

    // Se fui eu e joguei, espero um tempo e passo a vez se nada virou
    if(isMyTurn && hasPlayed) {
        setTimeout(checkTurnEnd, 2000);
    }
}

function checkTurnEnd() {
    // Se todas settled e nada mais virou, passa vez
    const allStopped = physicsCards.every(c => c.settled);
    if(allStopped) {
        socket.emit('turn_end_request', { roomId: currentRoom.roomId });
    } else {
        setTimeout(checkTurnEnd, 500); // Tenta de novo
    }
}

// --- CAMERA ---
function updateCamera() {
    if(physicsCards.length===0 && flyingCards.length===0) return;
    let minX=Infinity, maxX=-Infinity, minY=Infinity, maxY=-Infinity;
    
    // Foca apenas nas cartas vivas
    let targets = physicsCards.filter(c => !c.dead);
    if(targets.length === 0) targets = flyingCards; // Se nao tem cartas, foca nas voando

    targets.forEach(c => {
        minX=Math.min(minX,c.x); maxX=Math.max(maxX,c.x);
        minY=Math.min(minY,c.y); maxY=Math.max(maxY,c.y);
    });

    if(minX === Infinity) return; // Nada pra ver

    // Margem
    minX-=300; maxX+=300; minY-=300; maxY+=300;
    
    const tz = Math.max(0.3, Math.min(width/(maxX-minX), height/(maxY-minY), 1.2));
    const tx = (minX+maxX)/2;
    const ty = (minY+maxY)/2;

    camera.x += (tx-camera.x)*0.1;
    camera.y += (ty-camera.y)*0.1;
    camera.zoom += (tz-camera.zoom)*0.1;
}
function screenToWorld(sx, sy) {
    return { x: (sx-width/2)/camera.zoom + camera.x, y: (sy-height/2)/camera.zoom + camera.y };
}

// --- RENDER LOOP ---
function loop() {
    ctx.clearRect(0,0,width,height);
    
    if(gameState==='PLAYING') {
        updateCamera();
        ctx.save();
        ctx.translate(width/2, height/2);
        ctx.scale(camera.zoom, camera.zoom);
        ctx.translate(-camera.x, -camera.y);

        // Mesa
        ctx.beginPath(); ctx.arc(0,0,900,0,Math.PI*2); 
        ctx.strokeStyle='rgba(255,255,255,0.1)'; ctx.lineWidth=10; ctx.stroke();

        particles.forEach((p,i)=>{p.update(); p.draw(ctx); if(p.life<=0)particles.splice(i,1)});
        
        physicsCards.forEach(c=>{ c.update(); c.draw(ctx); });

        // Indicador de Pressão
        if(input.active) {
            const dt = Math.min(Date.now()-input.startT, PHYSICS.MAX_HOLD_TIME);
            const w = screenToWorld(input.x, input.y);
            ctx.beginPath(); ctx.arc(w.x, w.y, 50+(dt/10), 0, Math.PI*2);
            ctx.strokeStyle=`rgba(255,200,0,${dt/800})`; ctx.lineWidth=5; ctx.stroke();
        }
        ctx.restore();

        // Flying UI
        flyingCards.forEach((fc,i)=>{
            fc.x += (fc.tx - fc.x)*0.1; fc.y += (fc.ty - fc.y)*0.1;
            fc.scale -= 0.02;
            ctx.save(); ctx.translate(fc.x, fc.y); ctx.scale(fc.scale, fc.scale);
            const img = images[`card${fc.cardId}.png`];
            if(img) ctx.drawImage(img,-40,-60,80,120);
            ctx.strokeStyle='gold'; ctx.strokeRect(-40,-60,80,120);
            ctx.restore();
            if(fc.scale<=0) flyingCards.splice(i,1);
        });
    }
    requestAnimationFrame(loop);
}

// Listeners
canvas.addEventListener('mousedown',e=>startIn(e.clientX,e.clientY));
canvas.addEventListener('mousemove',e=>moveIn(e.clientX,e.clientY));
canvas.addEventListener('mouseup',endIn);
canvas.addEventListener('touchstart',e=>{e.preventDefault();startIn(e.touches[0].clientX,e.touches[0].clientY)},{passive:false});
canvas.addEventListener('touchmove',e=>{e.preventDefault();moveIn(e.touches[0].clientX,e.touches[0].clientY)},{passive:false});
canvas.addEventListener('touchend',endIn);

// Sockets e UI
function notify(m) {
    const d=document.createElement('div'); d.className='toast'; d.innerText=m;
    document.getElementById('toast-area').appendChild(d); setTimeout(()=>d.remove(),3000);
}
function updateHUD() {
    document.getElementById('coins-display').innerText = myUser.coins;
    document.getElementById('cards-display').innerText = myUser.collection.length;
}
function spawnFlyingCard(cardObj, winnerId) {
    flyingCards.push({
        x: cardObj.x, y: cardObj.y, 
        cardId: cardObj.data.cardId,
        tx: width/2, ty: winnerId===socket.id ? height-50 : 50,
        scale: 1
    });
}

socket.on('login_success', u=>{ myUser=u; document.querySelector('.active').classList.remove('active'); document.getElementById('screen-menu').classList.add('active'); updateHUD(); });
socket.on('game_start', r=>{
    currentRoom=r; gameState='PLAYING'; currentTurnId=r.turnId; isMyTurn=r.currentTurn===socket.id;
    document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
    document.getElementById('game-hud').style.display='flex';
    hasPlayed=false;
    
    physicsCards = r.pot.map((c,i)=>{
        // Espalha as cartas no centro (mas não coladas)
        const a=i*1.5; const d=20+(i*5);
        return new PhysCard(c, Math.cos(a)*d, Math.sin(a)*d);
    });
    notify(isMyTurn?"Sua Vez!":"Oponente...");
    document.getElementById('turn-badge').innerText = isMyTurn?"SUA VEZ!":"AGUARDE...";
});

socket.on('action_blow', d => createExplosion(d.x, d.y, d.pressure));

socket.on('card_won', d => {
    const idx = physicsCards.findIndex(c => c.uid === d.cardUID);
    if(idx > -1) {
        physicsCards[idx].dead = true;
        spawnFlyingCard(physicsCards[idx], d.winnerId);
    }
});

socket.on('new_turn', d => {
    isMyTurn = d.nextTurn === socket.id;
    currentTurnId = d.turnId;
    hasPlayed = false;
    document.getElementById('turn-badge').innerText = isMyTurn?"SUA VEZ!":"AGUARDE...";
    if(isMyTurn) notify("Sua vez!");
});

socket.on('game_over', d => { notify(d.message); setTimeout(()=>window.location.reload(), 3000); });

window.doLogin = () => { const u=document.getElementById('login-user').value; if(u) socket.emit('login',{username:u,password:'123'}); }; // Senha dummy pra teste
window.openBetting = () => { 
    const g=document.getElementById('bet-grid'); g.innerHTML=''; window.selectedBet=[];
    myUser.collection.forEach(c => {
        const d=document.createElement('div'); d.className='slot';
        d.style.backgroundImage=`url(assets/card${c.cardId}.png)`; d.style.backgroundSize='cover';
        d.onclick=()=>{
            if(window.selectedBet.includes(c.uid)){ window.selectedBet=window.selectedBet.filter(i=>i!==c.uid); d.style.borderColor='transparent';}
            else { if(window.selectedBet.length<5) {window.selectedBet.push(c.uid); d.style.borderColor='#00cec9';} }
        };
        g.appendChild(d);
    });
    document.querySelector('.active').classList.remove('active'); document.getElementById('screen-bet').classList.add('active');
};
window.createMatch = () => {
    if(![1,3,5].includes(window.selectedBet.length)) return notify("Escolha 1, 3 ou 5 cartas!");
    socket.emit('create_match', window.selectedBet);
};
window.closeAll = () => window.location.reload();
window.addEventListener('resize', () => { width=window.innerWidth; height=window.innerHeight; canvas.width=width; canvas.height=height; });

loop();