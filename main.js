
// SKYBOUND: CRYSTAL QUEST
const W = 360;
const FIXED_DT = 1 / 60;
const FIXED_STEP_MS = 1000 / 60;

const container = document.getElementById('game-container');
const canvas = document.createElement('canvas');
container.appendChild(canvas);
const ctx = canvas.getContext('2d');

let H = 640;
let scale = 1;

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = container.getBoundingClientRect();
  const cssWidth = Math.max(1, rect.width || window.innerWidth);
  const cssHeight = Math.max(1, rect.height || window.innerHeight);

  scale = cssWidth / W;
  H = Math.max(420, cssHeight / scale);

  canvas.width = Math.floor(cssWidth * dpr);
  canvas.height = Math.floor(cssHeight * dpr);
  canvas.style.width = cssWidth + 'px';
  canvas.style.height = cssHeight + 'px';

  ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
  ctx.imageSmoothingEnabled = false;
}

window.addEventListener('resize', resize);
resize();

function loadImage(src) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = src;
  return img;
}

const IMG = {
  hero: loadImage('assets/hero-fly.webp'),
  sky: loadImage('assets/sky-bg.webp'),
  islands: loadImage('assets/islands-layer.webp'),
  pillar: loadImage('assets/crystal-pillar.webp'),
  gem: loadImage('assets/crystal-gem.webp'),
  crystalSaw: loadImage('assets/hanging-crystal-saw.webp'),
  crystalBlade: loadImage('assets/giant-crystal-blade.webp'),
};

const HERO_FRAMES = [
  { x: 0, y: 0, w: 305, h: 295 },
  { x: 309, y: 0, w: 286, h: 231 },
  { x: 0, y: 299, w: 307, h: 262 },
  { x: 311, y: 299, w: 293, h: 241 },
];

const ready = (img) => img.complete && img.naturalWidth > 0;

// ---------- Audio ----------
const music = new Audio('assets/audio/sky-music.mp3');
music.loop = true;
music.volume = 0.45;

const sfxPickup = new Audio('assets/audio/crystal-pickup.mp3');
const sfxCrash = new Audio('assets/audio/crash.mp3');

let muted = localStorage.getItem('sb_muted') === '1';
let actx = null;

function playSfx(a) {
  if (muted) return;
  a.currentTime = 0;
  a.play().catch(() => {});
}

function beep(freq, dur, type = 'square', vol = 0.06) {
  if (muted || !actx) return;

  const o = actx.createOscillator();
  const g = actx.createGain();

  o.type = type;
  o.frequency.setValueAtTime(freq, actx.currentTime);
  o.frequency.exponentialRampToValueAtTime(
    freq * 1.8,
    actx.currentTime + dur
  );

  g.gain.setValueAtTime(vol, actx.currentTime);
  g.gain.exponentialRampToValueAtTime(
    0.001,
    actx.currentTime + dur
  );

  o.connect(g).connect(actx.destination);
  o.start();
  o.stop(actx.currentTime + dur);
}

function unlockAudio() {
  if (!actx) {
    actx = new (window.AudioContext || window.webkitAudioContext)();
  }

  if (!muted && music.paused) {
    music.play().catch(() => {});
  }
}

// ---------- Worlds ----------
const WORLDS = [
  {
    name: 'Twilight Skies',
    tint: null,
    fog: '#b28cff',
    particle: '#fff6b0'
  },
  {
    name: 'Emerald Falls',
    tint: 'rgba(40,200,140,0.22)',
    fog: '#7dffc8',
    particle: '#c8ffd8'
  },
  {
    name: 'Ember Peaks',
    tint: 'rgba(255,90,30,0.28)',
    fog: '#ff8a50',
    particle: '#ffb040'
  },
  {
    name: 'Frost Aurora',
    tint: 'rgba(120,200,255,0.28)',
    fog: '#bff0ff',
    particle: '#ffffff'
  },
];

