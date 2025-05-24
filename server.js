const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Serve static files
app.use(express.static(path.join(__dirname)));

// Serve the main HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html')); // atau nama file HTML Anda
});

// Game state storage
const rooms = new Map();
const players = new Map();

// Generate random room code
function generateRoomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 6; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

// Generate random fish spawn
function generateFish() {
    const fishTypes = ['🐟', '🐠', '🐡', '🦈', '🐙'];
    return {
        id: Math.random().toString(36).substr(2, 9),
        type: fishTypes[Math.floor(Math.random() * fishTypes.length)],
        x: Math.random() * 90,
        y: Math.random() * 200 + 150,
        timestamp: Date.now()
    };
}

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Create new room
    socket.on('createRoom', (playerName) => {
        let roomCode;
        do {
            roomCode = generateRoomCode();
        } while (rooms.has(roomCode));

        const room = {
            code: roomCode,
            players: [],
            gameState: {
                active: false,
                startTime: null,
                duration: 60,
                fishes: [],
                scores: {}
            }
        };

        const player = {
            id: socket.id,
            name: playerName,
            roomCode: roomCode,
            score: 0,
            boatPosition: 50,
            ready: false
        };

        room.players.push(player);
        room.gameState.scores[socket.id] = 0;

        rooms.set(roomCode, room);
        players.set(socket.id, player);

        socket.join(roomCode);
        socket.emit('roomCreated', roomCode);

        console.log(`Room ${roomCode} created by ${playerName}`);
    });

    // Join existing room
    socket.on('joinRoom', (data) => {
        const { roomCode, playerName } = data;
        const room = rooms.get(roomCode);

        if (!room) {
            socket.emit('error', 'Room tidak ditemukan');
            return;
        }

        if (room.players.length >= 2) {
            socket.emit('error', 'Room sudah penuh');
            return;
        }

        if (room.gameState.active) {
            socket.emit('error', 'Game sedang berlangsung');
            return;
        }

        const player = {
            id: socket.id,
            name: playerName,
            roomCode: roomCode,
            score: 0,
            boatPosition: 50,
            ready: false
        };

        room.players.push(player);
        room.gameState.scores[socket.id] = 0;
        players.set(socket.id, player);

        socket.join(roomCode);

        // Notify all players in room
        const roomData = {
            roomCode: roomCode,
            players: room.players.map(p => ({ id: p.id, name: p.name, score: p.score }))
        };

        io.to(roomCode).emit('playerJoined', roomData);

        // If room is full, start countdown
        if (room.players.length === 2) {
            setTimeout(() => {
                startGame(roomCode);
            }, 3000);
        }

        console.log(`${playerName} joined room ${roomCode}`);
    });

    // Move boat
    socket.on('moveBoat', (data) => {
        const player = players.get(socket.id);
        if (!player) return;

        const room = rooms.get(player.roomCode);
        if (!room || !room.gameState.active) return;

        const { direction } = data;
        if (direction === 'left' && player.boatPosition > 0) {
            player.boatPosition = Math.max(0, player.boatPosition - 5);
        } else if (direction === 'right' && player.boatPosition < 100) {
            player.boatPosition = Math.min(100, player.boatPosition + 5);
        }

        // Broadcast boat position to room
        socket.to(player.roomCode).emit('boatMoved', {
            playerId: socket.id,
            position: player.boatPosition
        });
    });

    // Catch fish
    socket.on('catchFish', (data) => {
        const player = players.get(socket.id);
        if (!player) return;

        const room = rooms.get(player.roomCode);
        if (!room || !room.gameState.active) return;

        const { fishId, playerPosition } = data;
        const fish = room.gameState.fishes.find(f => f.id === fishId);
        
        if (!fish) return;

        // Check if player is close enough to catch the fish
        const distance = Math.abs(fish.x - playerPosition);
        if (distance <= 15) { // Within catching range
            // Remove fish from game state
            room.gameState.fishes = room.gameState.fishes.filter(f => f.id !== fishId);
            
            // Update score
            player.score++;
            room.gameState.scores[socket.id] = player.score;

            // Broadcast to all players in room
            io.to(player.roomCode).emit('fishCaught', {
                fishId: fishId,
                playerId: socket.id,
                playerName: player.name,
                newScore: player.score,
                scores: room.gameState.scores
            });

            console.log(`${player.name} caught a fish! Score: ${player.score}`);
        }
    });

    // Handle disconnection
    socket.on('disconnect', () => {
        const player = players.get(socket.id);
        if (player) {
            const room = rooms.get(player.roomCode);
            if (room) {
                // Remove player from room
                room.players = room.players.filter(p => p.id !== socket.id);
                delete room.gameState.scores[socket.id];

                // Notify other players
                socket.to(player.roomCode).emit('playerLeft', {
                    playerId: socket.id,
                    playerName: player.name
                });

                // If room is empty, delete it
                if (room.players.length === 0) {
                    rooms.delete(player.roomCode);
                    console.log(`Room ${player.roomCode} deleted (empty)`);
                } else {
                    // If game was active, end it
                    if (room.gameState.active) {
                        endGame(player.roomCode);
                    }
                }
            }
            players.delete(socket.id);
        }
        console.log('User disconnected:', socket.id);
    });
});

function startGame(roomCode) {
    const room = rooms.get(roomCode);
    if (!room || room.players.length !== 2) return;

    room.gameState.active = true;
    room.gameState.startTime = Date.now();
    room.gameState.fishes = [];

    // Reset scores
    room.players.forEach(player => {
        player.score = 0;
        player.boatPosition = 50;
        room.gameState.scores[player.id] = 0;
    });

    io.to(roomCode).emit('gameStarted', {
        duration: room.gameState.duration,
        players: room.players.map(p => ({ id: p.id, name: p.name, score: p.score }))
    });

    console.log(`Game started in room ${roomCode}`);

    // Spawn fish periodically
    const fishSpawner = setInterval(() => {
        if (!room.gameState.active) {
            clearInterval(fishSpawner);
            return;
        }

        const fish = generateFish();
        room.gameState.fishes.push(fish);

        io.to(roomCode).emit('fishSpawned', fish);

        // Remove fish after 5 seconds if not caught
        setTimeout(() => {
            room.gameState.fishes = room.gameState.fishes.filter(f => f.id !== fish.id);
            io.to(roomCode).emit('fishDespawned', fish.id);
        }, 5000);
    }, 2000);

    // Game timer
    const gameTimer = setTimeout(() => {
        endGame(roomCode);
        clearInterval(fishSpawner);
    }, room.gameState.duration * 1000);

    room.gameTimer = gameTimer;
    room.fishSpawner = fishSpawner;
}

function endGame(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return;

    room.gameState.active = false;
    
    // Clear timers
    if (room.gameTimer) clearTimeout(room.gameTimer);
    if (room.fishSpawner) clearInterval(room.fishSpawner);

    // Determine winner
    const scores = room.players.map(p => ({ id: p.id, name: p.name, score: p.score }));
    scores.sort((a, b) => b.score - a.score);

    let result;
    if (scores[0].score > scores[1].score) {
        result = {
            type: 'win',
            winner: scores[0],
            scores: scores
        };
    } else {
        result = {
            type: 'draw',
            scores: scores
        };
    }

    io.to(roomCode).emit('gameEnded', result);
    console.log(`Game ended in room ${roomCode}:`, result);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🎣 Fishing Game Server running on port ${PORT}`);
    console.log(`🌐 Access the game at http://localhost:${PORT}`);
});
