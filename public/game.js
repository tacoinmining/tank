/* ═══════════════════════════════════════════════════════════════════════════
   BATTLESHIP — Client Game Engine
   Vanilla JS · Socket.io · No frameworks
   Screens: lobby → waiting → placement → battle → gameover
═══════════════════════════════════════════════════════════════════════════ */
'use strict';

// ─── Constants ─────────────────────────────────────────────────────────────────
const SHIP_SIZES  = [5, 4, 3, 3, 2];
const SHIP_NAMES  = { 5: 'Hàng Không Mẫu Hạm', 4: 'Thiết Giáp Hạm', 3: 'Tàu Khu Trục', 2: 'Tàu Ngầm' };
const GRID        = 10;
const ROW_LABELS  = 'ABCDEFGHIJ';

// ─── Game State ────────────────────────────────────────────────────────────────
const G = {
  // Identity
  myId:         null,
  myName:       '',
  opponentName: '',
  pin:          '',
  playerIndex:  0,

  // Placement phase
  shipsToPlace:       [...SHIP_SIZES],  // remaining sizes to place
  placedShips:        [],               // [{size, cells:[{x,y}], horizontal}]
  placedOccupied:     new Set(),        // "x,y" strings already used
  currentShipIdx:     0,                // index into shipsToPlace
  isHorizontal:       true,
  isReady:            false,
  opponentReady:      false,
  hoverX:             -1,
  hoverY:             -1,

  // Battle phase
  myShipCells:     null,  // Set of "x,y" (my ships)
  myGrid:          null,  // 10x10 array: null|'ship'|'hit'|'miss'|'sunk'
  enemyGrid:       null,  // 10x10 array: null|'hit'|'miss'|'sunk'
  myShipsInfo:     [],    // [{size, cells, sunk}] for fleet status
  enemyShipsInfo:  [],    // track sunk state of enemy ships revealed via shots
  currentTurn:     null,  // socket id of current player
  isMyTurn:        false,

  // Hack mode
  hackMode:  false,
  hackShips: null,  // [{cells:[{x,y}], sunk}]
};

// ─── Socket ────────────────────────────────────────────────────────────────────
const socket = io();

// ─── DOM Refs ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const screens = {
  lobby:     $('screen-lobby'),
  waiting:   $('screen-waiting'),
  placement: $('screen-placement'),
  battle:    $('screen-battle'),
  gameover:  $('screen-gameover'),
};

// Lobby
const createNameInput = $('create-name');
const joinNameInput   = $('join-name');
const joinPinInput    = $('join-pin');
const joinErrorDiv    = $('join-error');
const btnCreate       = $('btn-create');
const btnJoin         = $('btn-join');
const displayPin      = $('display-pin');

// Placement
const shipQueueDiv       = $('ship-queue');
const shipPlacedList     = $('ship-placed-list');
const placementStatusDiv = $('placement-status');
const btnRotate          = $('btn-rotate');
const btnAuto            = $('btn-auto');
const btnReset           = $('btn-reset');
const btnReady           = $('btn-ready');
const oppStatusDiv       = $('opponent-ready-status');
const oppStatusText      = $('opp-status-text');
const myReadyStatus      = $('my-ready-status');

// Battle — split screen refs
const turnBanner        = $('turn-banner');
const spineArrow        = $('spine-arrow');
const myFleetStatus     = $('my-fleet-status');
const enemyFleetStatus  = $('enemy-fleet-status');
const battleLog         = $('battle-log');
const hackIndicator     = $('hack-indicator');
const enemyPlayerLabel  = $('enemy-player-label');
const myPlayerLabel     = $('my-player-label');
// panel elements for active-state highlighting
const enemyPanelEl      = $('enemy-panel');
const myPanelEl         = $('my-panel');

// Gameover
const gameoverBanner = $('gameover-banner');
const gameoverReveal = $('gameover-reveal');
const btnRematch     = $('btn-rematch');
const btnHome        = $('btn-home');
const rematchNotice  = $('rematch-notice');

