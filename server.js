const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// ==================== GAME CONSTANTS ====================
const GAME_CONFIG = {
    TICK_RATE: 60, // Server runs at 60 TPS
    ARENA_WIDTH: 1600,
    ARENA_HEIGHT: 1200,
    
    PLAYER: {
        RADIUS: 20,
        BASE_SPEED: 2.2,
        BOOST_SPEED: 4.5,
        MOMENTUM: 0.98,
        MAX_VELOCITY: 4,
        MAX_BOOST_VELOCITY: 6,
        ACCELERATION: 0.3,
        
        ENERGY: {
            MAX: 100,
            REGEN: 0.15,
            BOOST_DRAIN: 0.3
        },
        
        INVULNERABLE_DURATION: 2000
    },
    
    BULLET: {
        TYPES: {
            NORMAL: { speed: 6, radius: 8, damage: 15, energyCost: 5 },
            CHARGED1: { speed: 7, radius: 12, damage: 30, energyCost: 10 },
            CHARGED2: { speed: 8, radius: 16, damage: 45, energyCost: 15 }
        },
        MAX_LIFETIME: 5000 // 5 seconds
    },
    
    VALIDATION: {
        MAX_SPEED: 10 // Maximum allowed speed (with buffer for boost)
    }
};

// ==================== GAME STATE ====================
const gameState = {
    players: {},
    bullets: [],
    moneyPickups: [],
    lastTickTime: Date.now(),
    tickCount: 0
};

// ==================== UTILITY FUNCTIONS ====================
function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function getDistance(x1, y1, x2, y2) {
    return Math.hypot(x2 - x1, y2 - y1);
}

function normalizeVector(x, y) {
    const length = Math.hypot(x, y);
    if (length === 0) return { x: 0, y: 0 };
    return { x: x / length, y: y / length };
}

function spawnPlayer(socketId) {
    const padding = 100;
    return {
        id: socketId,
        x: padding + Math.random() * (GAME_CONFIG.ARENA_WIDTH - padding * 2),
        y: padding + Math.random() * (GAME_CONFIG.ARENA_HEIGHT - padding * 2),
        velocityX: 0,
        velocityY: 0,
        angle: 0,
        energy: GAME_CONFIG.PLAYER.ENERGY.MAX,
        dollarValue: 1.0,
        invulnerable: true,
        invulnerableUntil: Date.now() + GAME_CONFIG.PLAYER.INVULNERABLE_DURATION,
        killStreak: 0,
        bountyMultiplier: 1.0,
        inputSequence: 0
    };
}

// ==================== PHYSICS & MOVEMENT ====================
function updatePlayerMovement(player, input, deltaTime) {
    if (!input) return;
    
    // Update input sequence (allow some out-of-order tolerance for packet loss)
    if (input.sequence < player.inputSequence - 5) {
        return; // Ignore very old inputs (likely duplicate/replayed)
    }
    
    player.inputSequence = Math.max(input.sequence, player.inputSequence);
    
    // Normalize input vector
    let inputX = 0;
    let inputY = 0;
    
    if (input.up) inputY -= 1;
    if (input.down) inputY += 1;
    if (input.left) inputX -= 1;
    if (input.right) inputX += 1;
    
    // Normalize diagonal movement
    if (inputX !== 0 && inputY !== 0) {
        const normalized = normalizeVector(inputX, inputY);
        inputX = normalized.x;
        inputY = normalized.y;
    }
    
    // Apply acceleration
    const accel = GAME_CONFIG.PLAYER.ACCELERATION * deltaTime;
    player.velocityX += inputX * accel;
    player.velocityY += inputY * accel;
    
    // Apply momentum/friction
    const momentumFactor = Math.pow(GAME_CONFIG.PLAYER.MOMENTUM, deltaTime);
    player.velocityX *= momentumFactor;
    player.velocityY *= momentumFactor;
    
    // Handle boost
    const isBoosting = input.boost && player.energy > 0;
    if (isBoosting) {
        player.energy = Math.max(0, player.energy - GAME_CONFIG.PLAYER.ENERGY.BOOST_DRAIN * deltaTime);
    } else {
        player.energy = Math.min(
            GAME_CONFIG.PLAYER.ENERGY.MAX, 
            player.energy + GAME_CONFIG.PLAYER.ENERGY.REGEN * deltaTime
        );
    }
    
    // Cap velocity
    const maxVel = isBoosting ? GAME_CONFIG.PLAYER.MAX_BOOST_VELOCITY : GAME_CONFIG.PLAYER.MAX_VELOCITY;
    const currentSpeed = Math.hypot(player.velocityX, player.velocityY);
    
    if (currentSpeed > maxVel) {
        player.velocityX = (player.velocityX / currentSpeed) * maxVel;
        player.velocityY = (player.velocityY / currentSpeed) * maxVel;
    }
    
    // Update position
    const newX = player.x + player.velocityX * deltaTime;
    const newY = player.y + player.velocityY * deltaTime;
    
    // Validate velocity is reasonable (anti-speed-hack)
    if (currentSpeed > GAME_CONFIG.VALIDATION.MAX_SPEED) {
        console.warn(`Player ${player.id} has suspicious velocity: ${currentSpeed.toFixed(2)}`);
        // Cap velocity instead of rejecting the entire input
        const scale = GAME_CONFIG.VALIDATION.MAX_SPEED / currentSpeed;
        player.velocityX *= scale;
        player.velocityY *= scale;
    }
    
    player.x = newX;
    player.y = newY;
    
    // Wall collision - KILL PLAYER
    const r = GAME_CONFIG.PLAYER.RADIUS;
    if (player.x - r <= 0 || player.x + r >= GAME_CONFIG.ARENA_WIDTH ||
        player.y - r <= 0 || player.y + r >= GAME_CONFIG.ARENA_HEIGHT) {
        killPlayer(player.id, null);
    }
    
    // Update angle (if provided)
    if (typeof input.angle === 'number') {
        player.angle = input.angle;
    }
    
    // Update invulnerability
    if (player.invulnerable && Date.now() > player.invulnerableUntil) {
        player.invulnerable = false;
    }
}

