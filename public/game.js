/* ═══════════════════════════════════════════════════════════════════════════
   BATTLESHIP — Client Game Engine
   Vanilla JS · Socket.io · No frameworks
   Screens: lobby → waiting → placement → battle → gameover
═══════════════════════════════════════════════════════════════════════════ */
'use strict';

// ─── Constants ─────────────────────────────────────────────────────────────────
const SHIP_SIZES  = [5, 4, 3, 3, 2];
const SHIP_NAMES  = { 5: 'Hàng Không Mẫu Hạm', 4: 'Thiết Giáp Hạm', 3: 'Tàu Khu Trục', 2: 'Tàu Ngầm' };
const DEFAULT_FLEET = [
  { id: 'carrier',    name: 'Hàng Không Mẫu Hạm', size: 5, horizontal: true, cells: null },
  { id: 'battleship', name: 'Thiết Giáp Hạm',       size: 4, horizontal: true, cells: null },
  { id: 'cruiser',    name: 'Tàu Tuần Dương',       size: 3, horizontal: true, cells: null },
  { id: 'destroyer',  name: 'Tàu Khu Trục',         size: 3, horizontal: true, cells: null },
  { id: 'submarine',  name: 'Tàu Ngầm',             size: 2, horizontal: true, cells: null }
];
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
  fleet:              [],               // [{ id, name, size, horizontal, cells: [{x,y}] | null }]
  placedShips:        [],               // [{size, cells:[{x,y}], horizontal}] for battle phase
  placedOccupied:     new Set(),        // "x,y" strings already used
  isReady:            false,
  opponentReady:      false,
  hoverX:             -1,
  hoverY:             -1,
  draggedShipId:      null,
  dragOriginCells:    null,
  selectedShipId:     null,

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
const fleetCardEl        = $('fleet-card');
const fleetDockEl        = $('fleet-dock');
const fleetCountBadge    = $('fleet-count-badge');
const placementStatusDiv = $('placement-status');
const btnAuto            = $('btn-auto');
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

// ─── Procedural Ship Sprite Generator (SVG) ────────────────────────────────────
function sortShipCells(cells) {
  if (!cells || cells.length <= 1) return { sorted: cells || [], isHorizontal: true };
  const allSameY = cells.every(c => c.y === cells[0].y);
  if (allSameY) {
    return {
      sorted: [...cells].sort((a, b) => a.x - b.x),
      isHorizontal: true
    };
  } else {
    return {
      sorted: [...cells].sort((a, b) => a.y - b.y),
      isHorizontal: false
    };
  }
}

function setCellShipSprite(gridId, x, y, svgHtml, extraClass) {
  const cell = getCell(gridId, x, y);
  if (!cell) return;
  const oldSprite = cell.querySelector('.ship-sprite');
  if (oldSprite) oldSprite.remove();
  if (extraClass) cell.classList.add(extraClass);
  if (gridId === 'grid-placement' && extraClass === 'ship') {
    cell.title = 'Nhấp chuột trái để xoay tàu';
  }
  if (svgHtml) {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = svgHtml.trim();
    const svgEl = wrapper.firstChild;
    if (svgEl) cell.appendChild(svgEl);
  }
}

function clearCellShipSprite(gridId, x, y, removeClasses) {
  const cell = getCell(gridId, x, y);
  if (!cell) return;
  const oldSprite = cell.querySelector('.ship-sprite');
  if (oldSprite) oldSprite.remove();
  if (removeClasses) {
    removeClasses.forEach(cls => cell.classList.remove(cls));
    if (removeClasses.includes('ship')) {
      cell.removeAttribute('title');
    }
  }
}