const WORLD_LEN = 10;

// ---------- State ----------
const S = {
  mode: 'suspended',
  hero: null,
  pillars: [],
  specials: [],
  gems: [],
  parts: [],
  ambient: [],

  score: 0,
  crystals: 0,
  t: 0,
  scroll: 0,
  shake: 0,

  flash: 0,
  worldIdx: 0,
  banner: 0,
  specialBanner: 0,
  specialName: '',

  safeTime: 0,
  overT: 0,
  sawSpawned: false,
  bladeSpawned: false,

  runId: null,
  runStartedAt: 0,
  seed: 1,
  rngState: 1,
  inputEvents: [],

  // Number of completed fixed simulation steps.
  simTick: 0,

  // Time waiting for the next fixed simulation step.
  accumulator: 0,

  spawnX: W + 120,
};

function reset() {
  S.hero = {
    x: 100,
    y: H * 0.42,
    vy: 0,
    rot: 0,
    frame: 0
  };

  S.pillars = [];
  S.specials = [];
  S.gems = [];
  S.parts = [];

  S.score = 0;
  S.crystals = 0;
  S.t = 0;
  S.scroll = 0;
  S.shake = 0;

  S.flash = 0;
  S.worldIdx = 0;
  S.banner = 2;
  S.specialBanner = 0;
  S.specialName = '';

  S.safeTime = 1.8;
  S.overT = 0;

  S.runId = null;
  S.runStartedAt = 0;

  S.seed = 1;
  S.rngState = 1;
  S.inputEvents = [];

  S.simTick = 0;
  S.accumulator = 0;

  S.sawSpawned = false;
  S.bladeSpawned = false;
  S.spawnX = W + 120;
}

reset();

for (let i = 0; i < 40; i++) {
  S.ambient.push({
    x: Math.random() * W,
    y: Math.random() * 900,
    s: 0.3 + Math.random(),
    p: Math.random() * 6
  });
}

function gameRandom() {
  S.rngState = (S.rngState + 0x6d2b79f5) >>> 0;

  let value = S.rngState;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);

  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
}

const speed = () => 130 + Math.min(S.score, 120) * 1.15;
const gapSize = () => Math.max(150, 200 - S.score * 1.5);

function spawnSpecial(type, x) {
  const phase = gameRandom() * Math.PI * 2;

  if (type === 'saw') {
    S.specials.push({
      type,
      x,
      phase,
      length: 124 + gameRandom() * 20,
      anchorY: 18,
      radius: 35,
      sparkTimer: 0.1
    });

    S.specialName = 'HANGING CRYSTAL SAW';
  } else {
    const baseY = Math.max(
      175,
      Math.min(
        H - 175,
        H * 0.52 + (gameRandom() - 0.5) * 50
      )
    );

    S.specials.push({
      type,
      x,
      phase,
      baseY,
      radius: 36,
      sparkTimer: 0.15
    });

    S.specialName = 'GIANT CRYSTAL BLADE';
  }

  S.specialBanner = 2.6;
}

function spawnUnlockedSpecial(x) {
  let type = null;

  if (S.score >= 50 && !S.sawSpawned) {
    type = 'saw';
    S.sawSpawned = true;
  } else if (S.score >= 100 && !S.bladeSpawned) {
    type = 'blade';
    S.bladeSpawned = true;
  } else if (S.score >= 100) {
    const roll = gameRandom();

    if (roll < 0.22) type = 'blade';
    else if (roll < 0.56) type = 'saw';
  } else if (S.score >= 50 && gameRandom() < 0.34) {
    type = 'saw';
  }

  if (type) spawnSpecial(type, x);
}

