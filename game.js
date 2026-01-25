const socket = io();
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

// --- 1. VARIÁVEIS GLOBAIS (Inicialização Garantida) ---
let width = window.innerWidth;
let height = window.innerHeight;
let gameState = 'MENU';
let currentRoom = null;
let myCollection = [];
let loadedImages = {};
let physicsCards = []; 
let isSimulating = false;

// Input Variables
let inputState = {
    active: false,
    startX: 0, startY: 0,
    currX: 0, currY: 0,
    startTime: 0,
    history: []
};

// Config Canvas
canvas.width = width;
canvas.height = height;

// --- 2. ASSETS ---
function preloadImage(name) {
    const img = new Image();
    img.src = `assets/${name}`;
    loadedImages[name] = img;
}
// Carrega imagens iniciais
['card1.png', 'card2.png', 'card3.png', 'card4.png', 'card5.png'].forEach(preloadImage);

// --- 3. PHYSICS ENGINE CLASS ---
const GRAVITY = 0.8;
const AIR_RESISTANCE = 0.98;
const FLOOR_FRICTION = 0.9;

class PhysCard {
    constructor(data, x, y) {
        this.data = data;
        this.x = x;
        this.y = y;
        this.z = 0;
        this.vx = 0; this.vy = 0; this.vz = 0;
        this.angleX = data.flipped ? 180 : 0;
        this.angleZ = (Math.random() - 0.5) * 20;
        this.velAngleX = 0;
        this.velAngleZ = 0;
        this.settled = true;
        this.width = 120;
        this.height = 170;
    }

    update() {
        if (this.settled && this.z <= 0.1) return;

        this.x += this.vx;
        this.y += this.vy;
        this.z += this.vz;
        this.angleX += this.velAngleX;
        this.angleZ += this.velAngleZ;

        // Gravidade
        if (this.z > 0) {
            this.vz -= GRAVITY;
            this.settled = false;
        }

        // Chão
        if (this.z <= 0) {
            this.z = 0;
            if (Math.abs(this.vz) > 2) { // Quique
                this.vz *= -0.4;
                this.velAngleX *= 0.6;
            } else { // Parar
                this.vz = 0;
                this.settled = true;
                
                // Normaliza ângulo para ver se virou
                let deg = Math.abs(this.angleX % 360);
                if (deg > 90 && deg < 270) {
                    this.angleX = 180;
                    this.data.flipped = true;
                } else {
                    this.angleX = 0;
                    this.data.flipped = false;
                }
                this.velAngleX = 0;
                this.velAngleZ = 0;
            }
            // Atrito
            this.vx *= FLOOR_FRICTION;
            this.vy *= FLOOR_FRICTION;
            this.velAngleZ *= FLOOR_FRICTION;
        }
        
        // Ar
        this.vx *= AIR_RESISTANCE;
        this.vy *= AIR_RESISTANCE;
    }

    draw(ctx) {
        const scale = 1 + (this.z / 400); 
        const rad = this.angleX * (Math.PI / 180);
        const scaleY = Math.cos(rad); 
        const isShowingFace = scaleY < 0; 

        // Sombra
        ctx.save();
        ctx.translate(this.x + (this.z/2), this.y + (this.z/2));
        ctx.rotate(this.angleZ * (Math.PI / 180));
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.beginPath();
        ctx.roundRect(-this.width/2, -this.height/2, this.width, this.height, 10);
        ctx.fill();
        ctx.restore();

        // Carta
        ctx.save();
        ctx.translate(this.x, this.y - this.z);
        ctx.scale(scale, Math.abs(scaleY) * scale);
        ctx.rotate(this.angleZ * (Math.PI / 180));
        
        const w = this.width;
        const h = this.height;

        if (!isShowingFace) { // Verso
            ctx.fillStyle = '#2c3e50';
            ctx.beginPath();
            ctx.roundRect(-w/2, -h/2, w, h, 12);
            ctx.fill();
            ctx.strokeStyle = '#f1c40f';
            ctx.lineWidth = 4;
            ctx.stroke();
            ctx.fillStyle = '#f1c40f';
            ctx.font = '40px Arial';
            ctx.textAlign = 'center';
            ctx.fillText("?", 0, 15);
        } else { // Frente
            ctx.fillStyle = '#fff';
            ctx.beginPath();
            ctx.roundRect(-w/2, -h/2, w, h, 12);
            ctx.fill();
            
            const imgName = `card${this.data.cardId}.png`;
            if (loadedImages[imgName]) {
                ctx.save();
                ctx.beginPath();
                ctx.roundRect(-w/2+5, -h/2+5, w-10, h-10, 8);
                ctx.clip();
                // Invertemos Y se necessário, mas aqui desenhamos normal
                ctx.drawImage(loadedImages[imgName], -w/2, -h/2, w, h);
                ctx.restore();
            }
            
            ctx.strokeStyle = '#f1c40f';
            ctx.lineWidth = 5;
            ctx.stroke();
        }
        ctx.restore();
    }
}

// --- 4. FUNÇÕES DO JOGO ---

function initPhysicsCards(potData) {
    physicsCards = [];
    const cx = width / 2;
    const cy = height / 2;
    potData.forEach(cardData => {
        const offsetX = (Math.random() - 0.5) * 60;
        const offsetY = (Math.random() - 0.5) * 60;
        physicsCards.push(new PhysCard(cardData, cx + offsetX, cy + offsetY));
    });
}

