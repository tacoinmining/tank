const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 25000
});

const PORT = process.env.PORT || 3000;

const WORLD_SIZE        = 3000;
const TANK_SPEED        = 3.5;
const TANK_ROTATE_SPEED = 0.045;
const BULLET_SPEED      = 9;
const BULLET_MAX_DIST   = 1200;
const TANK_RADIUS       = 22;
const BULLET_RADIUS     = 5;
const MAX_HP            = 3;
const RESPAWN_DELAY_MS  = 2000;
const TICK_RATE         = 50;
const BROADCAST_RATE    = 16;

const COLOURS = [
  '#00e5ff', '#ff1744', '#76ff03', '#ffea00', '#d500f9',
  '#ff6d00', '#1de9b6', '#ff4081', '#69f0ae', '#40c4ff'
];

const players = {};
const bullets = {};
let   bulletIdCounter = 0;

function randomInRange(min, max) {
  return Math.random() * (max - min) + min;
}

function randomSpawn() {
  const margin = 200;
  return {
    x: randomInRange(margin, WORLD_SIZE - margin),
    y: randomInRange(margin, WORLD_SIZE - margin)
  };
}

function assignColour(usedColours) {
  const available = COLOURS.filter(c => !usedColours.includes(c));
  if (available.length > 0) {
    return available[Math.floor(Math.random() * available.length)];
  }
  return COLOURS[Math.floor(Math.random() * COLOURS.length)];
}

function circlesOverlap(ax, ay, ar, bx, by, br) {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy < (ar + br) * (ar + br);
}

function createPlayer(id, name) {
  const usedColours = Object.values(players).map(p => p.color);
  const spawn = randomSpawn();
  return {
    id,
    name:         name || ('Tank_' + id.slice(0, 4)),
    x:            spawn.x,
    y:            spawn.y,
    bodyAngle:    randomInRange(0, Math.PI * 2),
    turretAngle:  0,
    hp:           MAX_HP,
    score:        0,
    color:        assignColour(usedColours),
    isAlive:      true,
    lastFireTime: 0,
    input: {
      forward:     false,
      backward:    false,
      left:        false,
      right:       false,
      turretAngle: 0
    }
  };
}

function respawnPlayer(player) {
  const spawn = randomSpawn();
  player.x         = spawn.x;
  player.y         = spawn.y;
  player.bodyAngle = randomInRange(0, Math.PI * 2);
  player.hp        = MAX_HP;
  player.isAlive   = true;
}

function killPlayer(victim, killerId) {
  victim.isAlive = false;
  victim.hp      = 0;

  if (killerId && players[killerId]) {
    players[killerId].score += 1;
  }

  io.emit('killEvent', {
    victimId:   victim.id,
    victimName: victim.name,
    killerId:   killerId || null,
    killerName: killerId && players[killerId] ? players[killerId].name : null
  });

  setTimeout(() => {
    if (players[victim.id]) {
      respawnPlayer(victim);
      io.emit('respawnEvent', { playerId: victim.id });
    }
  }, RESPAWN_DELAY_MS);
}

function spawnBullet(player) {
  if (!player.isAlive) return;
  const id      = ++bulletIdCounter;
  const angle   = player.turretAngle;
  const nozzleX = player.x + Math.cos(angle) * 30;
  const nozzleY = player.y + Math.sin(angle) * 30;

  bullets[id] = {
    id,
    playerId:         player.id,
    x:                nozzleX,
    y:                nozzleY,
    vx:               Math.cos(angle) * BULLET_SPEED,
    vy:               Math.sin(angle) * BULLET_SPEED,
    distanceTraveled: 0,
    maxDistance:      BULLET_MAX_DIST
  };
}

