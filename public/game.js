/* ═══════════════════════════════════════════════════════════════════════════════
   BLIND TANK ARENA — Client Game Engine
   Vanilla JS + HTML5 Canvas + Socket.io
═══════════════════════════════════════════════════════════════════════════════ */

'use strict';

// ─── Constants ─────────────────────────────────────────────────────────────────
const BASE_VISION_RADIUS  = 220;
const MUZZLE_VISION_BONUS = 280;   // extra radius on muzzle flash
const MUZZLE_FLASH_MS     = 120;
const BULLET_LIGHT_RADIUS = 40;
const FIRE_COOLDOWN_MS    = 300;
const GRID_SIZE           = 150;   // background grid cell size
const OBSTACLE_COLOR      = '#1a1a2e';

// ─── Runtime State ─────────────────────────────────────────────────────────────
let canvas, ctx;
let selfId      = null;
let worldSize   = 3000;
let maxHp       = 3;

let gameState   = { players: [], bullets: [] };   // latest server snapshot
let selfPlayer  = null;

// Input tracking
const keys = {
  w: false, s: false, a: false, d: false
};
let mouseWorld = { x: 0, y: 0 };  // mouse in world coords

// Camera — dùng lerp để di chuyển mượt
let camX     = 0;
let camY     = 0;
let targetCamX = 0;
let targetCamY = 0;
const CAM_LERP = 0.12;  // hệ số nội suy camera (0–1, càng cao càng nhanh)

// Fire cooldown
let lastFireTime = 0;

// Muzzle flash
let muzzleFlashUntil = 0;

// Notification timeout handle
let notifTimeout = null;

// ─── Map Hack (bí mật) ─────────────────────────────────────────────────────────
// Nhấn phím ] để bật / tắt chế độ nhìn toàn bản đồ (bỏ sương mù).
let isMapHack = false;

// ─── DOM references ─────────────────────────────────────────────────────────────
const loginScreen  = document.getElementById('loginScreen');
const gameScreen   = document.getElementById('gameScreen');
const nameInput    = document.getElementById('nameInput');
const joinBtn      = document.getElementById('joinBtn');
const hudPlayerName = document.getElementById('hudPlayerName');
const hpHearts     = document.getElementById('hpHearts');
const killCountEl  = document.getElementById('killCount');
const lbList       = document.getElementById('lbList');
const notification = document.getElementById('notification');

// ─── Socket ────────────────────────────────────────────────────────────────────
const socket = io();

// ─── Join logic ────────────────────────────────────────────────────────────────
joinBtn.addEventListener('click', joinGame);
nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinGame();
});

function joinGame() {
  const name = nameInput.value.trim() || 'Tank';
  socket.emit('joinGame', { name });
  loginScreen.classList.add('hidden');
  gameScreen.classList.remove('hidden');
  initCanvas();
  startLoop();
}

// ─── Canvas Init ───────────────────────────────────────────────────────────────
function initCanvas() {
  canvas = document.getElementById('gameCanvas');
  ctx    = canvas.getContext('2d');
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // Mouse move — compute world coords
  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx   = e.clientX - rect.left;
    const my   = e.clientY - rect.top;
    mouseWorld.x = mx - canvas.width  / 2 + camX;
    mouseWorld.y = my - canvas.height / 2 + camY;
  });

  // Mouse click — fire
  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const now = Date.now();
    if (now - lastFireTime >= FIRE_COOLDOWN_MS) {
      lastFireTime    = now;
      muzzleFlashUntil = now + MUZZLE_FLASH_MS;
      socket.emit('fire');
    }
  });
}

function resizeCanvas() {
  if (!canvas) return;
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
}

// ─── Keyboard Input ────────────────────────────────────────────────────────────
window.addEventListener('keydown', (e) => {
  // Dùng e.key để tương thích mọi layout bàn phím (kể cả Tiếng Việt)
  if (e.key === ']' || e.code === 'BracketRight') {
    e.preventDefault();
    isMapHack = !isMapHack;
    showNotification(
      isMapHack ? '🗺️ Nhìn toàn bản đồ: BẬT' : '🌑 Sương mù: BẬT',
      isMapHack ? '#ffea00' : '#00e5ff'
    );
    return;
  }
  switch (e.code) {
    case 'KeyW': case 'ArrowUp':    keys.w = true;  e.preventDefault(); break;
    case 'KeyS': case 'ArrowDown':  keys.s = true;  e.preventDefault(); break;
    case 'KeyA': case 'ArrowLeft':  keys.a = true;  e.preventDefault(); break;
    case 'KeyD': case 'ArrowRight': keys.d = true;  e.preventDefault(); break;
  }
});
window.addEventListener('keyup', (e) => {
  switch (e.code) {
    case 'KeyW': case 'ArrowUp':    keys.w = false; break;
    case 'KeyS': case 'ArrowDown':  keys.s = false; break;
    case 'KeyA': case 'ArrowLeft':  keys.a = false; break;
    case 'KeyD': case 'ArrowRight': keys.d = false; break;
  }
});