// ─── Screen Management ─────────────────────────────────────────────────────────
function showScreen(name) {
  Object.values(screens).forEach(s => {
    s.classList.remove('active');
    s.classList.add('hidden');
  });
  screens[name].classList.remove('hidden');
  screens[name].classList.add('active');
}

// ─── Web Audio Engine ──────────────────────────────────────────────────────────
let audioCtx = null;

function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function playTone(freq, type, duration, gain, delay) {
  try {
    const ctx  = getAudioCtx();
    const osc  = ctx.createOscillator();
    const vol  = ctx.createGain();
    osc.type   = type || 'sine';
    osc.frequency.setValueAtTime(freq, ctx.currentTime + (delay || 0));
    vol.gain.setValueAtTime(gain || 0.3, ctx.currentTime + (delay || 0));
    vol.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + (delay || 0) + duration);
    osc.connect(vol);
    vol.connect(ctx.destination);
    osc.start(ctx.currentTime + (delay || 0));
    osc.stop(ctx.currentTime + (delay || 0) + duration);
  } catch (e) { /* audio not supported */ }
}

function playNoise(duration, freq, gain) {
  try {
    const ctx    = getAudioCtx();
    const buf    = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
    const data   = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src    = ctx.createBufferSource();
    src.buffer   = buf;
    const filter = ctx.createBiquadFilter();
    filter.type  = 'bandpass';
    filter.frequency.value = freq || 400;
    filter.Q.value = 0.5;
    const vol    = ctx.createGain();
    vol.gain.setValueAtTime(gain || 0.4, ctx.currentTime);
    vol.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    src.connect(filter);
    filter.connect(vol);
    vol.connect(ctx.destination);
    src.start();
  } catch (e) { /* audio not supported */ }
}

function sfxHit()  { playNoise(0.3, 300, 0.6); playTone(80, 'sawtooth', 0.4, 0.3, 0.05); }
function sfxMiss() { playNoise(0.25, 1200, 0.2); playTone(400, 'sine', 0.3, 0.1, 0); }
function sfxSunk() { playNoise(0.6, 200, 0.8); playTone(60, 'sawtooth', 0.8, 0.4, 0.1); }
function sfxPlace(){ playTone(600, 'sine', 0.08, 0.2, 0); }
function sfxWin()  {
  [523, 659, 784, 1047].forEach((f, i) => playTone(f, 'sine', 0.3, 0.35, i * 0.12));
}
function sfxLose() {
  [392, 349, 294, 220].forEach((f, i) => playTone(f, 'sine', 0.3, 0.2, i * 0.18));
}

// ─── Grid Builder ──────────────────────────────────────────────────────────────
// Builds an 11×11 CSS grid (1 col+row for labels, 10×10 cells)
function buildGrid(containerId, opts) {
  const container = $(containerId);
  container.innerHTML = '';

  // Corner
  const corner = document.createElement('div');
  corner.className = 'grid-corner';
  container.appendChild(corner);

  // Column labels (1–10)
  for (let x = 0; x < GRID; x++) {
    const lbl = document.createElement('div');
    lbl.className = 'grid-col-label';
    lbl.textContent = x + 1;
    container.appendChild(lbl);
  }

  // Rows
  for (let y = 0; y < GRID; y++) {
    // Row label (A–J)
    const rowLbl = document.createElement('div');
    rowLbl.className = 'grid-row-label';
    rowLbl.textContent = ROW_LABELS[y];
    container.appendChild(rowLbl);

    // Cells
    for (let x = 0; x < GRID; x++) {
      const cell = document.createElement('div');
      cell.className = 'grid-cell';
      cell.id        = `${containerId}-${x}-${y}`;
      cell.dataset.x = x;
      cell.dataset.y = y;

      if (opts && opts.onCellClick) {
        cell.addEventListener('click', () => opts.onCellClick(x, y, cell));
      }
      if (opts && opts.onCellHover) {
        cell.addEventListener('mouseenter', () => opts.onCellHover(x, y));
      }

      container.appendChild(cell);
    }
  }
}

function getCell(gridId, x, y) {
  return $(`${gridId}-${x}-${y}`);
}