function gameTick() {
  for (const id in players) {
    const p = players[id];
    if (!p.isAlive) continue;

    if (p.input.left)  p.bodyAngle -= TANK_ROTATE_SPEED;
    if (p.input.right) p.bodyAngle += TANK_ROTATE_SPEED;

    if (p.input.forward) {
      p.x += Math.cos(p.bodyAngle) * TANK_SPEED;
      p.y += Math.sin(p.bodyAngle) * TANK_SPEED;
    }
    if (p.input.backward) {
      p.x -= Math.cos(p.bodyAngle) * TANK_SPEED;
      p.y -= Math.sin(p.bodyAngle) * TANK_SPEED;
    }

    p.turretAngle = p.input.turretAngle;

    p.x = Math.max(TANK_RADIUS, Math.min(WORLD_SIZE - TANK_RADIUS, p.x));
    p.y = Math.max(TANK_RADIUS, Math.min(WORLD_SIZE - TANK_RADIUS, p.y));
  }

  for (const bid in bullets) {
    const b = bullets[bid];

    b.x += b.vx;
    b.y += b.vy;
    b.distanceTraveled += BULLET_SPEED;

    if (
      b.distanceTraveled >= b.maxDistance ||
      b.x < 0 || b.x > WORLD_SIZE ||
      b.y < 0 || b.y > WORLD_SIZE
    ) {
      delete bullets[bid];
      continue;
    }

    let hit = false;
    for (const pid in players) {
      const p = players[pid];
      if (pid === b.playerId) continue;
      if (!p.isAlive) continue;

      if (circlesOverlap(b.x, b.y, BULLET_RADIUS, p.x, p.y, TANK_RADIUS)) {
        p.hp -= 1;
        delete bullets[bid];
        hit = true;
        if (p.hp <= 0) {
          killPlayer(p, b.playerId);
        }
        break;
      }
    }
    if (hit) continue;
  }
}

function buildStateSnapshot() {
  const playerList = Object.values(players).map(p => ({
    id:          p.id,
    name:        p.name,
    x:           Math.round(p.x),
    y:           Math.round(p.y),
    bodyAngle:   p.bodyAngle,
    turretAngle: p.turretAngle,
    hp:          p.hp,
    score:       p.score,
    color:       p.color,
    isAlive:     p.isAlive
  }));

  const bulletList = Object.values(bullets).map(b => ({
    id:       b.id,
    playerId: b.playerId,
    x:        Math.round(b.x),
    y:        Math.round(b.y)
  }));

  return { players: playerList, bullets: bulletList };
}

setInterval(gameTick, TICK_RATE);
setInterval(() => {
  if (Object.keys(players).length === 0) return;
  io.emit('stateUpdate', buildStateSnapshot());
}, BROADCAST_RATE);

io.on('connection', (socket) => {
  console.log(`[+] Player connected: ${socket.id}`);

  socket.on('joinGame', (data) => {
    const name = (data && typeof data.name === 'string')
      ? data.name.trim().slice(0, 20) || ('Tank_' + socket.id.slice(0, 4))
      : ('Tank_' + socket.id.slice(0, 4));

    const player = createPlayer(socket.id, name);
    players[socket.id] = player;

    socket.emit('init', {
      selfId:    socket.id,
      worldSize: WORLD_SIZE,
      maxHp:     MAX_HP,
      state:     buildStateSnapshot()
    });

    console.log(`[+] ${name} joined. Total: ${Object.keys(players).length}`);
  });

  socket.on('input', (data) => {
    const p = players[socket.id];
    if (!p) return;
    p.input.forward     = !!data.forward;
    p.input.backward    = !!data.backward;
    p.input.left        = !!data.left;
    p.input.right       = !!data.right;
    p.input.turretAngle = typeof data.turretAngle === 'number' ? data.turretAngle : p.turretAngle;
  });

  socket.on('fire', () => {
    const p = players[socket.id];
    if (!p || !p.isAlive) return;
    const now = Date.now();
    if (now - p.lastFireTime >= 300) {
      p.lastFireTime = now;
      spawnBullet(p);
    }
  });

  socket.on('disconnect', () => {
    const p = players[socket.id];
    if (p) {
      console.log(`[-] ${p.name} disconnected.`);
      delete players[socket.id];
    }
  });
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
  console.log(`Blind Tank Arena server running on port ${PORT}`);
});
