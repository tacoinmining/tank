'use strict';

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 25000
});

const PORT = process.env.PORT || 3000;

// ─── Constants ──────────────────────────────────────────────────────────────────
const GRID_SIZE   = 10;
const SHIP_SIZES  = [5, 4, 3, 3, 2]; // total cells = 17
const TOTAL_CELLS = 17;

// ─── In-memory rooms storage ────────────────────────────────────────────────────
const rooms = {}; // pin → roomObject

// ─── Helpers ────────────────────────────────────────────────────────────────────
function generatePin() {
  let pin;
  do {
    pin = String(Math.floor(1000 + Math.random() * 9000));
  } while (rooms[pin]);
  return pin;
}

function createRoom(pin) {
  return {
    pin,
    players:      [],   // [socketId, socketId]
    names:        {},   // socketId -> string
    ships:        {},   // socketId -> array of ship objects
    shotsBy:      {},   // socketId -> Set<"x,y">
    ready:        {},   // socketId -> bool (ships submitted)
    wantsRematch: {},   // socketId -> bool
    currentTurn:  null, // socketId
    phase:        'waiting' // waiting | placement | battle | gameover
  };
}

// Validate that ships array matches required sizes, stays in bounds, is linear & contiguous, no overlaps
function validateShips(ships) {
  if (!Array.isArray(ships) || ships.length !== SHIP_SIZES.length) return false;

  // Check sizes match (sorted comparison)
  const expected = [...SHIP_SIZES].sort((a, b) => b - a);
  const submitted = ships.map(s => Array.isArray(s.cells) ? s.cells.length : 0).sort((a, b) => b - a);
  for (let i = 0; i < expected.length; i++) {
    if (expected[i] !== submitted[i]) return false;
  }

  const occupied = new Set();

  for (const ship of ships) {
    const cells = ship.cells;
    if (!Array.isArray(cells) || cells.length < 2) return false;

    const xs = cells.map(c => c.x);
    const ys = cells.map(c => c.y);

    // All cells must be within grid
    for (const c of cells) {
      if (typeof c.x !== 'number' || typeof c.y !== 'number') return false;
      if (c.x < 0 || c.x >= GRID_SIZE || c.y < 0 || c.y >= GRID_SIZE) return false;
    }

    // Must be a straight line (all same x OR all same y)
    const allSameX = xs.every(x => x === xs[0]);
    const allSameY = ys.every(y => y === ys[0]);
    if (!allSameX && !allSameY) return false;

    // Must be contiguous
    if (allSameX) {
      const sorted = [...ys].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i] !== sorted[i - 1] + 1) return false;
      }
    } else {
      const sorted = [...xs].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i] !== sorted[i - 1] + 1) return false;
      }
    }

    // No overlaps with other ships
    for (const c of cells) {
      const key = `${c.x},${c.y}`;
      if (occupied.has(key)) return false;
      occupied.add(key);
    }
  }

  return true;
}

function getOpponent(room, socketId) {
  return room.players.find(id => id !== socketId) || null;
}

// Process a shot: returns { hit, sunkCells, won } or null if already shot
function processShot(room, shooterId, x, y) {
  const opponentId  = getOpponent(room, shooterId);
  const shots       = room.shotsBy[shooterId];
  const key         = `${x},${y}`;

  if (shots.has(key)) return null; // duplicate shot
  shots.add(key);

  const opponentShips = room.ships[opponentId];
  let hit       = false;
  let sunkCells = null;

  for (const ship of opponentShips) {
    for (const cell of ship.cells) {
      if (cell.x === x && cell.y === y) {
        hit      = true;
        cell.hit = true;
        ship.hits++;
        if (ship.hits >= ship.cells.length) {
          ship.sunk = true;
          sunkCells = ship.cells.map(c => ({ x: c.x, y: c.y }));
        }
        break;
      }
    }
    if (hit) break;
  }

  const won = opponentShips.every(s => s.sunk);
  return { hit, sunkCells, won };
}

function resetRoomForRematch(room) {
  room.ships        = {};
  room.ready        = {};
  room.wantsRematch = {};
  room.currentTurn  = null;
  room.phase        = 'placement';
  for (const id of room.players) {
    room.shotsBy[id] = new Set();
  }
}

