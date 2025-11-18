const express = require('express');
const app = express();

// Set up Express routes FIRST (before Socket.io)
// This ensures Render gets HTTP responses during cold starts

// Health check endpoint (Render pings this)
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'ok', 
        players: Object.keys(players).length,
        uptime: process.uptime() 
    });
});

// Serve the HTML file
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/strafe.html');
});

// NOW create Socket.io server
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ['websocket', 'polling'], // Try websocket first, fallback to polling
    allowEIO3: true
});

const players = {};
const moneyPickups = [];

console.log('Server initializing...');

// Clean up disconnected players periodically
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    
    Object.keys(players).forEach(id => {
        // Check if socket is actually connected
        const socket = io.sockets.sockets.get(id);
        if (!socket || !socket.connected) {
            console.log(`Cleaning up ghost player: ${id}`);
            delete players[id];
            cleaned++;
        }
    });
    
    if (cleaned > 0) {
        console.log(`Cleaned ${cleaned} ghost player(s)`);
    }
}, 10000); // Check every 10 seconds

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
                    radius: 15,
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
    
    // Handle wall death
    socket.on('wallDeath', (data) => {
        if (players[socket.id]) {
            // Drop money
            const moneyDrop = {
                x: data.x,
                y: data.y,
                amount: players[socket.id].dollarValue,
                radius: 15,
                id: Date.now() + Math.random()
            };
            moneyPickups.push(moneyDrop);
            
            // Respawn player
            players[socket.id].energy = 100;
            players[socket.id].dollarValue = 1.0;
            players[socket.id].x = 800;
            players[socket.id].y = 600;
            players[socket.id].velocityX = 0;
            players[socket.id].velocityY = 0;
            
            // Tell everyone
            io.emit('playerDied', { 
                playerId: socket.id, 
                respawn: players[socket.id],
                moneyDrop: moneyDrop
            });
            
            console.log(`Player ${socket.id} died by wall`);
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
const server = http.listen(PORT, '0.0.0.0', () => {
    console.log('=================================');
    console.log(`✓ Strafe server READY on port ${PORT}`);
    console.log(`✓ Game available at http://localhost:${PORT}`);
    console.log(`✓ Health check at http://localhost:${PORT}/health`);
    console.log('=================================');
});

// Handle server errors during startup
server.on('error', (err) => {
    console.error('Server error:', err);
    if (err.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use`);
        process.exit(1);
    }
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, closing server gracefully...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
    
    // Force close after 3 seconds if not done
    setTimeout(() => {
        console.log('Forcing shutdown...');
        process.exit(0);
    }, 3000);
});

process.on('SIGINT', () => {
    console.log('SIGINT received (Ctrl+C), closing server...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
    
    // Force close after 3 seconds if not done
    setTimeout(() => {
        console.log('Forcing shutdown...');
        process.exit(0);
    }, 3000);
});

// Handle uncaught errors
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});