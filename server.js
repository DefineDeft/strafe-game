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
        energy: 100
    };
    
    // Send current players to new player
    socket.emit('currentPlayers', players);
    
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
    
    // Handle disconnection
    socket.on('disconnect', () => {
        console.log('Player disconnected: ' + socket.id);
        delete players[socket.id];
        io.emit('playerDisconnected', socket.id);
    });
});

const PORT = 3000;
http.listen(PORT, () => {
    console.log(`Strafe server running on port ${PORT}`);
    console.log(`Game available at http://localhost:${PORT}`);
});