function getShipSegmentSvg(shipSize, partIndex, isHorizontal, isSunk, isGhost, isInvalidGhost, isHack) {
  const rot = isHorizontal ? 270 : 0;

  // Determine part category based on shipSize and partIndex (0 to shipSize - 1)
  let part = 'body';
  if (partIndex === 0) {
    part = (shipSize === 5) ? 'carrier-bow' : (shipSize === 2) ? 'sub-bow' : 'bow';
  } else if (partIndex === shipSize - 1) {
    part = (shipSize === 5) ? 'carrier-stern' : (shipSize === 2) ? 'sub-stern' : 'stern';
  } else {
    if (shipSize === 5) {
      if (partIndex === 1) part = 'carrier-launch';
      else if (partIndex === 2) part = 'carrier-bridge';
      else part = 'carrier-deck';
    } else if (shipSize === 4) {
      part = (partIndex === 1) ? 'bridge' : 'body';
    } else if (shipSize === 3) {
      part = 'bridge';
    }
  }

  // Colors based on state
  let hullFill   = '#1e293b';
  let hullStroke = '#38bdf8';
  let deckFill   = '#0f172a';
  let detailCol  = '#38bdf8';
  let accentCol  = '#00e676';
  let turretCol  = '#64748b';

  if (isSunk) {
    hullFill   = '#18181b';
    hullStroke = '#ea580c';
    deckFill   = '#09090b';
    detailCol  = '#ef4444';
    accentCol  = '#ff6d00';
    turretCol  = '#3f3f46';
  } else if (isHack) {
    hullFill   = 'rgba(255,215,0,0.18)';
    hullStroke = '#ffd700';
    deckFill   = 'rgba(255,215,0,0.08)';
    detailCol  = '#ffd700';
    accentCol  = '#ffd700';
    turretCol  = '#ca8a04';
  } else if (isGhost) {
    if (isInvalidGhost) {
      hullFill   = 'rgba(255,23,68,0.22)';
      hullStroke = '#ff1744';
      deckFill   = 'rgba(255,23,68,0.12)';
      detailCol  = '#ff4569';
      accentCol  = '#ff1744';
      turretCol  = '#e11d48';
    } else {
      hullFill   = 'rgba(41,121,255,0.22)';
      hullStroke = '#40c4ff';
      deckFill   = 'rgba(41,121,255,0.12)';
      detailCol  = '#40c4ff';
      accentCol  = '#00e676';
      turretCol  = '#0284c7';
    }
  }

  let innerSvg = '';

  switch (part) {
    case 'bow':
      innerSvg = `
        <path d="M18,100 Q18,60 50,6 Q82,60 82,100 Z" fill="${hullFill}" stroke="${hullStroke}" stroke-width="2.5"/>
        <path d="M26,96 Q26,62 50,22 Q74,62 74,96 Z" fill="${deckFill}" stroke="${hullStroke}" stroke-width="1" opacity="0.6"/>
        <line x1="50" y1="16" x2="50" y2="34" stroke="${detailCol}" stroke-width="2" stroke-linecap="round"/>
        <line x1="46" y1="64" x2="46" y2="32" stroke="${turretCol}" stroke-width="3.2" stroke-linecap="round"/>
        <line x1="54" y1="64" x2="54" y2="32" stroke="${turretCol}" stroke-width="3.2" stroke-linecap="round"/>
        <circle cx="50" cy="64" r="13" fill="${turretCol}" stroke="${hullStroke}" stroke-width="1.5"/>
        <circle cx="50" cy="64" r="5" fill="${accentCol}"/>
      `;
      break;

    case 'carrier-bow':
      innerSvg = `
        <path d="M14,100 L24,10 L76,10 L86,100 Z" fill="${hullFill}" stroke="${hullStroke}" stroke-width="2.5"/>
        <path d="M20,96 L28,16 L72,16 L80,96 Z" fill="${deckFill}" stroke="${hullStroke}" stroke-width="1" opacity="0.7"/>
        <line x1="38" y1="96" x2="38" y2="24" stroke="${detailCol}" stroke-width="2" stroke-dasharray="4,4"/>
        <polyline points="34,36 38,24 42,36" fill="none" stroke="${accentCol}" stroke-width="2.5" stroke-linecap="round"/>
        <line x1="62" y1="96" x2="62" y2="40" stroke="#ffd700" stroke-width="1.5" stroke-dasharray="6,4" opacity="0.8"/>
      `;
      break;

    case 'sub-bow':
      innerSvg = `
        <path d="M22,100 L22,46 A28,28 0 0,1 78,46 L78,100 Z" fill="${hullFill}" stroke="${hullStroke}" stroke-width="2.5"/>
        <path d="M28,96 L28,48 A22,22 0 0,1 72,48 L72,96 Z" fill="${deckFill}" stroke="${hullStroke}" stroke-width="1" opacity="0.6"/>
        <circle cx="38" cy="38" r="4.5" fill="#0f172a" stroke="${detailCol}" stroke-width="1.5"/>
        <circle cx="62" cy="38" r="4.5" fill="#0f172a" stroke="${detailCol}" stroke-width="1.5"/>
        <path d="M34,58 Q50,68 66,58" fill="none" stroke="${accentCol}" stroke-width="2"/>
      `;
      break;

    case 'bridge':
      innerSvg = `
        <rect x="18" y="0" width="64" height="100" fill="${hullFill}" stroke="${hullStroke}" stroke-width="2.5"/>
        <rect x="25" y="2" width="50" height="96" fill="${deckFill}" opacity="0.5"/>
        <rect x="31" y="22" width="38" height="56" rx="6" fill="${turretCol}" stroke="${hullStroke}" stroke-width="1.5"/>
        <rect x="36" y="30" width="28" height="7" rx="2" fill="${accentCol}"/>
        <line x1="50" y1="52" x2="50" y2="68" stroke="${detailCol}" stroke-width="2"/>
        <circle cx="50" cy="52" r="7" fill="none" stroke="${detailCol}" stroke-width="2"/>
        <line x1="43" y1="45" x2="57" y2="59" stroke="${detailCol}" stroke-width="1.5"/>
      `;
      break;

    case 'carrier-launch':
      innerSvg = `
        <rect x="14" y="0" width="72" height="100" fill="${hullFill}" stroke="${hullStroke}" stroke-width="2.5"/>
        <rect x="19" y="0" width="62" height="100" fill="${deckFill}" opacity="0.6"/>
        <line x1="38" y1="0" x2="38" y2="100" stroke="${detailCol}" stroke-width="2" stroke-dasharray="5,4"/>
        <line x1="62" y1="0" x2="62" y2="100" stroke="#ffd700" stroke-width="1.5" stroke-dasharray="8,4" opacity="0.8"/>
        <path d="M68,52 L78,64 L72,66 L70,72 L68,70 L66,72 L64,66 L58,64 Z" fill="${turretCol}" stroke="${accentCol}" stroke-width="0.8"/>
      `;
      break;

    case 'carrier-bridge':
      innerSvg = `
        <rect x="14" y="0" width="72" height="100" fill="${hullFill}" stroke="${hullStroke}" stroke-width="2.5"/>
        <rect x="19" y="0" width="62" height="100" fill="${deckFill}" opacity="0.6"/>
        <line x1="38" y1="0" x2="38" y2="100" stroke="${detailCol}" stroke-width="2" stroke-dasharray="5,4"/>
        <line x1="60" y1="0" x2="60" y2="100" stroke="#ffd700" stroke-width="1.5" stroke-dasharray="8,4" opacity="0.8"/>
        <rect x="67" y="16" width="18" height="68" rx="4" fill="${turretCol}" stroke="${hullStroke}" stroke-width="1.5"/>
        <rect x="69" y="24" width="14" height="6" rx="1.5" fill="${accentCol}"/>
        <line x1="76" y1="42" x2="76" y2="60" stroke="${detailCol}" stroke-width="2"/>
        <circle cx="76" cy="42" r="5" fill="none" stroke="${detailCol}" stroke-width="1.5"/>
      `;
      break;

    case 'carrier-deck':
      innerSvg = `
        <rect x="14" y="0" width="72" height="100" fill="${hullFill}" stroke="${hullStroke}" stroke-width="2.5"/>
        <rect x="19" y="0" width="62" height="100" fill="${deckFill}" opacity="0.6"/>
        <line x1="38" y1="0" x2="38" y2="100" stroke="${detailCol}" stroke-width="2" stroke-dasharray="5,4"/>
        <line x1="22" y1="35" x2="56" y2="35" stroke="#ef4444" stroke-width="1.8" opacity="0.9"/>
        <line x1="22" y1="50" x2="56" y2="50" stroke="#ef4444" stroke-width="1.8" opacity="0.9"/>
        <line x1="22" y1="65" x2="56" y2="65" stroke="#ef4444" stroke-width="1.8" opacity="0.9"/>
        <rect x="64" y="25" width="20" height="50" fill="#0f172a" stroke="${detailCol}" stroke-width="1" stroke-dasharray="3,3"/>
      `;
      break;

    case 'body':
      innerSvg = `
        <rect x="18" y="0" width="64" height="100" fill="${hullFill}" stroke="${hullStroke}" stroke-width="2.5"/>
        <rect x="25" y="2" width="50" height="96" fill="${deckFill}" opacity="0.5"/>
        <rect x="33" y="20" width="14" height="14" rx="2" fill="#0f172a" stroke="${detailCol}" stroke-width="1.2"/>
        <rect x="53" y="20" width="14" height="14" rx="2" fill="#0f172a" stroke="${detailCol}" stroke-width="1.2"/>
        <rect x="33" y="42" width="14" height="14" rx="2" fill="#0f172a" stroke="${detailCol}" stroke-width="1.2"/>
        <rect x="53" y="42" width="14" height="14" rx="2" fill="#0f172a" stroke="${detailCol}" stroke-width="1.2"/>
        <rect x="33" y="64" width="14" height="14" rx="2" fill="#0f172a" stroke="${detailCol}" stroke-width="1.2"/>
        <rect x="53" y="64" width="14" height="14" rx="2" fill="#0f172a" stroke="${detailCol}" stroke-width="1.2"/>
        <circle cx="40" cy="27" r="2.5" fill="${accentCol}"/>
        <circle cx="60" cy="27" r="2.5" fill="${accentCol}"/>
        <circle cx="40" cy="49" r="2.5" fill="${accentCol}"/>
        <circle cx="60" cy="49" r="2.5" fill="${accentCol}"/>
        <circle cx="40" cy="71" r="2.5" fill="${accentCol}"/>
        <circle cx="60" cy="71" r="2.5" fill="${accentCol}"/>
      `;
      break;

    case 'carrier-stern':
      innerSvg = `
        <path d="M14,0 L86,0 L78,92 L22,92 Z" fill="${hullFill}" stroke="${hullStroke}" stroke-width="2.5"/>
        <path d="M20,4 L80,4 L72,88 L28,88 Z" fill="${deckFill}" opacity="0.7"/>
        <circle cx="50" cy="46" r="22" fill="none" stroke="${detailCol}" stroke-width="2" stroke-dasharray="5,3"/>
        <text x="50" y="55" font-family="monospace, sans-serif" font-size="24" font-weight="900" fill="${accentCol}" text-anchor="middle">H</text>
        <line x1="36" y1="94" x2="36" y2="100" stroke="${detailCol}" stroke-width="3" stroke-linecap="round"/>
        <line x1="64" y1="94" x2="64" y2="100" stroke="${detailCol}" stroke-width="3" stroke-linecap="round"/>
      `;
      break;

    case 'sub-stern':
      innerSvg = `
        <path d="M22,0 L78,0 L64,88 L36,88 Z" fill="${hullFill}" stroke="${hullStroke}" stroke-width="2.5"/>
        <path d="M28,4 L72,4 L60,84 L40,84 Z" fill="${deckFill}" opacity="0.5"/>
        <rect x="42" y="16" width="16" height="38" rx="7" fill="${turretCol}" stroke="${hullStroke}" stroke-width="1.5"/>
        <circle cx="50" cy="26" r="3" fill="${accentCol}"/>
        <line x1="16" y1="76" x2="84" y2="76" stroke="${hullStroke}" stroke-width="3" stroke-linecap="round"/>
        <line x1="42" y1="94" x2="58" y2="94" stroke="${detailCol}" stroke-width="2"/>
        <circle cx="50" cy="94" r="3" fill="${detailCol}"/>
      `;
      break;

    case 'stern':
    default:
      innerSvg = `
        <path d="M18,0 L82,0 L74,90 L26,90 Z" fill="${hullFill}" stroke="${hullStroke}" stroke-width="2.5"/>
        <path d="M25,4 L75,4 L68,86 L32,86 Z" fill="${deckFill}" opacity="0.6"/>
        <circle cx="50" cy="46" r="20" fill="none" stroke="${detailCol}" stroke-width="2" stroke-dasharray="5,3"/>
        <text x="50" y="55" font-family="monospace, sans-serif" font-size="22" font-weight="900" fill="${accentCol}" text-anchor="middle">H</text>
        <line x1="38" y1="92" x2="38" y2="99" stroke="${detailCol}" stroke-width="3" stroke-linecap="round"/>
        <line x1="62" y1="92" x2="62" y2="99" stroke="${detailCol}" stroke-width="3" stroke-linecap="round"/>
      `;
      break;
  }

  let damageSvg = '';
  if (isSunk) {
    damageSvg = `
      <circle cx="38" cy="48" r="8" fill="#09090b" stroke="#ea580c" stroke-width="1.8"/>
      <circle cx="65" cy="55" r="6" fill="#09090b" stroke="#ea580c" stroke-width="1.5"/>
      <circle cx="38" cy="48" r="4.5" fill="#ef4444" opacity="0.95"/>
      <circle cx="65" cy="55" r="3.2" fill="#ff6d00" opacity="0.95"/>
      <circle cx="50" cy="32" r="2.5" fill="#fbbf24" opacity="0.9"/>
      <circle cx="44" cy="68" r="2" fill="#f97316" opacity="0.85"/>
      <circle cx="28" cy="38" r="1.8" fill="#fbbf24" opacity="0.8"/>
    `;
  }

  return `<svg class="ship-sprite" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
    <g transform="rotate(${rot} 50 50)">
      ${innerSvg}
      ${damageSvg}
    </g>
  </svg>`;
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
  // Initialize fleet ships based on DEFAULT_FLEET (matching shipSizes)
  G.fleet = DEFAULT_FLEET.map(s => ({
    id: s.id,
    name: s.name,
    size: s.size,
    horizontal: true,
    cells: null
  }));
  G.placedShips     = [];
  G.placedOccupied  = new Set();
  G.selectedShipId  = null;
  G.draggedShipId   = null;
  G.dragOriginCells = null;
  G.isReady         = false;
  G.opponentReady   = false;
  G.hoverX          = -1;
  G.hoverY          = -1;

  btnReady.disabled    = true;
  btnReady.textContent = '✅ SẴN SÀNG!';
  btnAuto.disabled     = false;

  // Reset ready status indicators
  if (myReadyStatus) {
    myReadyStatus.className = 'opp-status waiting';
    const s = myReadyStatus.querySelector('span:last-child');
    if (s) s.textContent = 'Tôi chưa sẵn sàng';
  }
  if (oppStatusDiv) {
    oppStatusDiv.className = 'opp-status waiting';
  }
  if (oppStatusText) {
    oppStatusText.textContent = `${G.opponentName || 'Đối thủ'} đang xếp tàu...`;
  }

  // Reset rematch button and notice for subsequent matches
  if (btnRematch) {
    btnRematch.disabled  = false;
    btnRematch.innerHTML = '🔄 Đánh Lại';
  }
  if (rematchNotice) {
    rematchNotice.classList.add('hidden');
    rematchNotice.textContent = '';
  }

  buildPlacementGrid();
  renderFleetCard();
  updatePlacementStatus();
}

