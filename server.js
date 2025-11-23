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
        
        INVULNERABLE_TICKS: 120 // 2 seconds at 60 TPS
    },
    
    BULLET: {
        TYPES: {
            NORMAL: { speed: 6, radius: 8, damage: 15, energyCost: 5 },
            CHARGED1: { speed: 7, radius: 12, damage: 30, energyCost: 10 },
            CHARGED2: { speed: 8, radius: 16, damage: 45, energyCost: 15 }
        },
        MAX_LIFETIME_TICKS: 300 // 5 seconds at 60 TPS
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
    tickCount: 0,
    inputBuffers: {} // NEW: Store inputs per player
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
        invulnerableTicksRemaining: GAME_CONFIG.PLAYER.INVULNERABLE_TICKS,
        killStreak: 0,
        bountyMultiplier: 1.0,
        lastProcessedSequence: -1,
        currentInput: null, // Store most recent input
        isBoosting: false
    };
}

// ==================== PHYSICS & MOVEMENT ====================
function processPlayerInput(player, input) {
    if (!input || !player) return;
    
    // FIXED TIMESTEP - always 1.0 (represents one 60Hz tick)
    const deltaTime = 1.0;
    
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
    
    // Apply acceleration based on input
    const accel = GAME_CONFIG.PLAYER.ACCELERATION * deltaTime;
    player.velocityX += inputX * accel;
    player.velocityY += inputY * accel;
    
    // Handle boost energy drain
    const isBoosting = input.boost && player.energy > 0;
    if (isBoosting) {
        player.energy = Math.max(0, player.energy - GAME_CONFIG.PLAYER.ENERGY.BOOST_DRAIN * deltaTime);
    }
    
    // Update angle
    if (typeof input.angle === 'number') {
        player.angle = input.angle;
    }
    
    // Store boost state for physics
    player.isBoosting = isBoosting;
}

function updatePlayerPhysics(player) {
    if (!player) return;
    
    const deltaTime = 1.0;
    
    // Apply momentum/friction every tick
    const momentumFactor = Math.pow(GAME_CONFIG.PLAYER.MOMENTUM, deltaTime);
    player.velocityX *= momentumFactor;
    player.velocityY *= momentumFactor;
    
    // Cap velocity based on boost state
    const maxVel = player.isBoosting ? GAME_CONFIG.PLAYER.MAX_BOOST_VELOCITY : GAME_CONFIG.PLAYER.MAX_VELOCITY;
    const currentSpeed = Math.hypot(player.velocityX, player.velocityY);
    
    if (currentSpeed > maxVel) {
        player.velocityX = (player.velocityX / currentSpeed) * maxVel;
        player.velocityY = (player.velocityY / currentSpeed) * maxVel;
    }
    
    // Validate velocity is reasonable (anti-speed-hack)
    if (currentSpeed > GAME_CONFIG.VALIDATION.MAX_SPEED) {
        console.warn(`Player ${player.id} has suspicious velocity: ${currentSpeed.toFixed(2)}`);
        const scale = GAME_CONFIG.VALIDATION.MAX_SPEED / currentSpeed;
        player.velocityX *= scale;
        player.velocityY *= scale;
    }
    
    // Update position based on velocity
    player.x += player.velocityX * deltaTime;
    player.y += player.velocityY * deltaTime;
    
    // Wall collision - KILL PLAYER
    const r = GAME_CONFIG.PLAYER.RADIUS;
    if (player.x - r <= 0 || player.x + r >= GAME_CONFIG.ARENA_WIDTH ||
        player.y - r <= 0 || player.y + r >= GAME_CONFIG.ARENA_HEIGHT) {
        killPlayer(player.id, null);
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
        return;
    }
    
    // Deduct energy
    player.energy -= bulletType.energyCost;
    
    // Create bullet on server (spawn at barrel tip)
    const barrelLength = 35;
    const bullet = {
        id: `${playerId}_${gameState.tickCount}_${Math.random()}`,
        x: player.x + Math.cos(player.angle) * barrelLength,
        y: player.y + Math.sin(player.angle) * barrelLength,
        vx: Math.cos(player.angle) * bulletType.speed,
        vy: Math.sin(player.angle) * bulletType.speed,
        radius: bulletType.radius,
        damage: bulletType.damage,
        ownerId: playerId,
        chargeLevel: chargeLevel,
        createdAtTick: gameState.tickCount
    };
    
    gameState.bullets.push(bullet);
    
    // Broadcast bullet to all clients
    io.emit('bulletSpawned', bullet);
}