function addCellClass(gridId, x, y, cls) {
  const c = getCell(gridId, x, y);
  if (c) c.classList.add(cls);
}

function removeCellClass(gridId, x, y, cls) {
  const c = getCell(gridId, x, y);
  if (c) c.classList.remove(cls);
}

// ═══════════════════════════════════════════════════════════
// LOBBY PHASE
// ═══════════════════════════════════════════════════════════
btnCreate.addEventListener('click', () => {
  const name = createNameInput.value.trim() || 'Thuyền Trưởng';
  socket.emit('createRoom', { name });
  btnCreate.disabled = true;
  btnCreate.textContent = 'Đang tạo...';
});

btnJoin.addEventListener('click', doJoin);
joinPinInput.addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });

function doJoin() {
  const name = joinNameInput.value.trim() || 'Thuyền Phó';
  const pin  = joinPinInput.value.trim();
  if (pin.length !== 4 || !/^\d{4}$/.test(pin)) {
    showJoinError('Mã PIN phải là 4 chữ số.');
    return;
  }
  joinErrorDiv.classList.add('hidden');
  socket.emit('joinRoom', { pin, name });
  btnJoin.disabled = true;
  btnJoin.textContent = 'Đang kết nối...';
}

function showJoinError(msg) {
  joinErrorDiv.textContent = msg;
  joinErrorDiv.classList.remove('hidden');
  btnJoin.disabled = false;
  btnJoin.textContent = 'Tham Gia';
}

// ═══════════════════════════════════════════════════════════
// PLACEMENT PHASE
// ═══════════════════════════════════════════════════════════
function initPlacement(shipSizes) {
  G.shipsToPlace      = [...shipSizes];
  G.placedShips       = [];
  G.placedOccupied    = new Set();
  G.currentShipIdx    = 0;
  G.isHorizontal      = true;
  G.isReady           = false;
  G.opponentReady     = false;
  G.hoverX            = -1;
  G.hoverY            = -1;

  btnReady.disabled  = true;
  btnRotate.disabled = false;
  btnAuto.disabled   = false;
  btnReset.disabled  = false;

  updateShipQueueUI();
  renderPlacedList();
  buildPlacementGrid();
  updatePlacementStatus();
}

function buildPlacementGrid() {
  buildGrid('grid-placement', {
    onCellClick: (x, y) => placeCurrentShip(x, y),
    onCellHover: (x, y) => { G.hoverX = x; G.hoverY = y; renderPlacementGhost(); }
  });

  const container = $('grid-placement');
  container.addEventListener('mouseleave', () => {
    G.hoverX = -1; G.hoverY = -1;
    clearGhostClasses();
  });

  // Render already placed ships (for rematch / reset)
  renderAllPlacedShips();
}

function updateShipQueueUI() {
  shipQueueDiv.innerHTML = '';
  G.shipsToPlace.forEach((size, i) => {
    const div = document.createElement('div');
    div.className = 'ship-item' + (i === 0 ? ' current' : '');

    const preview = document.createElement('div');
    preview.className = 'ship-seg-preview';
    for (let s = 0; s < size; s++) {
      const seg = document.createElement('span');
      preview.appendChild(seg);
    }

    const name = document.createElement('span');
    name.textContent = SHIP_NAMES[size] || ('Tàu ' + size);
    name.style.fontSize = '0.75rem';

    div.appendChild(preview);
    div.appendChild(name);
    shipQueueDiv.appendChild(div);
  });
}

function renderPlacedList() {
  shipPlacedList.innerHTML = '';
  G.placedShips.forEach(ship => {
    const div = document.createElement('div');
    div.className = 'placed-entry';
    div.textContent = '✓ ' + (SHIP_NAMES[ship.size] || ('Tàu ' + ship.size));
    shipPlacedList.appendChild(div);
  });
}

function updatePlacementStatus() {
  if (G.currentShipIdx < G.shipsToPlace.length) {
    const size = G.shipsToPlace[G.currentShipIdx];
    placementStatusDiv.textContent = `Đang xếp: ${SHIP_NAMES[size] || 'Tàu ' + size} (${size} ô)`;
  } else {
    placementStatusDiv.textContent = 'Tất cả tàu đã xếp — Nhấn Sẵn Sàng!';
  }
}