function buildPlacementGrid() {
  buildGrid('grid-placement', {
    onCellClick: (x, y) => onPlacementCellClick(x, y),
    onCellHover: (x, y) => {
      G.hoverX = x;
      G.hoverY = y;
      renderPlacementGhost();
    }
  });

  const container = $('grid-placement');
  container.addEventListener('mouseleave', () => {
    G.hoverX = -1;
    G.hoverY = -1;
    clearGhostClasses();
  });

  // Right-click to rotate ship
  container.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (G.isReady) return;
    const hoveredShip = G.fleet.find(s => s.cells && s.cells.some(c => c.x === G.hoverX && c.y === G.hoverY));
    if (hoveredShip) {
      rotatePlacedShip(hoveredShip);
      return;
    }
    if (G.selectedShipId) {
      const s = G.fleet.find(sh => sh.id === G.selectedShipId);
      if (s) {
        s.horizontal = !s.horizontal;
        renderFleetCard();
        renderPlacementGhost();
      }
    }
  });

  // Setup Drag and Drop events on all grid cells
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const cell = getCell('grid-placement', x, y);
      if (!cell) continue;

      cell.addEventListener('dragover', (e) => {
        if (G.isReady || !G.draggedShipId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        G.hoverX = x;
        G.hoverY = y;
        renderPlacementGhost();
      });

      cell.addEventListener('drop', (e) => {
        if (G.isReady || !G.draggedShipId) return;
        e.preventDefault();
        handleGridDrop(x, y);
      });

      cell.addEventListener('dragstart', (e) => {
        if (G.isReady) return;
        const ship = G.fleet.find(s => s.cells && s.cells.some(c => c.x === x && c.y === y));
        if (!ship) {
          e.preventDefault();
          return;
        }
        G.draggedShipId   = ship.id;
        G.dragOriginCells = [...ship.cells];
        e.dataTransfer.setData('text/plain', ship.id);
        e.dataTransfer.effectAllowed = 'move';

        // Temporarily remove ship cells from occupied set so drag ghost doesn't collide with self
        ship.cells.forEach(c => G.placedOccupied.delete(`${c.x},${c.y}`));
        ship.cells.forEach(c => {
          const el = getCell('grid-placement', c.x, c.y);
          if (el) el.style.opacity = '0.35';
        });
      });

      cell.addEventListener('dragend', () => {
        if (G.dragOriginCells && G.draggedShipId) {
          const ship = G.fleet.find(s => s.id === G.draggedShipId);
          if (ship && ship.cells) {
            ship.cells.forEach(c => {
              const el = getCell('grid-placement', c.x, c.y);
              if (el) el.style.opacity = '1';
            });
            G.dragOriginCells.forEach(c => G.placedOccupied.add(`${c.x},${c.y}`));
            renderAllPlacedShips();
          }
        }
        clearGhostClasses();
        G.draggedShipId   = null;
        G.dragOriginCells = null;
      });
    }
  }

  // Setup drop back to Fleet Card for recall
  setupFleetCardDrop();
  renderAllPlacedShips();
}

