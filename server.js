const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, '.')));

const PLAYERS = {};
const MATCHES = {};

// BANCO DE DADOS DE CARTAS (Mock)
const CARD_DATABASE = [
    { id: 1, img: 'card1.png', name: 'Guerreiro Slime', rarity: 'COMMON' },
    { id: 2, img: 'card2.png', name: 'Dragão de Papel', rarity: 'RARE' },
    { id: 3, img: 'card3.png', name: 'Feiticeira Neon', rarity: 'EPIC' },
    { id: 4, img: 'card4.png', name: 'Rei do Bafo', rarity: 'LEGEND' },
    { id: 5, img: 'card5.png', name: 'Fantasma Bloop', rarity: 'COMMON' }
];

io.on('connection', (socket) => {
    console.log('Jogador conectado:', socket.id);

    // --- PERFIL DO JOGADOR (MOEDAS INFINITAS AQUI) ---
    PLAYERS[socket.id] = {
        id: socket.id,
        coins: 9999999, // <--- MOEDAS INFINITAS
        collection: generateBooster(socket.id, 10), // Já começa com 10 cartas
        boostersOpened: 0
    };
    
    socket.emit('update_profile', PLAYERS[socket.id]);

    // --- ABRIR PACOTE ---
    socket.on('open_booster', () => {
        const player = PLAYERS[socket.id];
        // Cobra moedas (simbólico agora que é infinito)
        if (player.coins >= 100) {
            player.coins -= 100;
            const newCards = generateBooster(socket.id, 3);
            player.collection.push(...newCards);
            
            socket.emit('update_profile', player);
            socket.emit('booster_result', newCards);
        }
    });

    // --- ENTRAR NA MESA ---
    socket.on('find_match', (betCardUID) => {
        const player = PLAYERS[socket.id];
        const cardIndex = player.collection.findIndex(c => c.uid === betCardUID);
        
        if (cardIndex === -1) return; 

        const betCard = player.collection[cardIndex];

        // Procura sala
        let room = null;
        for (let id in MATCHES) {
            if (MATCHES[id].players.length === 1 && !MATCHES[id].started) {
                room = MATCHES[id];
                break;
            }
        }

        if (!room) {
            const roomId = 'room_' + socket.id;
            MATCHES[roomId] = { 
                id: roomId, 
                roomId: roomId,
                players: [socket.id], 
                pot: [betCard], 
                started: false
            };
            socket.join(roomId);
            socket.emit('waiting_opponent');
        } else {
            room.players.push(socket.id);
            room.pot.push(betCard);
            room.started = true;
            socket.join(room.id);
            io.to(room.id).emit('game_start', room);
        }
    });

    // --- RELATÓRIO DE FÍSICA (O Cliente decide quem virou) ---
    socket.on('physics_report', (data) => {
        const room = MATCHES[data.roomId];
        if (!room) return;

        let changed = false;
        data.results.forEach(res => {
            const card = room.pot.find(c => c.uid === res.uid);
            if (card && !card.flipped && res.flipped) {
                card.flipped = true;
                card.newOwner = socket.id; 
                changed = true;
            }
        });

        if (changed) {
            io.to(room.id).emit('round_result', room.pot);
        }

        if (room.pot.every(c => c.flipped)) {
            finalizeGame(room);
        }
    });
});

function finalizeGame(room) {
    room.pot.forEach(card => {
        if (card.newOwner && card.newOwner !== card.originalOwner) {
            transferCard(card.originalOwner, card.newOwner, card.uid);
        }
    });
    io.to(room.id).emit('game_over', { message: "Fim de Jogo! Cartas transferidas." });
    
    // Atualiza saldo/coleção de todos
    room.players.forEach(pid => {
        if(PLAYERS[pid]) io.to(pid).emit('update_profile', PLAYERS[pid]);
    });
    delete MATCHES[room.id];
}

function transferCard(fromId, toId, cardUID) {
    const loser = PLAYERS[fromId];
    const winner = PLAYERS[toId];
    if (!loser || !winner) return;

    const idx = loser.collection.findIndex(c => c.uid === cardUID);
    if (idx > -1) {
        const card = loser.collection.splice(idx, 1)[0];
        card.originalOwner = toId;
        card.flipped = false;
        card.newOwner = null;
        winner.collection.push(card);
    }
}

function generateBooster(ownerId, amount) {
    const cards = [];
    for(let i=0; i<amount; i++) {
        const template = CARD_DATABASE[Math.floor(Math.random() * CARD_DATABASE.length)];
        cards.push({
            uid: Math.random().toString(36).substr(2, 9),
            cardId: template.id,
            originalOwner: ownerId,
            flipped: false
        });
    }
    return cards;
}

http.listen(3000, () => console.log('🔥 Server Pronto: http://localhost:3000'));