// Compute ghost cells for current ship at (hx, hy)
function getGhostCells(hx, hy) {
  if (G.currentShipIdx >= G.shipsToPlace.length) return { cells: [], valid: false };

  const size = G.shipsToPlace[G.currentShipIdx];
  const cells = [];

  for (let i = 0; i < size; i++) {
    const cx = G.isHorizontal ? hx + i : hx;
    const cy = G.isHorizontal ? hy      : hy + i;
    cells.push({ x: cx, y: cy });
  }

  const valid = cells.every(c =>
    c.x >= 0 && c.x < GRID &&
    c.y >= 0 && c.y < GRID &&
    !G.placedOccupied.has(`${c.x},${c.y}`)
  );

  return { cells, valid };
}

function clearGhostClasses() {
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const c = getCell('grid-placement', x, y);
      if (c) { c.classList.remove('ghost', 'ghost-invalid'); }
    }
  }
}

function renderPlacementGhost() {
  clearGhostClasses();
  if (G.hoverX < 0 || G.hoverY < 0) return;
  if (G.currentShipIdx >= G.shipsToPlace.length) return;

  const { cells, valid } = getGhostCells(G.hoverX, G.hoverY);
  const cls = valid ? 'ghost' : 'ghost-invalid';
  cells.forEach(c => {
    const el = getCell('grid-placement', c.x, c.y);
    if (el) el.classList.add(cls);
  });
}

function renderAllPlacedShips() {
  // Clear all ship classes first
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const c = getCell('grid-placement', x, y);
      if (c) c.classList.remove('ship');
    }
  }
  // Re-apply
  G.placedShips.forEach(ship => {
    ship.cells.forEach(c => addCellClass('grid-placement', c.x, c.y, 'ship'));
  });
}

function placeCurrentShip(hx, hy) {
  if (G.isReady) return;
  if (G.currentShipIdx >= G.shipsToPlace.length) return;

  const { cells, valid } = getGhostCells(hx, hy);
  if (!valid) return;

  const size = G.shipsToPlace[G.currentShipIdx];
  G.placedShips.push({ size, cells: [...cells], horizontal: G.isHorizontal });
  cells.forEach(c => {
    G.placedOccupied.add(`${c.x},${c.y}`);
    addCellClass('grid-placement', c.x, c.y, 'ship');
  });

  G.currentShipIdx++;
  sfxPlace();
  updateShipQueueUI();
  renderPlacedList();
  updatePlacementStatus();
  clearGhostClasses();

  if (G.currentShipIdx >= G.shipsToPlace.length) {
    btnReady.disabled = false;
  }
}

// Auto-place all ships randomly
function doAutoPlace() {
  if (G.isReady) return;

  const sizes = [...SHIP_SIZES];
  const occupied = new Set();
  const placed   = [];
  let success    = false;

  for (let attempt = 0; attempt < 200 && !success; attempt++) {
    occupied.clear();
    placed.length = 0;
    let ok = true;

    for (const size of sizes) {
      let found = false;
      for (let t = 0; t < 100; t++) {
        const horiz = Math.random() < 0.5;
        const maxX  = horiz ? GRID - size : GRID - 1;
        const maxY  = horiz ? GRID - 1    : GRID - size;
        const sx    = Math.floor(Math.random() * (maxX + 1));
        const sy    = Math.floor(Math.random() * (maxY + 1));

        const cells = [];
        let overlap = false;

        for (let i = 0; i < size; i++) {
          const cx = horiz ? sx + i : sx;
          const cy = horiz ? sy      : sy + i;
          const key = `${cx},${cy}`;
          if (occupied.has(key)) { overlap = true; break; }
          cells.push({ x: cx, y: cy });
        }

        if (!overlap) {
          cells.forEach(c => occupied.add(`${c.x},${c.y}`));
          placed.push({ size, cells, horizontal: horiz });
          found = true;
          break;
        }
      }

      if (!found) { ok = false; break; }
    }

    if (ok) success = true;
  }

  if (!success) { alert('Không thể xếp ngẫu nhiên. Thử lại!'); return; }

  G.placedShips       = placed;
  G.placedOccupied    = occupied;
  G.currentShipIdx    = sizes.length;
  G.shipsToPlace      = [...sizes];

  renderAllPlacedShips();
  updateShipQueueUI();
  renderPlacedList();
  updatePlacementStatus();
  btnReady.disabled = false;
  sfxPlace();
}