function setupFleetCardDrop() {
  if (!fleetCardEl) return;
  fleetCardEl.addEventListener('dragover', (e) => {
    if (G.isReady || !G.draggedShipId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    fleetCardEl.classList.add('drag-over-card');
  });

  fleetCardEl.addEventListener('dragleave', () => {
    fleetCardEl.classList.remove('drag-over-card');
  });

  fleetCardEl.addEventListener('drop', (e) => {
    if (G.isReady || !G.draggedShipId) return;
    e.preventDefault();
    fleetCardEl.classList.remove('drag-over-card');
    recallShip(G.draggedShipId);
    G.dragOriginCells = null;
    G.draggedShipId   = null;
    clearGhostClasses();
  });
}

function recallShip(shipId) {
  if (G.isReady) return;
  const ship = G.fleet.find(s => s.id === shipId);
  if (!ship || !ship.cells) return;

  ship.cells.forEach(c => {
    G.placedOccupied.delete(`${c.x},${c.y}`);
    clearCellShipSprite('grid-placement', c.x, c.y, ['ship']);
  });
  ship.cells = null;
  G.placedShips = G.fleet.filter(s => s.cells !== null);

  btnReady.disabled = true;
  renderFleetCard();
  updatePlacementStatus();
  clearGhostClasses();
}

function handleGridDrop(hx, hy) {
  if (G.isReady || !G.draggedShipId) return;
  const ship = G.fleet.find(s => s.id === G.draggedShipId);
  if (!ship) return;

  const { cells, valid } = getGhostCellsForShip(ship, hx, hy);
  if (!valid) {
    if (G.dragOriginCells) {
      G.dragOriginCells.forEach(c => G.placedOccupied.add(`${c.x},${c.y}`));
      renderAllPlacedShips();
    }
    clearGhostClasses();
    G.dragOriginCells = null;
    G.draggedShipId   = null;
    return;
  }

  // Clear previous cells if any
  if (ship.cells) {
    ship.cells.forEach(c => {
      G.placedOccupied.delete(`${c.x},${c.y}`);
      clearCellShipSprite('grid-placement', c.x, c.y, ['ship']);
    });
  }

  ship.cells = cells;
  cells.forEach(c => G.placedOccupied.add(`${c.x},${c.y}`));

  G.dragOriginCells = null;
  G.draggedShipId   = null;
  G.selectedShipId  = null;

  sfxPlace();
  clearGhostClasses();
  renderAllPlacedShips();
  renderFleetCard();
  updatePlacementStatus();

  G.placedShips = G.fleet.filter(s => s.cells !== null);
  btnReady.disabled = (G.placedShips.length < 5);
}

function onPlacementCellClick(x, y) {
  if (G.isReady) return;

  // 1. Click on already placed ship on board -> Rotate it!
  const clickedShip = G.fleet.find(s => s.cells && s.cells.some(c => c.x === x && c.y === y));
  if (clickedShip) {
    rotatePlacedShip(clickedShip);
    return;
  }

  // 2. Click-to-Place: if user selected a ship in card or wants to place next unplaced ship
  let shipToPlace = null;
  if (G.selectedShipId) {
    shipToPlace = G.fleet.find(s => s.id === G.selectedShipId && s.cells === null);
  } else {
    shipToPlace = G.fleet.find(s => s.cells === null);
  }

  if (shipToPlace) {
    const { cells, valid } = getGhostCellsForShip(shipToPlace, x, y);
    if (valid) {
      shipToPlace.cells = cells;
      cells.forEach(c => G.placedOccupied.add(`${c.x},${c.y}`));
      G.selectedShipId = null;

      sfxPlace();
      clearGhostClasses();
      renderAllPlacedShips();
      renderFleetCard();
      updatePlacementStatus();

      G.placedShips = G.fleet.filter(s => s.cells !== null);
      btnReady.disabled = (G.placedShips.length < 5);
      renderPlacementGhost();
    }
  }
}

function rotatePlacedShip(ship) {
  if (G.isReady || !ship || !ship.cells) return;

  const newHoriz = !ship.horizontal;
  const size = ship.size;

  const minX = Math.min(...ship.cells.map(c => c.x));
  const minY = Math.min(...ship.cells.map(c => c.y));

  const otherOccupied = new Set(G.placedOccupied);
  ship.cells.forEach(c => otherOccupied.delete(`${c.x},${c.y}`));

  function testPosition(sx, sy) {
    if (sx < 0 || sx + (newHoriz ? size : 1) > GRID) return null;
    if (sy < 0 || sy + (newHoriz ? 1 : size) > GRID) return null;
    const candidateCells = [];
    for (let i = 0; i < size; i++) {
      const cx = newHoriz ? sx + i : sx;
      const cy = newHoriz ? sy     : sy + i;
      if (otherOccupied.has(`${cx},${cy}`)) return null;
      candidateCells.push({ x: cx, y: cy });
    }
    return candidateCells;
  }

  let validCells = null;
  if (newHoriz) {
    const sy = minY;
    const baseSx = Math.max(0, Math.min(minX, GRID - size));
    const offsets = [0];
    for (let d = 1; d < size; d++) { offsets.push(-d); offsets.push(d); }
    for (const off of offsets) {
      const sx = baseSx + off;
      validCells = testPosition(sx, sy);
      if (validCells) break;
    }
  } else {
    const sx = minX;
    const baseSy = Math.max(0, Math.min(minY, GRID - size));
    const offsets = [0];
    for (let d = 1; d < size; d++) { offsets.push(-d); offsets.push(d); }
    for (const off of offsets) {
      const sy = baseSy + off;
      validCells = testPosition(sx, sy);
      if (validCells) break;
    }
  }

  if (!validCells) {
    ship.cells.forEach(c => {
      const el = getCell('grid-placement', c.x, c.y);
      if (el) {
        el.classList.remove('ship-rotate-blocked');
        void el.offsetWidth;
        el.classList.add('ship-rotate-blocked');
        setTimeout(() => el.classList.remove('ship-rotate-blocked'), 400);
      }
    });
    if (placementStatusDiv) {
      placementStatusDiv.innerHTML = `<span style="color:#ff5252; font-weight:700;">⚠ Vị trí bị vướng, không thể xoay ${ship.name}!</span>`;
      setTimeout(() => updatePlacementStatus(), 1200);
    }
    return;
  }

  ship.cells.forEach(c => {
    G.placedOccupied.delete(`${c.x},${c.y}`);
    clearCellShipSprite('grid-placement', c.x, c.y, ['ship']);
  });

  ship.horizontal = newHoriz;
  ship.cells      = validCells;

  validCells.forEach(c => G.placedOccupied.add(`${c.x},${c.y}`));
  renderAllPlacedShips();
  renderFleetCard();
  sfxPlace();
  renderPlacementGhost();

  if (placementStatusDiv) {
    const dirStr = newHoriz ? 'Ngang [↔]' : 'Dọc [↕]';
    placementStatusDiv.innerHTML = `Đã xoay <strong>${ship.name}</strong> sang chiều <strong>${dirStr}</strong>`;
    setTimeout(() => updatePlacementStatus(), 1200);
  }
}

function getGhostCellsForShip(ship, hx, hy) {
  if (!ship) return { cells: [], valid: false };

  const size = ship.size;
  const isHoriz = !!ship.horizontal;

  const startX = isHoriz ? Math.min(Math.max(0, hx), GRID - size) : Math.max(0, Math.min(GRID - 1, hx));
  const startY = isHoriz ? Math.max(0, Math.min(GRID - 1, hy)) : Math.min(Math.max(0, hy), GRID - size);

  const cells = [];
  for (let i = 0; i < size; i++) {
    const cx = isHoriz ? startX + i : startX;
    const cy = isHoriz ? startY     : startY + i;
    cells.push({ x: cx, y: cy });
  }

  const valid = cells.every(c => !G.placedOccupied.has(`${c.x},${c.y}`));
  return { cells, valid };
}

function clearGhostClasses() {
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const c = getCell('grid-placement', x, y);
      if (c) {
        c.classList.remove('ghost', 'ghost-invalid');
        if (!c.classList.contains('ship')) {
          const oldSvg = c.querySelector('.ship-sprite');
          if (oldSvg) oldSvg.remove();
        }
      }
    }
  }
}