// ─── Socket Events ─────────────────────────────────────────────────────────────
socket.on('init', (data) => {
  selfId    = data.selfId;
  worldSize = data.worldSize;
  maxHp     = data.maxHp;
  applyState(data.state);
  buildHpHearts(maxHp);
});

socket.on('stateUpdate', (state) => {
  applyState(state);
});

socket.on('killEvent', (data) => {
  if (!selfId) return;
  if (data.victimId === selfId) {
    showNotification('💀 Bạn đã bị hạ gục bởi ' + (data.killerName || '???'), '#ff1744');
  } else if (data.killerId === selfId) {
    showNotification('🎯 Bạn đã hạ gục ' + data.victimName, '#76ff03');
  }
});

socket.on('respawnEvent', (data) => {
  if (data.playerId === selfId) {
    showNotification('🔄 Hồi sinh!', '#00e5ff');
  }
});

// ─── State application ─────────────────────────────────────────────────────────
function applyState(state) {
  gameState = state;
  selfPlayer = state.players.find(p => p.id === selfId) || null;
  updateHUD();
}

// ─── Input emission loop ────────────────────────────────────────────────────────
function emitInput() {
  if (!selfId || !selfPlayer) return;

  let turretAngle = 0;
  if (selfPlayer) {
    turretAngle = Math.atan2(
      mouseWorld.y - selfPlayer.y,
      mouseWorld.x - selfPlayer.x
    );
  }

  socket.emit('input', {
    forward:     keys.w,
    backward:    keys.s,
    left:        keys.a,
    right:       keys.d,
    turretAngle: turretAngle
  });
}

// ─── HUD ───────────────────────────────────────────────────────────────────────
function buildHpHearts(max) {
  hpHearts.innerHTML = '';
  for (let i = 0; i < max; i++) {
    const span = document.createElement('span');
    span.className = 'heart';
    span.dataset.idx = i;
    span.textContent = '❤';
    hpHearts.appendChild(span);
  }
}