function doReset() {
  if (G.isReady) return;
  G.placedShips    = [];
  G.placedOccupied = new Set();
  G.currentShipIdx = 0;
  G.shipsToPlace   = [...SHIP_SIZES];
  btnReady.disabled = true;
  updateShipQueueUI();
  renderPlacedList();
  renderAllPlacedShips();
  updatePlacementStatus();
}

btnRotate.addEventListener('click', () => {
  G.isHorizontal = !G.isHorizontal;
  btnRotate.textContent = G.isHorizontal ? '↕ Đổi Chiều (Ngang)' : '↕ Đổi Chiều (Dọc)';
  renderPlacementGhost();
});

btnAuto.addEventListener('click', doAutoPlace);
btnReset.addEventListener('click', doReset);

btnReady.addEventListener('click', () => {
  if (G.isReady) return;
  if (G.currentShipIdx < SHIP_SIZES.length) return;

  const shipsPayload = G.placedShips.map(ship => ({ cells: ship.cells }));
  socket.emit('submitShips', { ships: shipsPayload });
  G.isReady = true;
  btnReady.disabled    = true;
  btnRotate.disabled   = true;
  btnAuto.disabled     = true;
  btnReset.disabled    = true;
  btnReady.textContent = '⏳ Chờ đối thủ...';

  myReadyStatus.classList.replace('waiting', 'ready');
  myReadyStatus.querySelector('span:last-child').textContent = 'Tôi đã sẵn sàng ✓';
});

// ═══════════════════════════════════════════════════════════
// BATTLE PHASE
// ═══════════════════════════════════════════════════════════
function initBattle(firstTurnId) {
  G.currentTurn = firstTurnId;
  G.isMyTurn    = (firstTurnId === G.myId);

  // Set player name labels on split panels
  if (myPlayerLabel)    myPlayerLabel.textContent    = G.myName       || 'BẠN';
  if (enemyPlayerLabel) enemyPlayerLabel.textContent = G.opponentName || 'ĐỐI THỦ';

  // Reset hack state
  G.hackMode  = false;
  G.hackShips = null;
  if (hackIndicator) hackIndicator.classList.add('hidden');

  // Build 2D grid state arrays
  G.myGrid    = Array.from({ length: GRID }, () => Array(GRID).fill(null));
  G.enemyGrid = Array.from({ length: GRID }, () => Array(GRID).fill(null));

  // Mark my ship cells
  G.myShipCells = new Set();
  G.placedShips.forEach(ship => {
    ship.cells.forEach(c => {
      G.myShipCells.add(`${c.x},${c.y}`);
      G.myGrid[c.y][c.x] = 'ship';
    });
  });

  // Store my ships info for fleet status
  G.myShipsInfo    = G.placedShips.map(s => ({ size: s.size, cells: [...s.cells], sunk: false }));
  G.enemyShipsInfo = [];

  // Build grids
  buildGrid('grid-my', null);
  buildGrid('grid-enemy', {
    onCellClick: (x, y) => onEnemyClick(x, y)
  });

  // Render my ships on my grid
  G.placedShips.forEach(ship => {
    ship.cells.forEach(c => addCellClass('grid-my', c.x, c.y, 'ship'));
  });

  updateEnemyGridClickable();
  updateTurnBanner();
  renderFleetStatus();
}