// Loop Principal
function loop() {
    ctx.clearRect(0, 0, width, height);

    if (gameState === 'PLAYING') {
        let allSettled = true;
        physicsCards.forEach(card => {
            card.update();
            card.draw(ctx);
            if (!card.settled) allSettled = false;
        });

        // Desenha gesto da mão
        if (inputState.active) {
            ctx.beginPath();
            ctx.moveTo(inputState.history[0]?.x || 0, inputState.history[0]?.y || 0);
            inputState.history.forEach(p => ctx.lineTo(p.x, p.y));
            ctx.strokeStyle = 'rgba(255, 215, 0, 0.8)';
            ctx.lineWidth = 5;
            ctx.stroke();
            
            ctx.beginPath();
            ctx.arc(inputState.currX, inputState.currY, 20, 0, Math.PI*2);
            ctx.fillStyle = 'rgba(255,255,255,0.5)';
            ctx.fill();
        }

        // Verifica fim da simulação física
        if (isSimulating && allSettled) {
            isSimulating = false;
            // Envia relatório
            const results = physicsCards.map(c => ({ uid: c.data.uid, flipped: c.data.flipped }));
            socket.emit('physics_report', { roomId: currentRoom.roomId, results });
        }
    }
    requestAnimationFrame(loop);
}
// Inicia o Loop imediatamente
loop();

// --- 5. SOCKET HANDLERS ---
socket.on('update_profile', (p) => {
    document.getElementById('coin-display').innerText = p.coins;
    myCollection = p.collection;
});

socket.on('game_start', (room) => {
    currentRoom = room;
    gameState = 'PLAYING';
    initPhysicsCards(room.pot);
    window.toggleMenu(''); // Fecha menu
});

socket.on('round_result', (pot) => {
    if(currentRoom) currentRoom.pot = pot;
    initPhysicsCards(pot);
});

socket.on('game_over', (data) => {
    alert(data.message);
    gameState = 'MENU';
    window.toggleMenu('menu-main');
});

// --- 6. INPUT HANDLERS (BAFO GESTURES) ---
canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (gameState !== 'PLAYING' || isSimulating) return;
    const t = e.touches[0];
    inputState.active = true;
    inputState.startX = t.clientX; inputState.startY = t.clientY;
    inputState.currX = t.clientX; inputState.currY = t.clientY;
    inputState.startTime = Date.now();
    inputState.history = [{x: t.clientX, y: t.clientY, t: Date.now()}];
}, {passive: false});

canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (!inputState.active) return;
    const t = e.touches[0];
    inputState.currX = t.clientX; inputState.currY = t.clientY;
    inputState.history.push({x: t.clientX, y: t.clientY, t: Date.now()});
    if (inputState.history.length > 20) inputState.history.shift();
}, {passive: false});

canvas.addEventListener('touchend', (e) => {
    e.preventDefault();
    if (!inputState.active) return;
    
    // Lógica do Puxão
    const endTime = Date.now();
    const duration = endTime - inputState.startTime;
    const p1 = inputState.history[0];
    const p2 = inputState.history[inputState.history.length - 1];
    
    // Distância vertical (negativo = para cima)
    const distY = p2.y - p1.y;
    let force = 0;

    // 1. Puxada Rápida para Cima (Sweep Up)
    if (distY < -50 && duration < 300) {
        force = 40; 
    }
    // 2. Tapa Seco (Tap Rápido)
    else if (duration < 150 && Math.abs(distY) < 30) {
        force = 15;
    }

    if (force > 0) {
        applyForce(inputState.currX, inputState.currY, force);
    }
    inputState.active = false;
});

function applyForce(x, y, force) {
    isSimulating = true;
    physicsCards.forEach(card => {
        const dx = card.x - x;
        const dy = card.y - y;
        const dist = Math.sqrt(dx*dx + dy*dy);
        
        if (dist < 250) {
            const impact = (1 - (dist / 250)) * force;
            card.vz += impact * 1.2; // Sobe
            card.velAngleX += impact * 0.5; // Gira
            card.vx += (dx / dist) * impact * 0.3; // Espalha
            card.vy += (dy / dist) * impact * 0.3;
        }
    });
}

// --- 7. EXPORTANDO FUNÇÕES PARA O HTML (A CORREÇÃO DO REFERENCE ERROR) ---
window.toggleMenu = function(id) {
    document.querySelectorAll('.modal').forEach(m => m.classList.remove('active'));
    if(id && document.getElementById(id)) document.getElementById(id).classList.add('active');
};

window.openGacha = function() {
    socket.emit('open_booster');
};

window.openCollection = function() {
    window.toggleMenu('menu-collection');
    const grid = document.getElementById('collection-grid');
    grid.innerHTML = '';
    myCollection.forEach(c => {
        const d = document.createElement('div');
        d.className = 'grid-item';
        d.style.backgroundImage = `url(assets/card${c.cardId}.png)`;
        d.style.backgroundSize = 'cover';
        d.onclick = () => {
            document.querySelectorAll('.grid-item').forEach(x => x.classList.remove('selected'));
            d.classList.add('selected');
            window.selectedCard = c.uid;
        };
        grid.appendChild(d);
    });
};

window.confirmMatch = function() {
    if(!window.selectedCard) return alert("Escolha uma carta!");
    socket.emit('find_match', window.selectedCard);
};