function spawnPillar() {
  const gap = gapSize();
  const margin = 70;

  const gy = margin + gameRandom() * (
    H - 2 * margin - gap - 40
  );

  const moving = S.score >= 6 && gameRandom() < 0.35;

  S.pillars.push({
    x: S.spawnX,
    gy,
    gap,
    w: 64,
    passed: false,
    moving,
    phase: gameRandom() * 6,
    baseGy: gy
  });

  // Existing pillar course remains unchanged.
  spawnUnlockedSpecial(S.spawnX + 110);

  // Scattered crystals.
  S.gems.push({
    x: S.spawnX + 32,
    y: gy + gap / 2,
    t: gameRandom() * 6
  });

  if (gameRandom() < 0.6) {
    const midY = 90 + gameRandom() * (H - 220);

    for (let i = 0; i < 3; i++) {
      S.gems.push({
        x: S.spawnX + 120 + i * 26,
        y: midY + Math.sin(i) * 20,
        t: i
      });
    }
  }

  S.spawnX += 220;
}

function specialPose(obstacle) {
  const sx = obstacle.x - S.scroll;

  if (obstacle.type === 'saw') {
    const swing =
      Math.sin(S.t * 1.38 + obstacle.phase) * 0.43 +
      Math.sin(S.t * 0.57 + obstacle.phase) * 0.055;

    return {
      x: sx + Math.sin(swing) * obstacle.length,
      y: obstacle.anchorY + Math.cos(swing) * obstacle.length,
      rotation: S.t * 3.15 + obstacle.phase,
      anchorX: sx,
      anchorY: obstacle.anchorY
    };
  }

  return {
    x: sx + Math.sin(S.t * 0.76 + obstacle.phase) * 24,
    y: obstacle.baseY + Math.sin(S.t * 1.28 + obstacle.phase) * 54,
    rotation: S.t * 2.4 + obstacle.phase
  };
}

function burst(x, y, color, n, spd = 120) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = spd * (0.3 + Math.random());

    S.parts.push({
      x,
      y,
      vx: Math.cos(a) * v,
      vy: Math.sin(a) * v,
      life: 0.5 + Math.random() * 0.5,
      color,
      size: 2 + (Math.random() * 3 | 0)
    });
  }
}

// ---------- Input ----------
function flap() {
  if (S.mode !== 'play') return;

  unlockAudio();

  // Record input on the fixed simulation timeline,
  // not on the phone's wall clock.
  if (S.inputEvents.length < 12000) {
    S.inputEvents.push(S.simTick * FIXED_STEP_MS);
  }

  S.hero.vy = -330;
  beep(320, 0.08, 'triangle', 0.05);
  burst(S.hero.x - 10, S.hero.y + 6, '#ffffff', 5, 60);
}

function die() {
  if (S.mode !== 'play') return;

  S.mode = 'over';
  S.overT = 0;
  S.hero.vy = 0;
  S.shake = 8;
  S.flash = 0.35;

  playSfx(sfxCrash);
  burst(S.hero.x, S.hero.y, '#ff6ad5', 30, 200);

  window.dispatchEvent(new CustomEvent('skybound:gameover', {
    detail: {
      runId: S.runId,
      score: S.score,
      crystals: S.crystals,

      // Duration is measured in completed fixed steps.
      elapsedMs: S.simTick * FIXED_STEP_MS,

      seed: S.seed,
      randomAlgorithm: 'mulberry32-v1',
      inputEvents: S.inputEvents.slice()
    }
  }));
    }

// ---------- Input Events ----------
const muteBtn = {
  x: W - 48,
  y: 0,
  w: 40,
  h: 40
};

canvas.addEventListener('pointerdown', (e) => {
  if (S.mode === 'over') {
    flap();
    return;
  }

  const rect = canvas.getBoundingClientRect();
  const px = (e.clientX - rect.left) / scale;
  const py = (e.clientY - rect.top) / scale;

  muteBtn.y = H * 0.05;

  if (
    px > muteBtn.x &&
    px < muteBtn.x + muteBtn.w &&
    py > muteBtn.y &&
    py < muteBtn.y + muteBtn.h
  ) {
    muted = !muted;
    localStorage.setItem('sb_muted', muted ? '1' : '0');

    if (muted) music.pause();
    else unlockAudio();

    return;
  }

  flap();
});

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' || e.code === 'ArrowUp') {
    e.preventDefault();

    if (!e.repeat) flap();
  }
});