function updateTurnBanner() {
  if (G.isMyTurn) {
    // My turn: I shoot LEFT at enemy panel
    if (turnBanner) {
      turnBanner.textContent = '🎯 LƯỢT BẠN';
      turnBanner.className   = 'turn-banner my-turn';
    }
    if (spineArrow) {
      spineArrow.textContent = '◀';
      spineArrow.className   = 'spine-arrow attacking';
    }
    if (enemyPanelEl) enemyPanelEl.classList.add('panel-active');
    if (myPanelEl)    myPanelEl.classList.remove('panel-active');
  } else {
    // Enemy turn: they shoot RIGHT at my panel
    if (turnBanner) {
      turnBanner.textContent = `⏳ ${(G.opponentName || 'ĐỐI THỦ').slice(0, 8).toUpperCase()}`;
      turnBanner.className   = 'turn-banner enemy-turn';
    }
    if (spineArrow) {
      spineArrow.textContent = '▶';
      spineArrow.className   = 'spine-arrow defending';
    }
    if (myPanelEl)    myPanelEl.classList.add('panel-active');
    if (enemyPanelEl) enemyPanelEl.classList.remove('panel-active');
  }
}

function updateEnemyGridClickable() {
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const cell = getCell('grid-enemy', x, y);
      if (!cell) continue;
      if (G.isMyTurn && G.enemyGrid[y][x] === null) {
        cell.classList.add('clickable');
      } else {
        cell.classList.remove('clickable');
      }
    }
  }
}

function onEnemyClick(x, y) {
  if (!G.isMyTurn) return;
  if (G.enemyGrid[y][x] !== null) return; // already shot
  socket.emit('shoot', { x, y });
  G.isMyTurn = false; // optimistic — server confirms
  updateEnemyGridClickable();
}

// Handle shotResult from server
function handleShotResult(data) {
  const { shooterId, x, y, hit, sunkCells, won } = data;
  const iWasShooter = (shooterId === G.myId);

  if (iWasShooter) {
    // I shot at enemy
    G.enemyGrid[y][x] = hit ? 'hit' : 'miss';
    if (hit) {
      addCellClass('grid-enemy', x, y, 'hit');
    } else {
      addCellClass('grid-enemy', x, y, 'miss');
    }

    if (sunkCells) {
      // Mark sunk ship on enemy grid
      sunkCells.forEach(c => {
        G.enemyGrid[c.y][c.x] = 'sunk';
        const cell = getCell('grid-enemy', c.x, c.y);
        if (cell) {
          cell.classList.remove('hit');
          cell.classList.add('sunk');
        }
      });
      G.enemyShipsInfo.push({ size: sunkCells.length, sunk: true });
      renderFleetStatus();
      battleLog.textContent = `💥 TÀU ĐỊCH BỊ ĐÁNH CHÌM! (${sunkCells.length} ô)`;
      sfxSunk();
      clearHackOverlay();
    } else if (hit) {
      battleLog.textContent = '🎯 Trúng! Bắn tiếp!';
      sfxHit();
    } else {
      battleLog.textContent = '🌊 Trượt. Đối thủ ra tay...';
      sfxMiss();
    }
  } else {
    // Enemy shot at me
    G.myGrid[y][x] = hit ? 'hit' : 'miss';
    if (hit) {
      addCellClass('grid-my', x, y, 'hit');
    } else {
      addCellClass('grid-my', x, y, 'miss');
    }

    if (sunkCells) {
      sunkCells.forEach(c => {
        G.myGrid[c.y][c.x] = 'sunk';
        const cell = getCell('grid-my', c.x, c.y);
        if (cell) {
          cell.classList.remove('hit', 'ship');
          cell.classList.add('sunk');
        }
      });
      // Mark ship as sunk in my fleet status
      const shipSize = sunkCells.length;
      const target = G.myShipsInfo.find(s => !s.sunk && s.size === shipSize &&
        sunkCells.every(sc => s.cells.some(mc => mc.x === sc.x && mc.y === sc.y)));
      if (target) target.sunk = true;
      renderFleetStatus();
      battleLog.textContent = `💀 Tàu của bạn bị đánh chìm! (${sunkCells.length} ô)`;
      sfxSunk();
    } else if (hit) {
      battleLog.textContent = '⚠ Tàu bạn bị trúng đạn!';
      sfxHit();
    } else {
      battleLog.textContent = '😅 Đối thủ bắn trượt.';
      sfxMiss();
    }
  }
}