// ==================== SHOOTING ====================
function handleShoot(playerId, shootData) {
    const player = gameState.players[playerId];
    if (!player) return;
    
    const chargeLevel = shootData.chargeLevel || 0;
    let bulletType;
    
    switch(chargeLevel) {
        case 1:
            bulletType = GAME_CONFIG.BULLET.TYPES.CHARGED1;
            break;
        case 2:
            bulletType = GAME_CONFIG.BULLET.TYPES.CHARGED2;
            break;
        default:
            bulletType = GAME_CONFIG.BULLET.TYPES.NORMAL;
    }
    
    // Validate energy cost
    if (player.energy < bulletType.energyCost) {
        return; // Not enough energy
    }
    
    // Deduct energy
    player.energy -= bulletType.energyCost;
    
    // Create bullet on server
    const bullet = {
        id: `${playerId}_${gameState.tickCount}_${Date.now()}`,
        x: player.x + Math.cos(player.angle) * (GAME_CONFIG.PLAYER.RADIUS + 35),
        y: player.y + Math.sin(player.angle) * (GAME_CONFIG.PLAYER.RADIUS + 35),
        vx: Math.cos(player.angle) * bulletType.speed,
        vy: Math.sin(player.angle) * bulletType.speed,
        radius: bulletType.radius,
        damage: bulletType.damage,
        ownerId: playerId,
        chargeLevel: chargeLevel,
        createdAt: Date.now()
    };
    
    gameState.bullets.push(bullet);
    
    // Broadcast bullet to all clients
    io.emit('bulletSpawned', bullet);
}

// ==================== BULLET PHYSICS ====================
function updateBullets(deltaTime) {
    for (let i = gameState.bullets.length - 1; i >= 0; i--) {
        const bullet = gameState.bullets[i];
        
        // Remove old bullets
        if (Date.now() - bullet.createdAt > GAME_CONFIG.BULLET.MAX_LIFETIME) {
            gameState.bullets.splice(i, 1);
            io.emit('bulletRemoved', bullet.id);
            continue;
        }
        
        // Update position
        bullet.x += bullet.vx * deltaTime;
        bullet.y += bullet.vy * deltaTime;
        
        // Check wall collision
        if (bullet.x < 0 || bullet.x > GAME_CONFIG.ARENA_WIDTH ||
            bullet.y < 0 || bullet.y > GAME_CONFIG.ARENA_HEIGHT) {
            gameState.bullets.splice(i, 1);
            io.emit('bulletRemoved', bullet.id);
            continue;
        }
        
        // Check player collisions
        let hitPlayer = false;
        Object.values(gameState.players).forEach(player => {
            if (player.id === bullet.ownerId) return; // Can't hit yourself
            if (player.invulnerable) return; // Can't hit invulnerable players
            
            const dist = getDistance(bullet.x, bullet.y, player.x, player.y);
            if (dist < bullet.radius + GAME_CONFIG.PLAYER.RADIUS) {
                // HIT!
                player.energy -= bullet.damage;
                
                // Broadcast hit
                io.emit('playerHit', {
                    targetId: player.id,
                    shooterId: bullet.ownerId,
                    damage: bullet.damage,
                    energy: player.energy
                });
                
                // Check if player died
                if (player.energy <= 0) {
                    killPlayer(player.id, bullet.ownerId);
                }
                
                hitPlayer = true;
            }
        });
        
        if (hitPlayer) {
            gameState.bullets.splice(i, 1);
            io.emit('bulletRemoved', bullet.id);
        }
    }
}

