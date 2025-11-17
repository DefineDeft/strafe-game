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

// Serve the HTML file
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/strafe.html');
});

io.on('connection', (socket) => {
    console.log('Player connected: ' + socket.id);
    
    // Initialize new player
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
    
    // Send current players to new player
    socket.emit('currentPlayers', players);
    
    // Send current money pickups
    socket.emit('currentMoney', moneyPickups);
    
    // Tell others about new player
    socket.broadcast.emit('newPlayer', players[socket.id]);
    
    // Handle player updates
    socket.on('playerUpdate', (data) => {
        if (players[socket.id]) {
            players[socket.id] = { ...players[socket.id], ...data };
            socket.broadcast.emit('playerMoved', players[socket.id]);
        }
    });
    
    // Handle shooting
    socket.on('playerShoot', (bulletData) => {
        io.emit('playerShot', { playerId: socket.id, bullet: bulletData });
    });
    
    // Handle bullet hits
    socket.on('bulletHit', (data) => {
        const { shooterId, targetId, damage } = data;
        
        if (players[targetId]) {
            players[targetId].energy -= damage;
            
            // Tell everyone about the hit
            io.emit('playerHit', { 
                targetId: targetId, 
                energy: players[targetId].energy 
            });
            
            // Check if player died
            if (players[targetId].energy <= 0) {
                // Drop money
                const moneyDrop = {
                    x: players[targetId].x,
                    y: players[targetId].y,
                    amount: players[targetId].dollarValue,
                    id: Date.now() + Math.random()
                };
                moneyPickups.push(moneyDrop);
                
                // Respawn player
                players[targetId].energy = 100;
                players[targetId].dollarValue = 1.0;
                players[targetId].x = 800;
                players[targetId].y = 600;
                players[targetId].velocityX = 0;
                players[targetId].velocityY = 0;
                
                // Tell everyone
                io.emit('playerDied', { 
                    playerId: targetId, 
                    respawn: players[targetId],
                    moneyDrop: moneyDrop
                });
                
                console.log(`Player ${targetId} killed by ${shooterId}`);
            }
        }
    });
    
    // Handle money pickup
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
    
    // Handle disconnection
    socket.on('disconnect', () => {
        console.log('Player disconnected: ' + socket.id);
        delete players[socket.id];
        io.emit('playerDisconnected', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Strafe server running on port ${PORT}`);
    console.log(`Game available at http://localhost:${PORT}`);
});