const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const players = {};
const moneyPickups = [];

app.get('/health', (req, res) => {
    res.json({ status: 'ok', players: Object.keys(players).length });
});

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/strafe.html');
});

io.on('connection', (socket) => {
    console.log('Player connected: ' + socket.id);
    
    players[socket.id] = {
        id: socket.id,
        x: 800,
        y: 600,
        angle: 0,
        velocityX: 0,
        velocityY: 0,
        dollarValue: 1.0,
        energy: 100,
        radius: 20
    };
    
    socket.emit('currentPlayers', players);
    socket.emit('currentMoney', moneyPickups);
    socket.broadcast.emit('newPlayer', players[socket.id]);
    
    socket.on('playerUpdate', (data) => {
        if (players[socket.id]) {
            players[socket.id] = { ...players[socket.id], ...data };
            socket.broadcast.emit('playerMoved', players[socket.id]);
        }
    });
    
    socket.on('playerShoot', (bulletData) => {
        io.emit('playerShot', { playerId: socket.id, bullet: bulletData });
    });
    
    socket.on('bulletHit', (data) => {
        const { shooterId, targetId, damage } = data;
        
        if (players[targetId]) {
            players[targetId].energy -= damage;
            
            io.emit('playerHit', { 
                targetId: targetId, 
                energy: players[targetId].energy 
            });
            
            if (players[targetId].energy <= 0) {
                const moneyDrop = {
                    x: players[targetId].x,
                    y: players[targetId].y,
                    amount: players[targetId].dollarValue,
                    radius: 15,
                    id: Date.now() + Math.random()
                };
                moneyPickups.push(moneyDrop);
                
                players[targetId].energy = 100;
                players[targetId].dollarValue = 1.0;
                players[targetId].x = 800;
                players[targetId].y = 600;
                players[targetId].velocityX = 0;
                players[targetId].velocityY = 0;
                
                io.emit('playerDied', { 
                    playerId: targetId, 
                    respawn: players[targetId],
                    moneyDrop: moneyDrop
                });
            }
        }
    });
    
    socket.on('wallDeath', (data) => {
        if (players[socket.id]) {
            const moneyDrop = {
                x: data.x,
                y: data.y,
                amount: players[socket.id].dollarValue,
                radius: 15,
                id: Date.now() + Math.random()
            };
            moneyPickups.push(moneyDrop);
            
            players[socket.id].energy = 100;
            players[socket.id].dollarValue = 1.0;
            players[socket.id].x = 800;
            players[socket.id].y = 600;
            players[socket.id].velocityX = 0;
            players[socket.id].velocityY = 0;
            
            io.emit('playerDied', { 
                playerId: socket.id, 
                respawn: players[socket.id],
                moneyDrop: moneyDrop
            });
        }
    });
    
    socket.on('pickupMoney', (moneyId) => {
        const index = moneyPickups.findIndex(m => m.id === moneyId);
        if (index !== -1) {
            const money = moneyPickups[index];
            if (players[socket.id]) {
                players[socket.id].dollarValue += money.amount;
                moneyPickups.splice(index, 1);
                io.emit('moneyPickedUp', { playerId: socket.id, moneyId: moneyId });
            }
        }
    });
    
    socket.on('ping', (startTime) => {
        socket.emit('pong', startTime);
    });
    
    socket.on('disconnect', () => {
        console.log('Player disconnected: ' + socket.id);
        delete players[socket.id];
        io.emit('playerDisconnected', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Strafe server running on port ${PORT}`);
});