// ==================== DEATH & RESPAWN ====================
function killPlayer(deadPlayerId, killerId) {
    const deadPlayer = gameState.players[deadPlayerId];
    if (!deadPlayer) return;
    
    // Drop money
    const moneyDrop = {
        id: `money_${Date.now()}_${Math.random()}`,
        x: deadPlayer.x,
        y: deadPlayer.y,
        amount: deadPlayer.dollarValue,
        radius: 15
    };
    gameState.moneyPickups.push(moneyDrop);
    
    // Update killer's streak
    if (killerId && gameState.players[killerId]) {
        const killer = gameState.players[killerId];
        killer.killStreak++;
        
        // Update bounty multiplier
        if (killer.killStreak === 0) {
            killer.bountyMultiplier = 1.0;
        } else if (killer.killStreak < 3) {
            killer.bountyMultiplier = 1.5;
        } else if (killer.killStreak < 5) {
            killer.bountyMultiplier = 2.0;
        } else {
            killer.bountyMultiplier = 3.0;
        }
    }
    
    // Respawn player
    const respawn = spawnPlayer(deadPlayerId);
    Object.assign(deadPlayer, respawn);
    
    // Broadcast death
    io.emit('playerDied', {
        playerId: deadPlayerId,
        killerId: killerId,
        moneyDrop: moneyDrop,
        respawn: deadPlayer
    });
}

// ==================== MONEY PICKUPS ====================
function updateMoneyPickups(deltaTime) {
    Object.values(gameState.players).forEach(player => {
        for (let i = gameState.moneyPickups.length - 1; i >= 0; i--) {
            const money = gameState.moneyPickups[i];
            const dist = getDistance(player.x, player.y, money.x, money.y);
            
            // Magnetic pull
            const magneticRange = 80;
            if (dist < magneticRange && dist > GAME_CONFIG.PLAYER.RADIUS + money.radius) {
                const pullStrength = 0.5 * deltaTime;
                const angle = Math.atan2(player.y - money.y, player.x - money.x);
                money.x += Math.cos(angle) * pullStrength;
                money.y += Math.sin(angle) * pullStrength;
            }
            
            // Pickup
            if (dist < GAME_CONFIG.PLAYER.RADIUS + money.radius) {
                player.dollarValue += money.amount;
                gameState.moneyPickups.splice(i, 1);
                
                io.emit('moneyPickedUp', {
                    playerId: player.id,
                    moneyId: money.id,
                    newDollarValue: player.dollarValue
                });
            }
        }
    });
}

// ==================== MAIN GAME LOOP ====================
function gameLoop() {
    const now = Date.now();
    const deltaTime = (now - gameState.lastTickTime) / (1000 / 60); // Normalize to 60 FPS baseline
    gameState.lastTickTime = now;
    gameState.tickCount++;
    
    // Update all players with their buffered inputs
    Object.values(gameState.players).forEach(player => {
        if (player.inputBuffer && player.inputBuffer.length > 0) {
            // Process ALL buffered inputs this tick
            player.inputBuffer.forEach(input => {
                updatePlayerMovement(player, input, deltaTime);
            });
            
            console.log(`[TICK] Player ${player.id.substring(0, 6)} | Processed ${player.inputBuffer.length} inputs`);
            
            // Clear buffer after processing
            player.inputBuffer = [];
        } else {
            // No input this tick, apply physics only
            if (gameState.tickCount % 60 === 0) { // Log once per second
                console.log(`[TICK] Player ${player.id.substring(0, 6)} | No queued input`);
            }
            
            const momentumFactor = Math.pow(GAME_CONFIG.PLAYER.MOMENTUM, deltaTime);
            player.velocityX *= momentumFactor;
            player.velocityY *= momentumFactor;
            
            player.x += player.velocityX * deltaTime;
            player.y += player.velocityY * deltaTime;
            
            // Regen energy
            player.energy = Math.min(
                GAME_CONFIG.PLAYER.ENERGY.MAX,
                player.energy + GAME_CONFIG.PLAYER.ENERGY.REGEN * deltaTime
            );
        }
    });
    
    // Update bullets
    updateBullets(deltaTime);
    
    // Update money pickups
    updateMoneyPickups(deltaTime);
    
    // Broadcast game state to all clients
    broadcastGameState();
}