function renderFleetStatus() {
  // My fleet
  myFleetStatus.innerHTML = '';
  G.myShipsInfo.forEach(s => {
    const tag = document.createElement('span');
    tag.className = 'fleet-ship-tag ' + (s.sunk ? 'sunk-tag' : 'alive-tag');
    tag.textContent = (SHIP_NAMES[s.size] || ('Tàu ' + s.size)) + ' (' + s.size + ')';
    myFleetStatus.appendChild(tag);
  });

  // Enemy fleet (only sunk ones are known)
  enemyFleetStatus.innerHTML = '';
  G.enemyShipsInfo.forEach(s => {
    const tag = document.createElement('span');
    tag.className = 'fleet-ship-tag sunk-tag';
    tag.textContent = '💥 ' + (SHIP_NAMES[s.size] || ('Tàu ' + s.size));
    enemyFleetStatus.appendChild(tag);
  });

  const enemySunk = G.enemyShipsInfo.length;
  const totalShips = SHIP_SIZES.length;
  if (enemySunk < totalShips) {
    const info = document.createElement('span');
    info.className = 'fleet-ship-tag';
    info.style.opacity = '0.5';
    info.textContent = `${totalShips - enemySunk} tàu còn ẩn`;
    enemyFleetStatus.appendChild(info);
  }
}

// ─── Hack Mode ──────────────────────────────────────────────────────────────────
function toggleHackMode() {
  G.hackMode = !G.hackMode;

  if (G.hackMode) {
    hackIndicator.classList.remove('hidden');
    // Request enemy positions from server if not yet received
    socket.emit('requestHack');
  } else {
    hackIndicator.classList.add('hidden');
    clearHackOverlay();
  }
}

function applyHackOverlay() {
  if (!G.hackShips || !G.hackMode) return;
  G.hackShips.forEach(ship => {
    ship.cells.forEach(c => {
      const cell = getCell('grid-enemy', c.x, c.y);
      if (!cell) return;
      // Only overlay cells not already shot
      if (G.enemyGrid[c.y][c.x] === null) {
        cell.classList.add(ship.sunk ? 'hack-sunk' : 'hack-ship');
      }
    });
  });
}

function clearHackOverlay() {
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const cell = getCell('grid-enemy', x, y);
      if (cell) cell.classList.remove('hack-ship', 'hack-sunk');
    }
  }
}

// ─── Gameover ──────────────────────────────────────────────────────────────────
function showGameover(won, winnerName) {
  // Disable enemy grid
  G.isMyTurn = false;
  updateEnemyGridClickable();

  if (won) {
    gameoverBanner.textContent  = '🏆 CHIẾN THẮNG!';
    gameoverBanner.className    = 'gameover-banner win';
    sfxWin();
  } else {
    gameoverBanner.textContent  = '💀 THẤT BẠI';
    gameoverBanner.className    = 'gameover-banner lose';
    sfxLose();
  }

  gameoverReveal.textContent = won
    ? `${winnerName} đã đánh chìm toàn bộ hạm đội đối thủ!`
    : `${winnerName} đã đánh chìm toàn bộ hạm đội của bạn.`;

  rematchNotice.classList.add('hidden');
  showScreen('gameover');
}

function revealEnemyFleet(ships) {
  // Reveal enemy ships on enemy grid after game ends
  ships.forEach(ship => {
    ship.cells.forEach(c => {
      if (G.enemyGrid && G.enemyGrid[c.y][c.x] === null) {
        const cell = getCell('grid-enemy', c.x, c.y);
        if (cell) cell.classList.add('hack-ship');
      }
    });
  });
}

// Gameover buttons
btnRematch.addEventListener('click', () => {
  socket.emit('playAgain');
  btnRematch.disabled    = true;
  btnRematch.textContent = '⏳ Đang chờ...';
  rematchNotice.textContent  = 'Đang chờ đối thủ đồng ý đánh lại...';
  rematchNotice.classList.remove('hidden');
});