window.addEventListener('skybound:layout', resize);

window.addEventListener('skybound:launch', (event) => {
  reset();

  S.runId = event.detail?.runId || null;

  const runSeed = Number(event.detail?.seed);

  S.seed =
    Number.isSafeInteger(runSeed) &&
    runSeed >= 0 &&
    runSeed <= 0xffffffff
      ? runSeed >>> 0
      : 1;

  S.rngState = S.seed;

  // Keep a monotonic start reference for local timing if needed.
  S.runStartedAt = performance.now();

  S.mode = 'play';

  resize();

  // Start this run with a clean fixed-step accumulator.
  S.accumulator = 0;
  S.simTick = 0;

  unlockAudio();

  S.inputEvents.push(0);

  S.hero.vy = -330;

  beep(320, 0.08, 'triangle', 0.05);
  burst(S.hero.x - 10, S.hero.y + 6, '#ffffff', 5, 60);
});

window.addEventListener('skybound:stop', () => {
  S.mode = 'suspended';

  if (S.hero) {
    S.hero.vy = 0;
  }

  S.accumulator = 0;
});

// ---------- Update ----------
function update(dt) {
  const h = S.hero;

  if (S.mode === 'over') {
    // Let only the brief impact feedback and retry hint settle.
    // The course, player, score, and moving hazards remain frozen.
    S.overT += dt;
    S.shake = Math.max(0, S.shake - dt * 40);
    S.flash = Math.max(0, S.flash - dt * 3);

    for (const particle of S.parts) {
      particle.life -= dt;
    }

    S.parts = S.parts.filter((particle) => particle.life > 0);
    return;
  }

  if (S.mode !== 'play') return;

  // One simulation tick has now been completed.
  S.simTick += 1;

  S.t += dt;

  S.safeTime = Math.max(0, S.safeTime - dt);
  S.banner = Math.max(0, S.banner - dt);
  S.specialBanner = Math.max(0, S.specialBanner - dt);
  S.shake = Math.max(0, S.shake - dt * 40);
  S.flash = Math.max(0, S.flash - dt * 3);

  S.scroll += speed() * dt;

  h.vy += 980 * dt;
  h.y += h.vy * dt;

  h.rot = Math.max(-0.5, Math.min(1.2, h.vy / 500));
  h.frame += dt * (h.vy < 0 ? 18 : 8);

  while (S.spawnX - S.scroll < W + 80) {
    spawnPillar();
  }

  if (h.y > H - 20 || h.y < -40) {
    die();
    return;
  }

  for (const p of S.pillars) {
    if (p.moving) {
      p.gy = p.baseGy + Math.sin(S.t * 1.6 + p.phase) * 35;
    }

    const sx = p.x - S.scroll;

    // Check collisions before scoring.
    const r = 11;

    if (
      S.safeTime <= 0 &&
      h.x + r > sx + 6 &&
      h.x - r < sx + p.w - 6 &&
      (h.y - r < p.gy || h.y + r > p.gy + p.gap)
    ) {
      die();
      return;
    }

    if (!p.passed && sx + p.w < h.x) {
      p.passed = true;
      S.score++;

      beep(660, 0.1, 'square', 0.04);

      if (S.score === 50 && !S.sawSpawned) {
        S.sawSpawned = true;
        spawnSpecial('saw', S.scroll + W + 22);
      }

      if (S.score === 100 && !S.bladeSpawned) {
        S.bladeSpawned = true;
        spawnSpecial('blade', S.scroll + W + 22);
      }

      const wi = Math.min(
        WORLDS.length - 1,
        Math.floor(S.score / WORLD_LEN)
      );

      if (wi !== S.worldIdx) {
        S.worldIdx = wi;
        S.banner = 2.5;
        S.flash = 0.6;
      }
    }
  }

  for (const obstacle of S.specials) {
    const pose = specialPose(obstacle);

    obstacle.sparkTimer -= dt;

    if (obstacle.sparkTimer <= 0) {
      const color =
        obstacle.type === 'saw' ? '#75f5ff' : '#ff83f0';

      burst(pose.x, pose.y, color, 2, 24);

      obstacle.sparkTimer = 0.3 + Math.random() * 0.28;
    }

    if (
      S.safeTime <= 0 &&
      Math.hypot(pose.x - h.x, pose.y - h.y) <
        obstacle.radius + 11
    ) {
      die();
      return;
    }
  }

  for (const g of S.gems) {
    if (g.got) continue;

    const gx = g.x - S.scroll;

    if (Math.hypot(gx - h.x, g.y - h.y) < 26) {
      g.got = true;
      S.crystals += 1;

      playSfx(sfxPickup);

      burst(gx, g.y, '#7ff6ff', 14);
      burst(gx, g.y, '#ff7ae0', 8);
    }
  }

  S.pillars = S.pillars.filter(
    (p) => p.x - S.scroll > -100
  );

  S.specials = S.specials.filter(
    (o) => o.x - S.scroll > -150
  );

  S.gems = S.gems.filter(
    (g) => g.x - S.scroll > -40
  );

  for (const p of S.parts) {
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vy += 200 * dt;
    p.life -= dt;
  }

  S.parts = S.parts.filter((p) => p.life > 0);
}