function renderPlacementGhost() {
  clearGhostClasses();
  if (G.hoverX < 0 || G.hoverY < 0) return;

  let ship = null;
  if (G.draggedShipId) {
    ship = G.fleet.find(s => s.id === G.draggedShipId);
  } else if (G.selectedShipId) {
    ship = G.fleet.find(s => s.id === G.selectedShipId && s.cells === null);
  } else {
    ship = G.fleet.find(s => s.cells === null);
  }

  if (!ship) return;

  const { cells, valid } = getGhostCellsForShip(ship, G.hoverX, G.hoverY);
  const size = ship.size;
  const isHoriz = !!ship.horizontal;
  const cls = valid ? 'ghost' : 'ghost-invalid';

  cells.forEach((c, idx) => {
    const el = getCell('grid-placement', c.x, c.y);
    if (el) {
      el.classList.add(cls);
      if (!el.classList.contains('ship')) {
        const oldSvg = el.querySelector('.ship-sprite');
        if (oldSvg) oldSvg.remove();
        const svg = getShipSegmentSvg(size, idx, isHoriz, false, true, !valid);
        const wrapper = document.createElement('div');
        wrapper.innerHTML = svg.trim();
        if (wrapper.firstChild) el.appendChild(wrapper.firstChild);
      }
    }
  });
}