// ==================== BULLET PHYSICS ====================
function updateBullets() {
    // FIXED TIMESTEP - always 1.0
    const deltaTime = 1.0;
    
    for (let i = gameState.bullets.length - 1; i >= 0; i--) {
        const bullet = gameState.bullets[i];
        
        // Remove old bullets
        const bulletAge = gameState.tickCount - bullet.createdAtTick;
        if (bulletAge > GAME_CONFIG.BULLET.MAX_LIFETIME_TICKS) {
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
            if (player.id === bullet.ownerId) return;
            if (player.invulnerable) return;
            
            const dist = getDistance(bullet.x, bullet.y, player.x, player.y);
            if (dist < bullet.radius + GAME_CONFIG.PLAYER.RADIUS) {
                // HIT!
                player.energy -= bullet.damage;
                
                io.emit('playerHit', {
                    targetId: player.id,
                    shooterId: bullet.ownerId,
                    damage: bullet.damage,
                    energy: player.energy
                });
                
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
        id: `money_${gameState.tickCount}_${Math.random()}`,
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
    
    io.emit('playerDied', {
        playerId: deadPlayerId,
        killerId: killerId,
        moneyDrop: moneyDrop,
        respawn: deadPlayer
    });
}

// ==================== MONEY PICKUPS ====================
function updateMoneyPickups() {
    // FIXED TIMESTEP - always 1.0
    const deltaTime = 1.0;
    
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
    gameState.tickCount++;
    
    // Process NEW player inputs (update acceleration, boost state, angle)
    Object.values(gameState.players).forEach(player => {
        if (player.currentInput && player.currentInput.sequence !== undefined) {
            // Only process if it's newer than last processed
            if (player.currentInput.sequence > player.lastProcessedSequence) {
                processPlayerInput(player, player.currentInput);
                player.lastProcessedSequence = player.currentInput.sequence;
            }
        }
    });
    
    // Update physics for ALL players EVERY tick (momentum, position, collision)
    Object.values(gameState.players).forEach(player => {
        updatePlayerPhysics(player);
    });
    
    // Update invulnerability for all players
    Object.values(gameState.players).forEach(player => {
        if (player.invulnerable && player.invulnerableTicksRemaining > 0) {
            player.invulnerableTicksRemaining--;
            if (player.invulnerableTicksRemaining <= 0) {
                player.invulnerable = false;
            }
        }
    });
    
    // Regenerate energy for all players (happens every tick, even without input)
    Object.values(gameState.players).forEach(player => {
        // Only regenerate if not boosting (boost drain happens in updatePlayerMovement)
        const isBoosting = player.currentInput && player.currentInput.boost && player.energy > 0;
        if (!isBoosting) {
            player.energy = Math.min(
                GAME_CONFIG.PLAYER.ENERGY.MAX,
                player.energy + GAME_CONFIG.PLAYER.ENERGY.REGEN
            );
        }
    });
    
    // Update bullets
    updateBullets();
    
    // Update money pickups
    updateMoneyPickups();
    
    // Broadcast game state to all clients
    broadcastGameState();
}

// ==================== STATE BROADCASTING ====================
function broadcastGameState() {
    const snapshot = {
        tick: gameState.tickCount,
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
            invulnerableTicksRemaining: p.invulnerableTicksRemaining,
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
    console.log(`[CONNECT] Player ${socket.id}`);
    
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
    
    // Handle player input - BUFFER IT, don't process immediately!
    socket.on('input', (input) => {
        const player = gameState.players[socket.id];
        if (player) {
            // Store the most recent input to be processed on next tick
            player.currentInput = input;
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
        console.log(`[DISCONNECT] Player ${socket.id}`);
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
    
    // Start game loop at FIXED interval
    const tickInterval = 1000 / GAME_CONFIG.TICK_RATE;
    setInterval(gameLoop, tickInterval);
});