// ---------- Draw ----------
function drawLayer(img, factor, y, hgt, alpha = 1) {
  if (!ready(img)) return;

  const w = img.naturalWidth * (hgt / img.naturalHeight);

  let x = -((S.scroll * factor) % w);

  ctx.globalAlpha = alpha;

  for (; x < W; x += w) {
    ctx.drawImage(img, x, y, w, hgt);
  }

  ctx.globalAlpha = 1;
}

function drawPillar(p) {
  const sx = Math.round(p.x - S.scroll);
  const img = IMG.pillar;

  const top = p.gy;
  const bot = p.gy + p.gap;

  ctx.save();

  ctx.shadowColor = WORLDS[S.worldIdx].fog;
  ctx.shadowBlur = 14;

  if (ready(img)) {
    const ph = img.naturalHeight * (p.w / img.naturalWidth);

    for (let y = top; y > -ph; y -= ph) {
      ctx.save();
      ctx.translate(sx, y);
      ctx.scale(1, -1);
      ctx.drawImage(img, 0, 0, p.w, ph);
      ctx.restore();
    }

    for (let y = bot; y < H; y += ph) {
      ctx.drawImage(img, sx, y, p.w, ph);
    }
  } else {
    ctx.fillStyle = '#3a2a5a';
    ctx.fillRect(sx, 0, p.w, top);
    ctx.fillRect(sx, bot, p.w, H - bot);
  }

  ctx.restore();

  // Glowing gap edges.
  ctx.fillStyle = WORLDS[S.worldIdx].fog;
  ctx.globalAlpha = 0.5 + Math.sin(S.t * 4) * 0.2;

  ctx.fillRect(sx + 4, top - 3, p.w - 8, 3);
  ctx.fillRect(sx + 4, bot, p.w - 8, 3);

  ctx.globalAlpha = 1;
}