// ==================== STATE BROADCASTING ====================
function broadcastGameState() {
    const snapshot = {
        tick: gameState.tickCount,
        timestamp: Date.now(),
        players: Object.values(gameState.players).map(p => ({
            id: p.id,
            x: p.x,
            y: p.y,
            velocityX: p.velocityX,
            velocityY: p.velocityY,
            angle: p.angle,
            energy: p.energy,
            dollarValue: p.dollarValue,
            invulnerable: p.invulnerable,
            killStreak: p.killStreak,
            bountyMultiplier: p.bountyMultiplier
        })),
        bullets: gameState.bullets,
        money: gameState.moneyPickups
    };
    
    io.emit('gameState', snapshot);
}

// ==================== SOCKET HANDLERS ====================
io.on('connection', (socket) => {
    const connectTime = Date.now();
    console.log('========================================');
    console.log(`[CONNECT] Player ${socket.id}`);
    console.log(`[CONNECT] Server time: ${connectTime}`);
    console.log('========================================');
    
    // Create new player
    gameState.players[socket.id] = spawnPlayer(socket.id);
    
    // Send initial state to new player
    socket.emit('init', {
        playerId: socket.id,
        config: GAME_CONFIG,
        gameState: {
            players: gameState.players,
            bullets: gameState.bullets,
            money: gameState.moneyPickups
        }
    });
    
    // Notify others
    socket.broadcast.emit('playerJoined', gameState.players[socket.id]);
    
    // Handle player input
    socket.on('input', (input) => {
        const player = gameState.players[socket.id];
        if (player) {
            // Debug logging
            const inputAge = Date.now() - input.timestamp;
            console.log(`[INPUT] Player ${socket.id.substring(0, 6)} | Age: ${inputAge}ms | Seq: ${input.sequence}`);
            
            // Buffer inputs instead of overwriting (handle high-ping packet accumulation)
            if (!player.inputBuffer) {
                player.inputBuffer = [];
            }
            player.inputBuffer.push(input);
            
            // Limit buffer size to prevent memory issues
            if (player.inputBuffer.length > 10) {
                player.inputBuffer.shift(); // Remove oldest
            }
        }
    });
    
    // Handle shooting
    socket.on('shoot', (shootData) => {
        handleShoot(socket.id, shootData);
    });
    
    // Handle ping
    socket.on('ping', (timestamp) => {
        socket.emit('pong', timestamp);
    });
    
    // Handle disconnect
    socket.on('disconnect', () => {
        console.log('========================================');
        console.log(`[DISCONNECT] Player ${socket.id}`);
        console.log('========================================');
        delete gameState.players[socket.id];
        io.emit('playerLeft', socket.id);
    });
});

// ==================== HTTP ROUTES ====================
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        players: Object.keys(gameState.players).length,
        bullets: gameState.bullets.length,
        money: gameState.moneyPickups.length,
        tickRate: GAME_CONFIG.TICK_RATE,
        uptime: process.uptime()
    });
});

app.get('/stats', (req, res) => {
    res.json({
        players: Object.keys(gameState.players).length,
        tickRate: GAME_CONFIG.TICK_RATE,
        region: 'US-EAST'
    });
});

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

app.get('/game', (req, res) => {
    res.sendFile(__dirname + '/strafe.html');
});

// ==================== SERVER START ====================
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`🎮 Strafe server running on port ${PORT}`);
    console.log(`⚡ Tick rate: ${GAME_CONFIG.TICK_RATE} TPS`);
    
    // Start game loop
    const tickInterval = 1000 / GAME_CONFIG.TICK_RATE;
    setInterval(gameLoop, tickInterval);
    
    gameState.lastTickTime = Date.now();
});