btnHome.addEventListener('click', () => {
  // Reset all state and go back to lobby
  G.myId = null;
  socket.emit('disconnect');
  location.reload();
});

// ─── Keyboard ──────────────────────────────────────────────────────────────────
window.addEventListener('keydown', (e) => {
  if (e.key === ']' || e.code === 'BracketRight') {
    e.preventDefault();
    const battleScreen = $('screen-battle');
    if (!battleScreen.classList.contains('hidden')) {
      toggleHackMode();
    }
  }
});

// ═══════════════════════════════════════════════════════════
// SOCKET EVENT HANDLERS
// ═══════════════════════════════════════════════════════════

socket.on('roomCreated', ({ pin, playerIndex, myName }) => {
  G.pin         = pin;
  G.playerIndex = playerIndex;
  G.myId        = socket.id;
  G.myName      = myName;
  displayPin.textContent = pin;
  showScreen('waiting');
});

socket.on('roomJoined', ({ pin, playerIndex, myName, opponentName }) => {
  G.pin          = pin;
  G.playerIndex  = playerIndex;
  G.myId         = socket.id;
  G.myName       = myName;
  G.opponentName = opponentName;
});

socket.on('joinError', ({ message }) => {
  showJoinError(message);
});

socket.on('opponentJoined', ({ opponentName }) => {
  G.opponentName = opponentName;
});

socket.on('startPlacement', ({ shipSizes, names }) => {
  // Identify opponent name from names map
  if (names) {
    for (const [id, name] of Object.entries(names)) {
      if (id !== socket.id) G.opponentName = name;
      else G.myName = name;
    }
  }
  showScreen('placement');
  initPlacement(shipSizes);
});

socket.on('shipsAccepted', () => {
  // Server confirmed our ship placement
});

socket.on('shipError', ({ message }) => {
  alert(message);
  doReset();
  G.isReady = false;
  btnReady.disabled    = false;
  btnReady.textContent = '✅ Sẵn Sàng!';
  btnRotate.disabled   = false;
  btnAuto.disabled     = false;
  btnReset.disabled    = false;
  myReadyStatus.classList.replace('ready', 'waiting');
  myReadyStatus.querySelector('span:last-child').textContent = 'Tôi chưa sẵn sàng';
});

socket.on('opponentReady', () => {
  G.opponentReady = true;
  oppStatusDiv.classList.replace('waiting', 'ready');
  oppStatusText.textContent = `${G.opponentName} đã sẵn sàng ✓`;
});

socket.on('startBattle', ({ firstTurn, names }) => {
  if (names) {
    for (const [id, name] of Object.entries(names)) {
      if (id !== socket.id) G.opponentName = name;
    }
  }
  G.hackMode  = false;
  G.hackShips = null;
  showScreen('battle');
  initBattle(firstTurn);
});

socket.on('shotResult', (data) => {
  handleShotResult(data);
});

socket.on('turnUpdate', ({ currentTurn }) => {
  G.currentTurn = currentTurn;
  G.isMyTurn    = (currentTurn === G.myId);
  updateTurnBanner();
  updateEnemyGridClickable();

  // Re-apply hack overlay after turn update
  if (G.hackMode && G.hackShips) applyHackOverlay();
});

socket.on('gameOver', ({ winnerId, winnerName }) => {
  const iWon = (winnerId === G.myId);
  showGameover(iWon, winnerName);
});

socket.on('revealEnemyFleet', ({ ships }) => {
  revealEnemyFleet(ships);
});

socket.on('hackData', ({ ships }) => {
  G.hackShips = ships;
  if (G.hackMode) {
    clearHackOverlay();
    applyHackOverlay();
  }
});

socket.on('opponentDisconnected', ({ name }) => {
  alert(`${name} đã ngắt kết nối. Phòng đã bị đóng.`);
  location.reload();
});

socket.on('opponentWantsRematch', ({ name }) => {
  rematchNotice.textContent  = `${name} muốn đánh lại!`;
  rematchNotice.classList.remove('hidden');
});

// ─── Init ────────────────────────────────────────────────────────────────────────
showScreen('lobby');