function drawChain(pose) {
  const dx = pose.x - pose.anchorX;
  const dy = pose.y - pose.anchorY;

  const endX = pose.anchorX + dx * 0.72;
  const endY = pose.anchorY + dy * 0.72;

  const angle = Math.atan2(
    endY - pose.anchorY,
    endX - pose.anchorX
  );

  ctx.save();

  ctx.lineCap = 'square';
  ctx.strokeStyle = '#171d38';
  ctx.lineWidth = 7;

  ctx.beginPath();
  ctx.moveTo(pose.anchorX, pose.anchorY);
  ctx.lineTo(endX, endY);
  ctx.stroke();

  ctx.strokeStyle = '#75839b';
  ctx.lineWidth = 3;

  ctx.beginPath();
  ctx.moveTo(pose.anchorX, pose.anchorY);
  ctx.lineTo(endX, endY);
  ctx.stroke();

  const links = Math.max(
    5,
    Math.floor(Math.hypot(dx, dy) / 10)
  );

  for (let i = 0; i <= links; i++) {
    const f = i / links;

    const x = Math.round(
      pose.anchorX + (endX - pose.anchorX) * f
    );

    const y = Math.round(
      pose.anchorY + (endY - pose.anchorY) * f
    );

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle + (i % 2 ? 0 : Math.PI / 2));

    ctx.fillStyle = '#26314a';
    ctx.fillRect(-3, -5, 6, 10);

    ctx.fillStyle = '#a9bfd1';
    ctx.fillRect(-1, -4, 2, 7);

    ctx.restore();
  }

  ctx.fillStyle = '#d5e4eb';
  ctx.fillRect(
    Math.round(pose.anchorX - 7),
    Math.round(pose.anchorY - 3),
    14,
    8
  );

  ctx.fillStyle = '#4b6077';
  ctx.fillRect(
    Math.round(pose.anchorX - 4),
    Math.round(pose.anchorY - 1),
    8,
    4
  );

  ctx.restore();
}