function renderAllPlacedShips() {
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      clearCellShipSprite('grid-placement', x, y, ['ship']);
      const cell = getCell('grid-placement', x, y);
      if (cell) {
        cell.draggable = false;
        cell.style.opacity = '1';
      }
    }
  }

  G.fleet.forEach(ship => {
    if (!ship.cells) return;
    const size = ship.size;
    const isHoriz = !!ship.horizontal;
    ship.cells.forEach((c, idx) => {
      const svg = getShipSegmentSvg(size, idx, isHoriz, false, false, false);
      setCellShipSprite('grid-placement', c.x, c.y, svg, 'ship');
      const cell = getCell('grid-placement', c.x, c.y);
      if (cell) {
        cell.draggable = true;
        cell.title = 'Kéo để đổi chỗ • Nhấp chuột trái để xoay';
      }
    });
  });
}

function renderFleetCard() {
  if (!fleetDockEl) return;
  fleetDockEl.innerHTML = '';

  const placedCount = G.fleet.filter(s => s.cells !== null).length;
  if (fleetCountBadge) {
    fleetCountBadge.textContent = `${placedCount}/5 ĐÃ ĐẶT`;
    if (placedCount === 5) {
      fleetCountBadge.classList.add('all-placed');
    } else {
      fleetCountBadge.classList.remove('all-placed');
    }
  }

  G.fleet.forEach(ship => {
    const isPlaced = (ship.cells !== null);
    const isSelected = (G.selectedShipId === ship.id);

    const item = document.createElement('div');
    item.className = 'fleet-ship-item'
      + (isPlaced ? ' is-placed' : '')
      + (isSelected ? ' is-selected' : '');
    item.dataset.id = ship.id;
    item.title = `${ship.name} (${ship.size} ô) • ` + (isPlaced ? 'Đã xếp trên bản đồ (bấm Thu hồi để lấy lại)' : 'Kéo thả lên bản đồ để xếp');

    if (!isPlaced) {
      item.draggable = true;
    } else {
      item.draggable = false;
    }

    // Left side: Drag icon + Ship segments (ONLY the ship graphic, NO text name)
    const leftSide = document.createElement('div');
    leftSide.className = 'fleet-ship-left';

    if (!isPlaced) {
      const dragIcon = document.createElement('span');
      dragIcon.className = 'fleet-drag-icon';
      dragIcon.textContent = '⠿';
      leftSide.appendChild(dragIcon);
    }

    const segsWrap = document.createElement('div');
    segsWrap.className = 'fleet-ship-segments';

    for (let idx = 0; idx < ship.size; idx++) {
      const segBox = document.createElement('div');
      segBox.className = 'fleet-ship-seg';
      const svgHtml = getShipSegmentSvg(ship.size, idx, true, false, false, false);
      segBox.innerHTML = svgHtml;
      segsWrap.appendChild(segBox);
    }
    leftSide.appendChild(segsWrap);
    item.appendChild(leftSide);

    // Right side: Action button (Rotate or Recall)
    const actions = document.createElement('div');
    actions.className = 'fleet-ship-actions';

    if (isPlaced) {
      const btnRecall = document.createElement('button');
      btnRecall.className = 'btn-ship-recall';
      btnRecall.innerHTML = '↩ Thu hồi';
      btnRecall.title = `Thu hồi tàu (${ship.size} ô) về xưởng`;
      btnRecall.addEventListener('click', (e) => {
        e.stopPropagation();
        recallShip(ship.id);
      });
      actions.appendChild(btnRecall);
    } else {
      const btnDir = document.createElement('button');
      btnDir.className = 'btn-ship-dir';
      btnDir.innerHTML = ship.horizontal ? '↔ Ngang' : '↕ Dọc';
      btnDir.title = 'Nhấp để đổi chiều đặt tàu';
      btnDir.addEventListener('click', (e) => {
        e.stopPropagation();
        ship.horizontal = !ship.horizontal;
        renderFleetCard();
        renderPlacementGhost();
      });
      actions.appendChild(btnDir);
    }

    item.appendChild(actions);

    // Events on unplaced item
    if (!isPlaced) {
      item.addEventListener('dragstart', (e) => {
        if (G.isReady) return;
        G.draggedShipId = ship.id;
        G.dragOriginCells = null;
        item.classList.add('is-dragging');
        e.dataTransfer.setData('text/plain', ship.id);
        e.dataTransfer.effectAllowed = 'move';
      });

      item.addEventListener('dragend', () => {
        item.classList.remove('is-dragging');
        clearGhostClasses();
        G.draggedShipId = null;
      });

      item.addEventListener('click', () => {
        if (G.isReady) return;
        if (G.selectedShipId === ship.id) {
          ship.horizontal = !ship.horizontal;
        } else {
          G.selectedShipId = ship.id;
        }
        renderFleetCard();
        renderPlacementGhost();
      });
    }

    fleetDockEl.appendChild(item);
  });
}

function updatePlacementStatus() {
  const placedCount = G.fleet.filter(s => s.cells !== null).length;
  if (placedCount < 5) {
    placementStatusDiv.innerHTML = `Đã triển khai: <strong>${placedCount}/5</strong> chiến hạm — Kéo tàu lên bản đồ để xếp`;
  } else {
    placementStatusDiv.innerHTML = 'Hạm đội đã sẵn sàng! — Nhấn <strong>SẴN SÀNG!</strong> để tham chiến';
  }
}