function updateHUD() {
  if (!selfPlayer) return;

  hudPlayerName.textContent = selfPlayer.name;
  killCountEl.textContent   = selfPlayer.score;

  // HP hearts
  const hearts = hpHearts.querySelectorAll('.heart');
  hearts.forEach((h, i) => {
    h.classList.toggle('lost', i >= selfPlayer.hp);
  });

  // Leaderboard top 5
  const sorted = [...gameState.players]
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  lbList.innerHTML = '';
  sorted.forEach((p, idx) => {
    const li = document.createElement('li');
    if (p.id === selfId) li.classList.add('lbSelf');

    li.innerHTML = `
      <span class="lbRank">#${idx + 1}</span>
      <span class="lbDot" style="background:${p.color};box-shadow:0 0 6px ${p.color}"></span>
      <span class="lbName">${escapeHtml(p.name)}</span>
      <span class="lbScore">${p.score}</span>
    `;
    lbList.appendChild(li);
  });
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showNotification(text, color) {
  notification.textContent = text;
  notification.style.color = color || '#fff';
  notification.style.borderColor = (color || '#fff') + '44';
  notification.classList.remove('hidden');
  if (notifTimeout) clearTimeout(notifTimeout);
  notifTimeout = setTimeout(() => {
    notification.classList.add('hidden');
  }, 2200);
}

// ─── Main Game Loop ─────────────────────────────────────────────────────────────
function startLoop() {
  function loop() {
    emitInput();
    render();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDERING
// ─────────────────────────────────────────────────────────────────────────────

function render() {
  if (!canvas || !ctx) return;

  const W = canvas.width;
  const H = canvas.height;

  // ── Camera lerp: trượt mượt về vị trí xe người chơi ────────────────────────
  if (selfPlayer && selfPlayer.isAlive) {
    targetCamX = selfPlayer.x;
    targetCamY = selfPlayer.y;
  }
  camX += (targetCamX - camX) * CAM_LERP;
  camY += (targetCamY - camY) * CAM_LERP;

  // Clear
  ctx.fillStyle = '#0a0a10';
  ctx.fillRect(0, 0, W, H);

  if (isMapHack) {
    // ── MAP HACK: zoom out để thấy toàn bộ bản đồ ───────────────────────────
    // Tính tỉ lệ thu nhỏ để vừa màn hình (có padding 20px mỗi cạnh)
    const padding  = 20;
    const scaleX   = (W - padding * 2) / worldSize;
    const scaleY   = (H - padding * 2) / worldSize;
    const mapScale = Math.min(scaleX, scaleY);  // giữ tỉ lệ

    // Căn giữa bản đồ thu nhỏ trên màn hình
    const offsetX  = (W - worldSize * mapScale) / 2;
    const offsetY  = (H - worldSize * mapScale) / 2;

    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(mapScale, mapScale);

    drawGround();
    drawBoundary();
    drawBullets();
    drawPlayers();

    ctx.restore();

    // Vẽ khung viền bên ngoài bản đồ thu nhỏ
    ctx.save();
    ctx.strokeStyle = 'rgba(255,234,0,0.4)';
    ctx.lineWidth   = 1;
    ctx.strokeRect(offsetX, offsetY, worldSize * mapScale, worldSize * mapScale);
    ctx.restore();

    // Badge thông báo
    drawMapHackBadge(W);

  } else {
    // ── Chế độ bình thường: camera theo xe ──────────────────────────────────
    ctx.save();
    ctx.translate(W / 2 - camX, H / 2 - camY);

    drawGround();
    drawBoundary();
    drawBullets();
    drawPlayers();

    ctx.restore();

    // Áp sương mù
    applyFogOfWar(W, H);
  }
}

// ─── Draw tiled ground grid ────────────────────────────────────────────────────
function drawGround() {
  const startX = Math.floor((camX - canvas.width  / 2) / GRID_SIZE) * GRID_SIZE;
  const startY = Math.floor((camY - canvas.height / 2) / GRID_SIZE) * GRID_SIZE;
  const endX   = camX + canvas.width  / 2 + GRID_SIZE;
  const endY   = camY + canvas.height / 2 + GRID_SIZE;

  // Ground fill
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, worldSize, worldSize);

  // Grid lines
  ctx.strokeStyle = 'rgba(255,255,255,0.03)';
  ctx.lineWidth   = 1;
  ctx.beginPath();
  for (let x = startX; x <= endX; x += GRID_SIZE) {
    const cx = Math.max(0, Math.min(worldSize, x));
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, worldSize);
  }
  for (let y = startY; y <= endY; y += GRID_SIZE) {
    const cy = Math.max(0, Math.min(worldSize, y));
    ctx.moveTo(0, cy);
    ctx.lineTo(worldSize, cy);
  }
  ctx.stroke();
}

// ─── Draw neon world boundary ──────────────────────────────────────────────────
function drawBoundary() {
  ctx.save();
  ctx.strokeStyle = '#ff1744';
  ctx.lineWidth   = 4;
  ctx.shadowBlur  = 16;
  ctx.shadowColor = '#ff1744';
  ctx.strokeRect(0, 0, worldSize, worldSize);

  // Inner glow stripe
  ctx.strokeStyle = 'rgba(255,23,68,0.25)';
  ctx.lineWidth   = 20;
  ctx.strokeRect(10, 10, worldSize - 20, worldSize - 20);
  ctx.restore();
}

// ─── Draw all bullets ─────────────────────────────────────────────────────────
function drawBullets() {
  for (const b of gameState.bullets) {
    const owner = gameState.players.find(p => p.id === b.playerId);
    const color = owner ? owner.color : '#fff';

    ctx.save();
    ctx.beginPath();
    ctx.arc(b.x, b.y, 5, 0, Math.PI * 2);
    ctx.fillStyle   = color;
    ctx.shadowBlur  = 10;
    ctx.shadowColor = color;
    ctx.fill();
    ctx.restore();
  }
}

// ─── Draw all players / tanks ─────────────────────────────────────────────────
function drawPlayers() {
  for (const p of gameState.players) {
    if (!p.isAlive) continue;
    drawTank(p);
    drawPlayerLabel(p);
  }
}

// ─── Draw a single tank ───────────────────────────────────────────────────────
function drawTank(p) {
  ctx.save();
  ctx.translate(p.x, p.y);

  const isSelf  = p.id === selfId;
  const col     = p.color;

  // ── Body ──────────────────────────────────────────────────────────────────
  ctx.save();
  ctx.rotate(p.bodyAngle);

  // Left track
  drawTrack(-14, col);
  // Right track
  drawTrack(14, col);

  // Main hull
  ctx.fillStyle   = col;
  ctx.shadowBlur  = isSelf ? 18 : 10;
  ctx.shadowColor = col;
  roundRect(ctx, -20, -13, 40, 26, 4);
  ctx.fill();

  // Hull shading overlay
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  roundRect(ctx, -18, 2, 36, 10, 3);
  ctx.fill();

  // Hull highlight
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  roundRect(ctx, -18, -11, 36, 8, 3);
  ctx.fill();

  ctx.restore();

  // ── Turret (rotates independently) ────────────────────────────────────────
  ctx.save();
  ctx.rotate(p.turretAngle);

  // Turret circle
  ctx.beginPath();
  ctx.arc(0, 0, 12, 0, Math.PI * 2);
  ctx.fillStyle   = shadeColor(col, -30);
  ctx.shadowBlur  = 8;
  ctx.shadowColor = col;
  ctx.fill();
  ctx.strokeStyle = col;
  ctx.lineWidth   = 1.5;
  ctx.stroke();

  // Gun barrel
  ctx.fillStyle   = shadeColor(col, -50);
  ctx.shadowBlur  = 6;
  roundRect(ctx, 6, -4, 26, 8, 2);
  ctx.fill();

  // Barrel highlight
  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  roundRect(ctx, 6, -4, 26, 3, 1);
  ctx.fill();

  ctx.restore();

  ctx.restore();
}

// ─── Draw tank track strip ────────────────────────────────────────────────────
function drawTrack(offsetY, col) {
  const trackColor = shadeColor(col, -70);
  ctx.fillStyle    = trackColor;
  roundRect(ctx, -22, offsetY - 5, 44, 10, 3);
  ctx.fill();

  // Track segments
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth   = 1;
  for (let i = -18; i <= 18; i += 7) {
    ctx.beginPath();
    ctx.moveTo(i, offsetY - 5);
    ctx.lineTo(i, offsetY + 5);
    ctx.stroke();
  }
}

// ─── Draw player name label ────────────────────────────────────────────────────
function drawPlayerLabel(p) {
  const isSelf = p.id === selfId;
  ctx.save();
  ctx.translate(p.x, p.y - 36);

  ctx.font      = `bold ${isSelf ? 12 : 11}px "Segoe UI", Arial, sans-serif`;
  ctx.textAlign = 'center';

  const text  = p.name;
  const tw    = ctx.measureText(text).width;

  // Background pill
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  roundRect(ctx, -tw / 2 - 6, -13, tw + 12, 17, 4);
  ctx.fill();

  // Text
  ctx.fillStyle   = isSelf ? '#00e5ff' : p.color;
  ctx.shadowBlur  = isSelf ? 8 : 4;
  ctx.shadowColor = isSelf ? '#00e5ff' : p.color;
  ctx.fillText(text, 0, 0);

  ctx.restore();
}

// ─── Map Hack badge — hiển thị khi sương mù bị tắt ───────────────────────────
function drawMapHackBadge(W) {
  const label = '🗺️  MAP HACK  [NHẤN ] ĐỂ TẮT]';
  ctx.save();
  ctx.font      = 'bold 12px "Segoe UI", Arial, sans-serif';
  ctx.textAlign = 'center';
  const tw      = ctx.measureText(label).width;

  const bx = W / 2 - tw / 2 - 14;
  const by = 10;
  const bw = tw + 28;
  const bh = 26;

  // Background
  ctx.fillStyle = 'rgba(255,234,0,0.15)';
  roundRect(ctx, bx, by, bw, bh, 6);
  ctx.fill();

  // Border
  ctx.strokeStyle = '#ffea00';
  ctx.lineWidth   = 1.2;
  ctx.shadowBlur  = 10;
  ctx.shadowColor = '#ffea00';
  roundRect(ctx, bx, by, bw, bh, 6);
  ctx.stroke();

  // Text
  ctx.fillStyle   = '#ffea00';
  ctx.shadowBlur  = 6;
  ctx.shadowColor = '#ffea00';
  ctx.fillText(label, W / 2, by + 17);
  ctx.restore();
}

// ─────────────────────────────────────────────────────────────────────────────
// FOG OF WAR
// ─────────────────────────────────────────────────────────────────────────────
function applyFogOfWar(W, H) {
  if (!selfPlayer) {
    // Full darkness if not yet initialized
    ctx.fillStyle = 'rgba(0,0,0,0.96)';
    ctx.fillRect(0, 0, W, H);
    return;
  }

  // Screen coords of self
  const selfScreenX = W / 2;
  const selfScreenY = H / 2;

  // Muzzle flash effect: expand vision radius
  const now        = Date.now();
  const flashRatio = Math.max(0, (muzzleFlashUntil - now) / MUZZLE_FLASH_MS);
  const visionRadius = BASE_VISION_RADIUS + MUZZLE_VISION_BONUS * flashRatio;

  // Step 1: draw a solid dark overlay on a separate canvas operation
  // We use compositing:
  //   a) Draw black overlay
  //   b) Cut out (destination-out) vision circles

  // Create off-screen canvas for the fog mask
  const fogCanvas = document.createElement('canvas');
  fogCanvas.width  = W;
  fogCanvas.height = H;
  const fogCtx    = fogCanvas.getContext('2d');

  // Fill entire fog canvas black
  fogCtx.fillStyle = 'rgba(0,0,0,0.97)';
  fogCtx.fillRect(0, 0, W, H);

  // Switch to destination-out so gradients punch holes in the darkness
  fogCtx.globalCompositeOperation = 'destination-out';

  // ── Vision circle around self ──────────────────────────────────────────────
  const selfGrad = fogCtx.createRadialGradient(
    selfScreenX, selfScreenY, visionRadius * 0.4,
    selfScreenX, selfScreenY, visionRadius
  );
  selfGrad.addColorStop(0,   'rgba(0,0,0,1)');
  selfGrad.addColorStop(0.75,'rgba(0,0,0,0.85)');
  selfGrad.addColorStop(1,   'rgba(0,0,0,0)');

  fogCtx.beginPath();
  fogCtx.arc(selfScreenX, selfScreenY, visionRadius, 0, Math.PI * 2);
  fogCtx.fillStyle = selfGrad;
  fogCtx.fill();

  // ── Bullet light halos ────────────────────────────────────────────────────
  for (const b of gameState.bullets) {
    const bsx = W / 2 + (b.x - camX);
    const bsy = H / 2 + (b.y - camY);

    // Only render if bullet is within screen + radius margin
    if (
      bsx < -BULLET_LIGHT_RADIUS || bsx > W + BULLET_LIGHT_RADIUS ||
      bsy < -BULLET_LIGHT_RADIUS || bsy > H + BULLET_LIGHT_RADIUS
    ) continue;

    const bGrad = fogCtx.createRadialGradient(
      bsx, bsy, 0,
      bsx, bsy, BULLET_LIGHT_RADIUS
    );
    bGrad.addColorStop(0,   'rgba(0,0,0,1)');
    bGrad.addColorStop(0.6, 'rgba(0,0,0,0.7)');
    bGrad.addColorStop(1,   'rgba(0,0,0,0)');

    fogCtx.beginPath();
    fogCtx.arc(bsx, bsy, BULLET_LIGHT_RADIUS, 0, Math.PI * 2);
    fogCtx.fillStyle = bGrad;
    fogCtx.fill();
  }

  // Step 2: Draw the fog canvas onto the main canvas
  fogCtx.globalCompositeOperation = 'source-over';
  ctx.drawImage(fogCanvas, 0, 0);

  // Step 3: Muzzle flash colour tint at center when firing
  if (flashRatio > 0) {
    const flashGrad = ctx.createRadialGradient(
      selfScreenX, selfScreenY, 0,
      selfScreenX, selfScreenY, 120
    );
    flashGrad.addColorStop(0,   `rgba(255,220,100,${0.18 * flashRatio})`);
    flashGrad.addColorStop(0.5, `rgba(255,180,50,${0.08 * flashRatio})`);
    flashGrad.addColorStop(1,   'rgba(0,0,0,0)');
    ctx.fillStyle = flashGrad;
    ctx.fillRect(0, 0, W, H);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

// Rounded rectangle path helper
function roundRect(context, x, y, w, h, r) {
  context.beginPath();
  context.moveTo(x + r, y);
  context.lineTo(x + w - r, y);
  context.quadraticCurveTo(x + w, y, x + w, y + r);
  context.lineTo(x + w, y + h - r);
  context.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  context.lineTo(x + r, y + h);
  context.quadraticCurveTo(x, y + h, x, y + h - r);
  context.lineTo(x, y + r);
  context.quadraticCurveTo(x, y, x + r, y);
  context.closePath();
}

// Darken / lighten hex colour by amt (negative = darker)
function shadeColor(hexColor, amt) {
  let usePound = false;
  let color    = hexColor;
  if (color[0] === '#') {
    color    = color.slice(1);
    usePound = true;
  }
  let num = parseInt(color, 16);
  let r   = Math.min(255, Math.max(0, (num >> 16) + amt));
  let g   = Math.min(255, Math.max(0, ((num >> 8) & 0x00ff) + amt));
  let b   = Math.min(255, Math.max(0, (num & 0x0000ff) + amt));
  return (usePound ? '#' : '') + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}