// ─── Socket.io events ───────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] ${socket.id} connected`);
  socket.data.name = 'Khách'; // default display name before joining a room

  // ── Create Room ─────────────────────────────────────────────────────────────
  socket.on('createRoom', ({ name }) => {
    if (socket.data.pin) return; // already in a room

    const playerName = (name || 'Thuyền Trưởng').slice(0, 20);
    const pin        = generatePin();
    const room       = createRoom(pin);
    rooms[pin]       = room;

    room.players.push(socket.id);
    room.names[socket.id]   = playerName;
    room.shotsBy[socket.id] = new Set();

    socket.join(pin);
    socket.data.pin  = pin;
    socket.data.name = playerName;

    socket.emit('roomCreated', { pin, playerIndex: 0, myName: playerName });
    console.log(`  Room ${pin} created by ${playerName}`);
  });

  // ── Join Room ───────────────────────────────────────────────────────────────
  socket.on('joinRoom', ({ pin, name }) => {
    if (socket.data.pin) return;

    const room = rooms[pin];
    if (!room) {
      socket.emit('joinError', { message: 'Không tìm thấy phòng với mã PIN này.' });
      return;
    }
    if (room.players.length >= 2) {
      socket.emit('joinError', { message: 'Phòng đã đầy (2/2 người chơi).' });
      return;
    }

    const playerName = (name || 'Thuyền Phó').slice(0, 20);
    room.players.push(socket.id);
    room.names[socket.id]   = playerName;
    room.shotsBy[socket.id] = new Set();

    socket.join(pin);
    socket.data.pin  = pin;
    socket.data.name = playerName;

    const hostName = room.names[room.players[0]];
    socket.emit('roomJoined', {
      pin,
      playerIndex:  1,
      myName:       playerName,
      opponentName: hostName
    });

    io.to(room.players[0]).emit('opponentJoined', { opponentName: playerName });

    // Both players present — start ship placement
    room.phase = 'placement';
    io.to(pin).emit('startPlacement', {
      shipSizes: SHIP_SIZES,
      names:     room.names
    });
    console.log(`  Room ${pin}: ${hostName} vs ${playerName} — placement started`);
  });

  // ── Submit Ships ────────────────────────────────────────────────────────────
  socket.on('submitShips', ({ ships }) => {
    const pin  = socket.data.pin;
    const room = rooms[pin];
    if (!room || room.phase !== 'placement') return;
    if (room.ready[socket.id]) return; // already submitted

    if (!validateShips(ships)) {
      socket.emit('shipError', { message: 'Sắp xếp tàu không hợp lệ. Thử lại.' });
      return;
    }

    // Store ships with server-side hit tracking
    room.ships[socket.id] = ships.map(ship => ({
      size:  ship.cells.length,
      cells: ship.cells.map(c => ({ x: c.x, y: c.y, hit: false })),
      hits:  0,
      sunk:  false
    }));
    room.ready[socket.id] = true;

    socket.emit('shipsAccepted');

    const opponentId = getOpponent(room, socket.id);
    if (opponentId) {
      io.to(opponentId).emit('opponentReady');
    }

    // Both ready → start battle
    if (room.players.length === 2 && room.players.every(id => room.ready[id])) {
      room.currentTurn = room.players[Math.floor(Math.random() * 2)];
      room.phase       = 'battle';

      io.to(pin).emit('startBattle', {
        firstTurn: room.currentTurn,
        names:     room.names
      });
      console.log(`  Room ${pin}: battle started, first turn = ${room.names[room.currentTurn]}`);
    }
  });

  // ── Shoot ───────────────────────────────────────────────────────────────────
  socket.on('shoot', ({ x, y }) => {
    const pin  = socket.data.pin;
    const room = rooms[pin];
    if (!room || room.phase !== 'battle')          return;
    if (room.currentTurn !== socket.id)            return; // wrong turn
    if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) return;

    const result = processShot(room, socket.id, x, y);
    if (!result) return; // already shot here

    const opponentId = getOpponent(room, socket.id);

    io.to(pin).emit('shotResult', {
      shooterId: socket.id,
      x,
      y,
      hit:       result.hit,
      sunkCells: result.sunkCells,
      won:       result.won
    });

    if (result.won) {
      room.phase = 'gameover';

      // Reveal both fleets to both players at game end
      io.to(socket.id).emit('revealEnemyFleet',   { ships: room.ships[opponentId] });
      io.to(opponentId).emit('revealEnemyFleet',  { ships: room.ships[socket.id] });

      io.to(pin).emit('gameOver', {
        winnerId:   socket.id,
        winnerName: room.names[socket.id]
      });
      console.log(`  Room ${pin}: ${room.names[socket.id]} won`);

    } else {
      // Miss → swap turn; Hit → same player continues
      if (!result.hit) {
        room.currentTurn = opponentId;
      }
      io.to(pin).emit('turnUpdate', { currentTurn: room.currentTurn });
    }
  });

  // ── Hack: Request opponent ship positions ───────────────────────────────────
  socket.on('requestHack', () => {
    const pin  = socket.data.pin;
    const room = rooms[pin];
    if (!room) return;

    const opponentId = getOpponent(room, socket.id);
    if (!opponentId || !room.ships[opponentId]) return;

    // Send sanitised ship positions (no hit state metadata needed for display)
    socket.emit('hackData', {
      ships: room.ships[opponentId].map(s => ({
        cells: s.cells.map(c => ({ x: c.x, y: c.y })),
        sunk:  s.sunk
      }))
    });
  });

  // ── Play Again (Rematch) ────────────────────────────────────────────────────
  socket.on('playAgain', () => {
    const pin  = socket.data.pin;
    const room = rooms[pin];
    if (!room || room.phase !== 'gameover') return;

    room.wantsRematch[socket.id] = true;

    const opponentId = getOpponent(room, socket.id);
    if (opponentId) {
      io.to(opponentId).emit('opponentWantsRematch', {
        name: room.names[socket.id]
      });
    }

    // If both want rematch, reset and restart placement
    if (room.players.length === 2 && room.players.every(id => room.wantsRematch[id])) {
      resetRoomForRematch(room);
      io.to(pin).emit('startPlacement', {
        shipSizes: SHIP_SIZES,
        names:     room.names
      });
      console.log(`  Room ${pin}: rematch started`);
    }
  });

  // ── Chat ────────────────────────────────────────────────────────────────────
  socket.on('chatMessage', ({ text }) => {
    const clean = String(text || '').trim().slice(0, 120);
    if (!clean) return;

    // Global broadcast — everyone on the site sees this message
    io.emit('chatMessage', {
      senderId:   socket.id,
      senderName: socket.data.name || 'Khách',
      text:       clean
    });
  });


  // ── Disconnect ──────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const pin  = socket.data.pin;
    const room = rooms[pin];
    if (!room) return;

    const opponentId = getOpponent(room, socket.id);
    if (opponentId) {
      io.to(opponentId).emit('opponentDisconnected', {
        name: room.names[socket.id] || 'Đối thủ'
      });
    }

    delete rooms[pin];
    console.log(`[-] ${socket.id} (${room.names[socket.id] || '?'}) disconnected, room ${pin} closed`);
  });
});

// ─── Static files ───────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ──────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`Battleship server running on port ${PORT}`);
});