// Auto-place all ships randomly
function doAutoPlace() {
  if (G.isReady) return;

  G.fleet.forEach(s => {
    if (s.cells) {
      s.cells.forEach(c => clearCellShipSprite('grid-placement', c.x, c.y, ['ship']));
      s.cells = null;
    }
  });
  G.placedOccupied.clear();
  G.selectedShipId = null;

  for (const ship of G.fleet) {
    let placed = false;
    for (let attempt = 0; attempt < 100 && !placed; attempt++) {
      const horiz = Math.random() < 0.5;
      const maxX = horiz ? GRID - ship.size : GRID - 1;
      const maxY = horiz ? GRID - 1 : GRID - ship.size;
      const sx = Math.floor(Math.random() * (maxX + 1));
      const sy = Math.floor(Math.random() * (maxY + 1));

      const candidate = [];
      let collision = false;
      for (let i = 0; i < ship.size; i++) {
        const cx = horiz ? sx + i : sx;
        const cy = horiz ? sy     : sy + i;
        if (G.placedOccupied.has(`${cx},${cy}`)) {
          collision = true;
          break;
        }
        candidate.push({ x: cx, y: cy });
      }

      if (!collision) {
        ship.horizontal = horiz;
        ship.cells      = candidate;
        candidate.forEach(c => G.placedOccupied.add(`${c.x},${c.y}`));
        placed = true;
      }
    }
  }

  G.placedShips = G.fleet.filter(s => s.cells !== null);
  renderAllPlacedShips();
  renderFleetCard();
  updatePlacementStatus();
  btnReady.disabled = (G.placedShips.length < 5);
  sfxPlace();
}

btnAuto.addEventListener('click', doAutoPlace);