function drawSpecial(obstacle) {
  const pose = specialPose(obstacle);

  const isSaw = obstacle.type === 'saw';
  const img = isSaw ? IMG.crystalSaw : IMG.crystalBlade;

  const size = isSaw ? 88 : 104;
  const glow = isSaw ? '#4deaff' : '#ff58e6';

  if (isSaw) drawChain(pose);

  ctx.save();

  ctx.globalAlpha =
    0.22 + Math.sin(S.t * 5 + obstacle.phase) * 0.07;

  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(pose.x, pose.y, size * 0.63, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();

  ctx.save();

  ctx.translate(Math.round(pose.x), Math.round(pose.y));
  ctx.rotate(pose.rotation);

  ctx.shadowColor = glow;
  ctx.shadowBlur = 20;

  if (ready(img)) {
    ctx.drawImage(img, -size / 2, -size / 2, size, size);
  } else if (isSaw) {
    ctx.fillStyle = '#75839b';
    ctx.strokeStyle = '#17213a';
    ctx.lineWidth = 8;

    ctx.beginPath();
    ctx.arc(0, 0, size * 0.42, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#58eaff';
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.17, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.fillStyle = '#a8b8d1';
    ctx.strokeStyle = '#17213a';
    ctx.lineWidth = 7;

    ctx.beginPath();
    ctx.moveTo(0, -size * 0.48);
    ctx.lineTo(size * 0.17, -size * 0.16);
    ctx.lineTo(size * 0.48, 0);
    ctx.lineTo(size * 0.17, size * 0.16);
    ctx.lineTo(0, size * 0.48);
    ctx.lineTo(-size * 0.17, size * 0.16);
    ctx.lineTo(-size * 0.48, 0);
    ctx.lineTo(-size * 0.17, -size * 0.16);
    ctx.closePath();

    ctx.fill();
    ctx.stroke();
  }

  ctx.restore();

  // Animated crystal sparks.
  for (let i = 0; i < 4; i++) {
    const a =
      S.t * (isSaw ? -1.1 : 1.4) +
      obstacle.phase +
      i * Math.PI / 2;

    const r =
      size * (0.52 + 0.05 * Math.sin(S.t * 3 + i));

    const x = Math.round(pose.x + Math.cos(a) * r);
    const y = Math.round(pose.y + Math.sin(a) * r);

    ctx.fillStyle = i % 2 ? '#ff83f0' : '#80faff';
    ctx.globalAlpha = 0.65 + Math.sin(S.t * 7 + i) * 0.3;

    ctx.fillRect(x - 2, y - 2, 4, 4);
    ctx.fillRect(x - 1, y - 5, 2, 10);
  }

  ctx.globalAlpha = 1;
}

// ---------- Hero ----------
function drawHero() {
  const h = S.hero;
  const img = IMG.hero;

  ctx.save();
  ctx.translate(h.x, h.y);
  ctx.rotate(h.rot);

  if (ready(img)) {
    const fr = HERO_FRAMES[Math.floor(h.frame) % 4];

    const dw = 58;
    const dh = dw * (fr.h / fr.w);

    ctx.drawImage(
      img,
      fr.x,
      fr.y,
      fr.w,
      fr.h,
      -dw / 2,
      -dh / 2,
      dw,
      dh
    );
  } else {
    ctx.fillStyle = '#ffcc44';
    ctx.fillRect(-12, -10, 24, 20);
  }

  ctx.restore();
}

function pixelText(
  txt,
  x,
  y,
  size,
  color = '#fff',
  align = 'center'
) {
  ctx.font = `700 ${size}px Orbitron, monospace`;
  ctx.textAlign = align;

  ctx.fillStyle = '#1a0b2e';
  ctx.fillText(txt, x + 2, y + 2);

  ctx.fillStyle = color;
  ctx.fillText(txt, x, y);
}

// ---------- Main Drawing ----------
function draw() {
  const world = WORLDS[S.worldIdx];

  ctx.save();

  if (S.shake > 0) {
    ctx.translate(
      (Math.random() - 0.5) * S.shake,
      (Math.random() - 0.5) * S.shake
    );
  }

  // Sky.
  if (ready(IMG.sky)) {
    drawLayer(IMG.sky, 0.05, 0, H);
  } else {
    ctx.fillStyle = '#2a1650';
    ctx.fillRect(0, 0, W, H);
  }

  drawLayer(IMG.islands, 0.2, H * 0.35, H * 0.35, 0.65);
  drawLayer(IMG.islands, 0.45, H * 0.58, H * 0.45, 1);

  if (world.tint) {
    ctx.fillStyle = world.tint;
    ctx.fillRect(0, 0, W, H);
  }

  // Ambient drifting motes.
  ctx.fillStyle = world.particle;

  for (const a of S.ambient) {
    const x =
      (((a.x - S.scroll * a.s * 0.3) % W) + W) % W;

    const y = (a.y + S.t * 12 * a.s) % H;

    ctx.globalAlpha =
      0.4 + Math.sin(S.t * 2 + a.p) * 0.3;

    ctx.fillRect(x | 0, y | 0, 2, 2);
  }

  ctx.globalAlpha = 1;

  for (const p of S.pillars) {
    drawPillar(p);
  }

  for (const obstacle of S.specials) {
    drawSpecial(obstacle);
  }

  for (const g of S.gems) {
    if (g.got) continue;

    const gx = g.x - S.scroll;
    const gy = g.y + Math.sin(S.t * 3 + g.t) * 5;

    ctx.save();

    ctx.shadowColor = '#7ff6ff';
    ctx.shadowBlur = 16;

    if (ready(IMG.gem)) {
      ctx.drawImage(IMG.gem, gx - 13, gy - 13, 26, 26);
    }

    ctx.restore();
  }

  if (S.mode === 'play' && S.safeTime > 0) {
    ctx.save();

    ctx.globalAlpha =
      0.18 + Math.sin(S.t * 9) * 0.06;

    ctx.strokeStyle = '#a4faff';
    ctx.lineWidth = 2;

    ctx.shadowColor = '#6fefff';
    ctx.shadowBlur = 14;

    ctx.beginPath();
    ctx.arc(S.hero.x, S.hero.y, 34, 0, Math.PI * 2);
    ctx.stroke();

    ctx.restore();
  }

  drawHero();

  for (const p of S.parts) {
    ctx.globalAlpha = Math.min(1, p.life * 2);
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x | 0, p.y | 0, p.size, p.size);
  }

  ctx.globalAlpha = 1;

  // Bottom fog.
  const fog = ctx.createLinearGradient(
    0,
    H - 120,
    0,
    H
  );

  fog.addColorStop(0, 'rgba(0,0,0,0)');
  fog.addColorStop(1, world.fog + '88');

  ctx.fillStyle = fog;
  ctx.fillRect(0, H - 120, W, 120);

  ctx.restore();

  if (S.flash > 0) {
    ctx.fillStyle = `rgba(255,255,255,${S.flash * 0.6})`;
    ctx.fillRect(0, 0, W, H);
  }

  drawHUD(world);
}

// ---------- HUD ----------
function drawHUD(world) {
  const top = H * 0.05;

  pixelText(
    muted ? '♪×' : '♪',
    W - 28,
    top + 26,
    20,
    muted ? '#888' : '#fff'
  );

  pixelText(
    String(S.score),
    W / 2,
    top + 50,
    44
  );

  pixelText(
    `◆ ${S.crystals}`,
    20,
    top + 26,
    16,
    '#7ff6ff',
    'left'
  );

  if (S.banner > 0 && S.mode === 'play') {
    ctx.globalAlpha = Math.min(1, S.banner);

    pixelText(
      `WORLD ${S.worldIdx + 1}`,
      W / 2,
      H * 0.3,
      16,
      world.fog
    );

    pixelText(
      world.name.toUpperCase(),
      W / 2,
      H * 0.3 + 30,
      24,
      '#fff'
    );

    ctx.globalAlpha = 1;
  }

  if (S.specialBanner > 0 && S.mode === 'play') {
    ctx.globalAlpha = Math.min(1, S.specialBanner);

    pixelText(
      S.specialName,
      W / 2,
      H * 0.37,
      14,
      '#7ff6ff'
    );

    ctx.globalAlpha = 1;
  }

  if (S.mode === 'over') {
    ctx.fillStyle = 'rgba(20,8,40,0.7)';
    ctx.fillRect(40, H * 0.3, W - 80, 220);

    ctx.strokeStyle = '#7ff6ff';
    ctx.lineWidth = 3;
    ctx.strokeRect(40, H * 0.3, W - 80, 220);

    pixelText(
      'GAME OVER',
      W / 2,
      H * 0.3 + 45,
      28,
      '#ff6ad5'
    );

    pixelText(
      `SCORE ${S.score}`,
      W / 2,
      H * 0.3 + 90,
      18
    );

    pixelText(
      `CRYSTALS ${S.crystals}`,
      W / 2,
      H * 0.3 + 120,
      18,
      '#7ff6ff'
    );

    pixelText(
      'RUN COMPLETE',
      W / 2,
      H * 0.3 + 150,
      16,
      '#ffe27a'
    );

    pixelText(
      'RETURNING TO HOME',
      W / 2,
      H * 0.3 + 195,
      13
    );
  }
}

// ---------- Fixed Timestep Game Loop ----------
let last = performance.now();

function loop(now) {
  const frameTime = Math.max(0, (now - last) / 1000);
  last = now;

  if (S.mode === 'suspended') {
    S.accumulator = 0;
    requestAnimationFrame(loop);
    return;
  }

  // Add real elapsed frame time to the simulation accumulator.
  S.accumulator += frameTime;

  // Run gameplay only in fixed 1/60-second steps.
  while (S.accumulator >= FIXED_DT) {
    update(FIXED_DT);
    S.accumulator -= FIXED_DT;

    if (S.mode === 'suspended') {
      S.accumulator = 0;
      break;
    }
  }

  draw();

  requestAnimationFrame(loop);
}

requestAnimationFrame(loop);
  