btnReady.addEventListener('click', () => {
  if (G.isReady) return;
  const placed = G.fleet.filter(s => s.cells !== null);
  if (placed.length < 5) return;

  const shipsPayload = placed.map(ship => ({ cells: ship.cells }));
  socket.emit('submitShips', { ships: shipsPayload });
  G.isReady = true;
  btnReady.disabled    = true;
  btnAuto.disabled     = true;
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

  // Ships are intentionally NOT rendered visually on my grid.
  // They remain hidden — only hit (✕) or miss marks will appear when the enemy fires.
  // Internal tracking via G.myGrid and G.myShipCells still works correctly.

  updateEnemyGridClickable();
  updateTurnBanner();
  renderFleetStatus();
  if (battleLog) battleLog.textContent = 'Trận chiến bắt đầu! Nhắm bắn vào radar đối thủ.';
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
    // Remove any sprite or hack outline from this cell so it only shows hit (X) or miss
    clearCellShipSprite('grid-enemy', x, y, ['hack-ship', 'hack-sunk']);

    if (hit) {
      addCellClass('grid-enemy', x, y, 'hit');
    } else {
      addCellClass('grid-enemy', x, y, 'miss');
    }

    if (sunkCells) {
      // Entire ship is destroyed! Reveal detailed burning warship graphics on all cells of this ship
      const { sorted, isHorizontal } = sortShipCells(sunkCells);
      const shipSize = sorted.length;
      sorted.forEach((c, idx) => {
        G.enemyGrid[c.y][c.x] = 'sunk';
        clearCellShipSprite('grid-enemy', c.x, c.y, ['hit', 'hack-ship', 'hack-sunk']);
        const cell = getCell('grid-enemy', c.x, c.y);
        if (cell) {
          cell.classList.add('sunk');
          const svg = getShipSegmentSvg(shipSize, idx, isHorizontal, true, false, false, false);
          setCellShipSprite('grid-enemy', c.x, c.y, svg, 'sunk');
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
    // Remove any sprite from this cell so hit only shows X
    clearCellShipSprite('grid-my', x, y, ['ship']);

    if (hit) {
      addCellClass('grid-my', x, y, 'hit');
    } else {
      addCellClass('grid-my', x, y, 'miss');
    }

    if (sunkCells) {
      // Entire ship is destroyed! Reveal detailed burning warship graphics on my grid
      const { sorted, isHorizontal } = sortShipCells(sunkCells);
      const shipSize = sorted.length;
      sorted.forEach((c, idx) => {
        G.myGrid[c.y][c.x] = 'sunk';
        clearCellShipSprite('grid-my', c.x, c.y, ['hit', 'ship']);
        const cell = getCell('grid-my', c.x, c.y);
        if (cell) {
          cell.classList.add('sunk');
          const svg = getShipSegmentSvg(shipSize, idx, isHorizontal, true, false, false, false);
          setCellShipSprite('grid-my', c.x, c.y, svg, 'sunk');
        }
      });
      // Mark ship as sunk in my fleet status
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
      // Highlight unshot ship cells with radar border only — NEVER render ship shapes here
      if (G.enemyGrid && G.enemyGrid[c.y][c.x] === null) {
        cell.classList.add(ship.sunk ? 'hack-sunk' : 'hack-ship');
      }
    });
  });
}

function clearHackOverlay() {
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const cell = getCell('grid-enemy', x, y);
      if (cell) {
        cell.classList.remove('hack-ship', 'hack-sunk');
        // If not a sunk ship, ensure no ship-sprite remains
        if (G.enemyGrid && G.enemyGrid[y][x] !== 'sunk') {
          const oldSprite = cell.querySelector('.ship-sprite');
          if (oldSprite) oldSprite.remove();
        }
      }
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

  // Always reset rematch button and notice so player can play again unlimited times
  if (btnRematch) {
    btnRematch.disabled  = false;
    btnRematch.innerHTML = '🔄 Đánh Lại';
  }
  if (rematchNotice) {
    rematchNotice.classList.add('hidden');
    rematchNotice.textContent = '';
  }

  showScreen('gameover');
}

function revealEnemyFleet(ships) {
  // Reveal enemy ships on enemy grid after game ends
  ships.forEach(ship => {
    const { sorted, isHorizontal } = sortShipCells(ship.cells);
    const shipSize = sorted.length;
    sorted.forEach((c, idx) => {
      if (G.enemyGrid && G.enemyGrid[c.y][c.x] === null) {
        const svg = getShipSegmentSvg(shipSize, idx, isHorizontal, false, false, false, true);
        setCellShipSprite('grid-enemy', c.x, c.y, svg, 'hack-ship');
      }
    });
  });
}

// Gameover buttons
btnRematch.addEventListener('click', () => {
  if (btnRematch.disabled) return;
  socket.emit('playAgain');
  btnRematch.disabled   = true;
  btnRematch.innerHTML  = '⏳ Đang chờ đối thủ...';
  rematchNotice.textContent = 'Đang chờ đối thủ đồng ý đánh lại...';
  rematchNotice.classList.remove('hidden');
});

btnHome.addEventListener('click', () => {
  try { socket.disconnect(); } catch (e) { /* ignore */ }
  location.reload();
});

// ─── Keyboard ──────────────────────────────────────────────────────────────────
window.addEventListener('keydown', (e) => {
  const activeInput = document.activeElement;
  const isTyping = activeInput && (activeInput.tagName === 'INPUT' || activeInput.tagName === 'TEXTAREA');
  if (isTyping) return;

  if (e.key === ']' || e.code === 'BracketRight') {
    e.preventDefault();
    const battleScreen = $('screen-battle');
    if (!battleScreen.classList.contains('hidden')) {
      toggleHackMode();
    }
    return;
  }

  // Rotate ship during placement via R or Space
  if (e.key === 'r' || e.key === 'R' || e.code === 'KeyR' || e.key === ' ') {
    const placementScreen = $('screen-placement');
    if (placementScreen && !placementScreen.classList.contains('hidden') && !G.isReady) {
      e.preventDefault();
      // If hovering over a placed ship, rotate it
      const hoveredShip = G.fleet.find(s => s.cells && s.cells.some(c => c.x === G.hoverX && c.y === G.hoverY));
      if (hoveredShip) {
        rotatePlacedShip(hoveredShip);
        return;
      }
      // If a ship is selected in card, rotate it
      let targetShip = null;
      if (G.selectedShipId) {
        targetShip = G.fleet.find(s => s.id === G.selectedShipId);
      } else {
        targetShip = G.fleet.find(s => s.cells === null);
      }
      if (targetShip) {
        targetShip.horizontal = !targetShip.horizontal;
        renderFleetCard();
        renderPlacementGhost();
      }
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
  G.fleet.forEach(s => {
    if (s.cells) {
      s.cells.forEach(c => clearCellShipSprite('grid-placement', c.x, c.y, ['ship']));
      s.cells = null;
    }
  });
  G.placedOccupied.clear();
  G.placedShips = [];
  G.isReady = false;
  btnReady.disabled    = true;
  btnReady.textContent = '✅ Sẵn Sàng!';
  btnAuto.disabled     = false;
  renderFleetCard();
  updatePlacementStatus();
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
  if (rematchNotice) {
    rematchNotice.textContent  = `⚡ ${name} muốn đánh lại! Nhấn "Đánh Lại" để tham chiến!`;
    rematchNotice.classList.remove('hidden');
  }
  if (btnRematch && !btnRematch.disabled) {
    btnRematch.innerHTML = '⚡ Chấp Nhận Đánh Lại!';
  }
});

// ─── Init ────────────────────────────────────────────────────────────────────────
showScreen('lobby');

// ═══════════════════════════════════════════════════════════════════════════════
// FLOATING CHAT WIDGET — Global real-time chat (no room required)
// ═══════════════════════════════════════════════════════════════════════════════
(function () {
  const chatPanel    = $('chat-panel');
  const chatMsgs     = $('chat-messages');
  const chatInputEl  = $('chat-input');
  const chatToggleEl = $('chat-toggle');
  const chatBadgeEl  = $('chat-badge');
  const btnChatClose = $('btn-chat-close');
  const btnChatSend  = $('btn-chat-send');

  let isOpen = false;
  let unread = 0;

  // ── Open / Close ──────────────────────────────────────────────────────────────
  function openChat() {
    isOpen = true;
    chatPanel.classList.remove('chat-closed');
    chatPanel.classList.add('chat-open');
    chatToggleEl.classList.add('is-open');
    unread = 0;
    chatBadgeEl.classList.add('hidden');
    chatBadgeEl.textContent = '0';
    chatMsgs.scrollTop = chatMsgs.scrollHeight;
    chatInputEl.focus();
  }

  function closeChat() {
    isOpen = false;
    chatPanel.classList.remove('chat-open');
    chatPanel.classList.add('chat-closed');
    chatToggleEl.classList.remove('is-open');
  }

  chatToggleEl.addEventListener('click', () => isOpen ? closeChat() : openChat());
  btnChatClose.addEventListener('click', closeChat);

  // ── Append bubble ─────────────────────────────────────────────────────────────
  function appendMsg(senderName, text, isMe, isSystem) {
    const hint = chatMsgs.querySelector('.chat-hint');
    if (hint) hint.remove();

    if (isSystem) {
      const d = document.createElement('div');
      d.className = 'chat-sys';
      d.textContent = text;
      chatMsgs.appendChild(d);
    } else {
      const wrap = document.createElement('div');
      wrap.className = 'chat-msg ' + (isMe ? 'chat-msg-me' : 'chat-msg-them');

      if (!isMe) {
        const nameEl = document.createElement('div');
        nameEl.className = 'chat-msg-name';
        nameEl.textContent = senderName;
        wrap.appendChild(nameEl);
      }

      const bubble = document.createElement('div');
      bubble.className = 'chat-bubble';
      bubble.textContent = text;
      wrap.appendChild(bubble);
      chatMsgs.appendChild(wrap);
    }

    chatMsgs.scrollTop = chatMsgs.scrollHeight;

    // Badge + pulse ring when chat is closed
    if (!isOpen && !isSystem) {
      unread = Math.min(unread + 1, 99);
      chatBadgeEl.textContent = unread;
      chatBadgeEl.classList.remove('hidden');
      chatToggleEl.classList.remove('new-msg-pulse');
      void chatToggleEl.offsetWidth; // force reflow to restart CSS animation
      chatToggleEl.classList.add('new-msg-pulse');
    }
  }

  // ── Send — always allowed, no room required ───────────────────────────────────
  function sendMsg() {
    const text = chatInputEl.value.trim();
    if (!text) return;
    socket.emit('chatMessage', { text });
    chatInputEl.value = '';
    chatInputEl.focus();
  }

  btnChatSend.addEventListener('click', sendMsg);
  chatInputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); sendMsg(); }
  });

  // ── Receive global messages ───────────────────────────────────────────────────
  socket.on('chatMessage', ({ senderId, senderName, text }) => {
    const isMe = (senderId === socket.id);
    appendMsg(senderName, text, isMe, false);
  });

  // ── Game system messages (vẫn hiển thị trong chat) ───────────────────────────
  socket.on('startPlacement', () => {
    appendMsg(null, '⚔ Trận đấu bắt đầu — Xếp tàu ngay!', false, true);
  });
  socket.on('startBattle', () => {
    appendMsg(null, '💥 Chiến đấu!', false, true);
  });
  socket.on('opponentDisconnected', ({ name }) => {
    appendMsg(null, `❌ ${name} đã rời phòng`, false, true);
  });
}());



