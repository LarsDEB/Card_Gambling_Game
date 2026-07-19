// global variables
const STATE = {
  PLAYING: 'playing',
  REVIEW: 'review',
  DEALING: 'dealing',
  COLLECTING: 'collecting',
  GAME_OVER: 'game_over',
};
const COLORS = ['red', 'green', 'blue', 'yellow', 'black'];
const CONFETTI_COLORS = ['#f0c419', '#963126', '#007e34', '#0070bb', '#fae900', '#ffffff'];
const DEAL_STAGGER = 40;
const STAKE = 2;
const START_MONEY = 20;
// Only for development. Set this to false before publishing the game.
const DEBUG = false;

const DECK = createDeck();

let cardAspect = 160 / 220;

// update if the new-round-button is disabled or not.
function updateNewRoundButton() {
  const roundBtn = document.getElementById('new-round-btn');

  roundBtn.disabled = state !== STATE.REVIEW;
}

// Computes the largest card size that lets the whole grid (all cards, in
// however many rows the auto-fill grid ends up with) fit on screen without
// needing to scroll, and writes it to the --card-width/--card-height vars.
function fitCardSize() {
  const container = document.querySelector('.container');
  const grid = document.getElementById('grid');
  if (!container || !grid) return;

  const n = DECK.length;
  const gridStyle = getComputedStyle(grid);
  const gap = parseFloat(gridStyle.rowGap || gridStyle.gap) || 12;

  const availableWidth = container.clientWidth;
  const usedAbove = grid.getBoundingClientRect().top;
  const availableHeight = window.innerHeight - usedAbove - 24; // small bottom buffer

  const maxWidth = 160;
  const minWidth = 44;

  let bestWidth = minWidth;

  for (let width = maxWidth; width >= minWidth; width -= 2) {
    const cols = Math.max(1, Math.floor((availableWidth + gap) / (width + gap)));
    const rows = Math.ceil(n / cols);
    const height = width / cardAspect;
    const totalHeight = rows * height + gap * (rows - 1);

    if (totalHeight <= availableHeight) {
      bestWidth = width;
      break;
    }
  }

  document.documentElement.style.setProperty('--card-width', `${bestWidth}px`);
  document.documentElement.style.setProperty(
    '--card-height',
    `${Math.round(bestWidth / cardAspect)}px`
  );
}

let resizeTimeout = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(fitCardSize, 120);
});

// global variables
let cardEls = []; // persistent card elements, index === deck/grid position
let flippedCards = []; // DOM elements currently selected (in slots / center)
let money = null;
let round = 1;
let state = STATE.PLAYING;
let effectCanvas;
let effectContext;
let particleFrame = null;
let particlePool = [];

const PARTICLE_POOL_SIZE = 760;

// functions
function createDeck() {
  const deck = [];

  deck.push(...Array(2).fill('black'));
  deck.push(...Array(4).fill('red'));
  deck.push(...Array(4).fill('green'));
  deck.push(...Array(4).fill('blue'));
  deck.push(...Array(4).fill('yellow'));

  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const random = Math.floor(Math.random() * (i + 1));

    [arr[i], arr[random]] = [arr[random], arr[i]];
  }
}

// Moves `el` into `toParent`, keeping it visually in place, then animates
// it to its new position/size (FLIP technique).
function flipMove(el, toParent, onDone) {
  const first = el.getBoundingClientRect();

  toParent.appendChild(el);

  const last = el.getBoundingClientRect();

  const dx = first.left - last.left;
  const dy = first.top - last.top;
  const sx = first.width / last.width;
  const sy = first.height / last.height;

  el.classList.add('flying');
  el.style.transformOrigin = 'top left';
  el.style.transition = 'none';
  el.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      el.style.transition = 'transform 0.6s ease';
      el.style.transform = '';
    });
  });

  const handler = (e) => {
    if (e.propertyName !== 'transform') return;
    el.removeEventListener('transitionend', handler);
    el.classList.remove('flying');
    el.style.transition = '';
    el.style.transformOrigin = '';
    if (onDone) onDone();
  };
  el.addEventListener('transitionend', handler);
}

// Moves several elements into `toParent` at once and animates all of them
// together (batched FLIP). Measuring/appending/animating as a batch avoids
// stale position data: if elements were moved one at a time into a flexbox,
// earlier ones would get a wrong target rect since the layout keeps
// shifting as later siblings are added, causing a visible jump.
function flipMoveBatch(elements, toParent, onAllDone) {
  const firsts = elements.map((el) => el.getBoundingClientRect());

  elements.forEach((el) => toParent.appendChild(el));

  const lasts = elements.map((el) => el.getBoundingClientRect());

  let pending = elements.length;

  elements.forEach((el, i) => {
    const first = firsts[i];
    const last = lasts[i];

    const dx = first.left - last.left;
    const dy = first.top - last.top;
    const sx = first.width / last.width;
    const sy = first.height / last.height;

    el.classList.add('flying');
    el.style.transformOrigin = 'top left';
    el.style.transition = 'none';
    el.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
  });

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      elements.forEach((el) => {
        el.style.transition = 'transform 0.6s ease';
        el.style.transform = '';
      });
    });
  });

  elements.forEach((el) => {
    const handler = (e) => {
      if (e.propertyName !== 'transform') return;
      el.removeEventListener('transitionend', handler);
      el.classList.remove('flying');
      el.style.transition = '';
      el.style.transformOrigin = '';
      pending -= 1;
      if (pending === 0 && onAllDone) onAllDone();
    };
    el.addEventListener('transitionend', handler);
  });
}

// Builds the physical card elements once. They are reused/reshuffled for
// every round instead of being recreated, so they can be animated back to
// the stack and dealt out again.
function buildCardElements() {
  cardEls = DECK.map(() => {
    const card = document.createElement('div');
    card.classList.add('card');

    const inner = document.createElement('div');
    inner.classList.add('card-inner');

    const front = document.createElement('div');
    front.classList.add('card-front');

    const back = document.createElement('div');
    back.classList.add('card-back');

    inner.append(front, back);
    card.append(inner);

    const cardObj = { el: card, front };

    card.addEventListener('click', () => {
      if (state !== STATE.PLAYING) return;
      if (card.classList.contains('flipped')) return;

      card.classList.add('flipped');

      // lock in the selection (and block further clicks) immediately, even
      // though the card only visually flies to its slot a bit later
      const slotIndex = flippedCards.length;
      flippedCards.push(card);
      const isThird = flippedCards.length === 3;

      if (isThird) {
        state = STATE.COLLECTING;
        updateNewRoundButton();
      }

      setTimeout(() => {
        const grid = document.getElementById('grid');
        const slot = document.querySelectorAll('.slot')[slotIndex];

        const index = [...grid.children].indexOf(card);

        flipMove(card, slot);

        const placeholder = document.createElement('div');
        placeholder.classList.add('card', 'placeholder');
        grid.insertBefore(placeholder, grid.children[index] ?? null);

        setTimeout(() => slot.classList.add('invisible'), 650);

        if (isThird) {
          setTimeout(collectAndReveal, 650);
        }
      }, 650);
    });

    return cardObj;
  });
}

// Applies a (shuffled) color order to the persistent card elements.
function assignColors(colors) {
  cardEls.forEach((card, i) => {
    const color = colors[i];
    COLORS.forEach((c) => card.front.classList.remove(c));
    card.front.classList.add(color);
    card.front.textContent = color;
    card.el.classList.remove('flipped');
    card.el.style.transform = '';
  });
}

function collectAndReveal() {
  const stack = document.getElementById('stack');
  const grid = document.getElementById('grid');

  // starting at index 0; each card leaves a placeholder behind so the
  // others don't shift into the freed-up grid cell
  const remaining = cardEls.filter((c) => !flippedCards.includes(c.el));

  let pending = remaining.length;

  if (pending === 0) {
    revealCenter();
    return;
  }

  remaining.forEach((card, i) => {
    setTimeout(() => {
      const placeholder = document.createElement('div');
      placeholder.classList.add('card', 'placeholder');
      const index = [...grid.children].indexOf(card.el);
      grid.insertBefore(placeholder, grid.children[index] ?? null);

      flipMove(card.el, stack, () => {
        pending -= 1;
        if (pending === 0) revealCenter();
      });
    }, i * DEAL_STAGGER);
  });
}

// Positions the center-display so its top aligns with the grid's top edge
// - the grid is already sized/positioned to fit the viewport (fitCardSize),
// so reusing that reference point is simpler and more robust than
// recomputing available space here. Must run before the cards start flying.
function positionCenterDisplay() {
  const centerDisplay = document.getElementById('center-display');
  const grid = document.getElementById('grid');

  const gridTop = grid.getBoundingClientRect().top;

  centerDisplay.style.top = `${gridTop}px`;
  centerDisplay.style.transform = 'translate(-50%, 0)';
}

// Moves the 3 selected cards from their slots into the center display, all
// together (so they land as a stable group with no mid-flight layout jump).
// The win/lose glow fades in during the flight, but the message text only
// pops in once the cards have actually landed - otherwise they'd slide
// right over it, which looks off.
function revealCenter() {
  const centerCards = document.getElementById('center-cards');
  const { payout, tag } = evaluate(flippedCards);

  applyResultEffects(payout, tag);
  positionCenterDisplay();

  flipMoveBatch(flippedCards, centerCards, () => {
    state = STATE.REVIEW;
    updateNewRoundButton();

    const message = document.getElementById('message');
    message.classList.add('visible');
    void message.offsetWidth; // restart the pop-in animation
    message.classList.add('pop');

    if (payout === 0) {
      // trigger the shake only now: while the cards are still flying, the
      // inline FLIP transform would just override/hide a CSS animation
      centerCards.classList.add(tag === 'nearMiss' ? 'shake-hard' : 'shake');
      setTimeout(() => centerCards.classList.remove('shake', 'shake-hard'), 600);
    }
  });
}

function applyResultEffects(payout, tag) {
  const message = document.getElementById('message');
  const centerDisplay = document.getElementById('center-display');

  // the raw payout is what gets shown/celebrated - deliberately not the net
  // (payout minus the stake already paid in dealOut). A "pair" pays out
  // less than the stake but still gets the full win treatment.
  setMoney(money + payout);

  const isWin = payout > 0;

  if (tag === 'nearMiss') {
    message.textContent = 'So knapp am Jackpot vorbei! Nichts gewonnen.';
  } else if (tag === 'none') {
    message.textContent = 'Nichts gewonnen.';
  } else if (isWin) {
    message.textContent = `Gewinn: +${payout}€`;
  }

  message.classList.remove('win', 'lose', 'pop', 'visible');
  message.classList.add(isWin ? 'win' : 'lose');

  // triggers the box-shadow / shake CSS transitions, which fade in over the
  // same 0.6s as the flight to the center
  centerDisplay.classList.add(isWin ? 'result-win' : 'result-lose');

  if (isWin) {
    winEffect(tag, payout);
  } else {
    loseEffect(tag === 'nearMiss');
  }
}

// Suchfaktor-Design: 2 schwarze Karten sind der seltene Jackpot, 1 schwarze
// Karte ohne Paar ist der "Beinahe-Jackpot"-Beinahe-Verlust. Der Einsatz
// wird separat beim Austeilen abgezogen (siehe dealOut) - hier wird nur der
// rohe Gewinn zurückgegeben, der in der Nachricht auch so angezeigt wird.
// Das "Paar" zahlt absichtlich weniger als den Einsatz zurueck: es wird als
// Gewinn gefeiert (Konfetti, gruen), obwohl es netto ein Verlust ist - der
// klassische Slot-Machine-Trick "Loss Disguised as Win".
function evaluate(flippedCards) {
  const counts = {};
  for (const card of flippedCards) {
    const color = card.querySelector('.card-front').textContent;
    counts[color] = (counts[color] || 0) + 1;
  }

  const blackCount = counts.black || 0;
  const hasTriple = Object.values(counts).includes(3);
  const hasPair = Object.values(counts).includes(2);

  if (blackCount === 2) return { payout: 40, tag: 'jackpot' };
  if (hasTriple) return { payout: 10, tag: 'triple' };
  if (blackCount === 1 && hasPair) return { payout: 4, tag: 'nearMissPair' };
  if (hasPair) return { payout: 1, tag: 'pair' };
  if (blackCount === 1) return { payout: 0, tag: 'nearMiss' };
  return { payout: 0, tag: 'none' };
}

function setMoney(value) {
  money = value;
  const el = document.getElementById('money');
  el.textContent = `${money}€`;
  el.classList.remove('bump');
  void el.offsetWidth; // restart the bump animation
  el.classList.add('bump');
}

function setupEffects() {
  effectCanvas = document.getElementById('effects-canvas');
  effectContext = effectCanvas.getContext('2d');
  particlePool = Array.from({ length: PARTICLE_POOL_SIZE }, () => ({ active: false }));
  resizeEffectsCanvas();
  window.addEventListener('resize', resizeEffectsCanvas);
}

function resizeEffectsCanvas() {
  if (!effectCanvas) return;
  const scale = window.devicePixelRatio || 1;
  effectCanvas.width = Math.round(window.innerWidth * scale);
  effectCanvas.height = Math.round(window.innerHeight * scale);
  effectContext.setTransform(scale, 0, 0, scale, 0, 0);
}

function restartEffectLayer(id, ...classes) {
  const layer = document.getElementById(id);
  layer.className = layer.className.split(' ')[0];
  void layer.offsetWidth;
  layer.classList.add('active', ...classes);
  return layer;
}

function launchConfetti(count, tag) {
  const isJackpot = tag === 'jackpot';
  const isTriple = tag === 'triple';
  const now = performance.now();
  const width = window.innerWidth;
  const height = window.innerHeight;
  const shapes = ['circle', 'star', 'ribbon', 'square'];

  particlePool.forEach((particle, index) => {
    if (index >= count) {
      particle.active = false;
      return;
    }
    particle.active = true;
    particle.startsAt = now + Math.random() * (isJackpot ? 1350 : isTriple ? 650 : 300);
    particle.duration = (isJackpot ? 3800 : isTriple ? 3000 : 2400) + Math.random() * 1300;
    particle.x = width * (0.2 + Math.random() * 0.6);
    particle.y = height + 28;
    particle.vx = (Math.random() - 0.5) * (isJackpot ? 1250 : isTriple ? 900 : 680);
    particle.vy = -(isJackpot ? 1200 : isTriple ? 1000 : 760) - Math.random() * 520;
    particle.gravity = isJackpot ? 760 : 680;
    particle.rotation = Math.random() * Math.PI * 2;
    particle.spin = (Math.random() - 0.5) * 15;
    particle.size = (isJackpot ? 10 : 8) + Math.random() * 10;
    particle.color = CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];
    particle.shape = shapes[Math.floor(Math.random() * shapes.length)];
  });

  if (!particleFrame) particleFrame = requestAnimationFrame(renderParticles);
}

function renderParticles(now) {
  const width = window.innerWidth;
  const height = window.innerHeight;
  effectContext.clearRect(0, 0, width, height);
  let needsNextFrame = false;

  particlePool.forEach((particle) => {
    if (!particle.active) return;
    if (now < particle.startsAt) {
      needsNextFrame = true;
      return;
    }
    const elapsed = now - particle.startsAt;
    if (elapsed > particle.duration) {
      particle.active = false;
      return;
    }
    const seconds = elapsed / 1000;
    const opacity = Math.min(1, elapsed / 110) * Math.min(1, (particle.duration - elapsed) / 500);
    const x = particle.x + particle.vx * seconds;
    const y = particle.y + particle.vy * seconds + 0.5 * particle.gravity * seconds * seconds;
    effectContext.save();
    effectContext.globalAlpha = opacity;
    effectContext.fillStyle = particle.color;
    effectContext.translate(x, y);
    effectContext.rotate(particle.rotation + particle.spin * seconds);
    drawParticle(particle);
    effectContext.restore();
    needsNextFrame = true;
  });

  particleFrame = needsNextFrame ? requestAnimationFrame(renderParticles) : null;
}

function drawParticle(particle) {
  const size = particle.size;
  if (particle.shape === 'circle') {
    effectContext.beginPath();
    effectContext.ellipse(0, 0, size * 0.55, size * 0.32, 0, 0, Math.PI * 2);
    effectContext.fill();
  } else if (particle.shape === 'star') {
    effectContext.beginPath();
    for (let point = 0; point < 10; point += 1) {
      const radius = point % 2 === 0 ? size * 0.7 : size * 0.28;
      const angle = -Math.PI / 2 + (point * Math.PI) / 5;
      effectContext.lineTo(Math.cos(angle) * radius, Math.sin(angle) * radius);
    }
    effectContext.fill();
  } else {
    effectContext.fillRect(
      -size / (particle.shape === 'ribbon' ? 4 : 2),
      -size,
      particle.shape === 'ribbon' ? size / 2 : size,
      size * (particle.shape === 'ribbon' ? 2 : 1)
    );
  }
}

function winEffect(tag, payout) {
  const isJackpot = tag === 'jackpot';
  const isTriple = tag === 'triple';
  const isMajorWin = isJackpot || isTriple;

  // Only the Dreier and jackpot earn the full-screen flash + banner; smaller
  // wins just get confetti so they don't feel as heavy-handed.
  if (isMajorWin) {
    restartEffectLayer('win-flash-layer', 'major', ...(isJackpot ? ['jackpot'] : []));

    const banner = document.getElementById('win-banner');
    banner.textContent = isJackpot ? 'JACKPOT!' : 'DREIER!';
    restartEffectLayer('win-banner', isJackpot ? 'jackpot' : 'triple');
  }

  if (isJackpot) createJackpotOverload(payout);

  const pieceCount = isJackpot ? 260 : isTriple ? 160 : 90;
  launchConfetti(pieceCount, tag);
}

function createJackpotOverload(payout) {
  const spectacle = document.getElementById('jackpot-spectacle');

  spectacle.querySelectorAll('.jackpot-burst').forEach((burst) => {
    burst.style.left = `${8 + Math.random() * 84}%`;
    burst.style.top = `${12 + Math.random() * 66}%`;
    burst.style.setProperty('--burst-delay', `${Math.random() * 1.4}s`);
    burst.style.setProperty('--burst-size', `${180 + Math.random() * 260}px`);
  });

  const echoes = spectacle.querySelectorAll('.jackpot-echo');
  const echoTexts = ['JACKPOT!', `${payout}€`, 'JACKPOT!'];
  echoes.forEach((echo, index) => {
    echo.textContent = echoTexts[index] ?? 'JACKPOT!';
    echo.style.setProperty('--echo-delay', `${0.25 + index * 0.42}s`);
    echo.style.setProperty('--echo-turn', `${index % 2 === 0 ? -1 : 1}deg`);
  });

  restartEffectLayer('jackpot-spectacle');
  setTimeout(() => restartEffectLayer('jackpot-spectacle'), 1000);
  setTimeout(() => restartEffectLayer('jackpot-spectacle'), 1000);
  setTimeout(() => spectacle.classList.remove('active'), 4800);

  const game = document.querySelector('.container');
  game.classList.remove('jackpot-shake');
  void game.offsetWidth;
  game.classList.add('jackpot-shake');
  setTimeout(() => game.classList.remove('jackpot-shake'), 1800);
}

function loseEffect(hard) {
  restartEffectLayer('lose-flash-layer', ...(hard ? ['hard'] : []));
}

// Animates the 3 revealed cards back onto the stack, then deals the whole
// (reshuffled) deck from the stack out onto the grid.
function startNewRound() {
  if (state === STATE.DEALING) return;

  state = STATE.DEALING;
  updateNewRoundButton();

  // pop the message away right as the cards start leaving, instead of
  // letting it linger until the whole round-reset is done
  document.getElementById('message').classList.remove('visible');

  const stack = document.getElementById('stack');
  const grid = document.getElementById('grid');
  const centerCards = flippedCards.slice();

  const dealOut = () => {
    if (money < STAKE) {
      triggerGameOver();
      return;
    }

    grid.innerHTML = '';
    document.getElementById('message').textContent = '';
    document.getElementById('message').classList.remove('win', 'lose', 'pop', 'visible');
    document.getElementById('center-display').classList.remove('result-win', 'result-lose');
    document.getElementById('center-display').style.top = '';
    document.getElementById('center-display').style.transform = '';
    document.querySelectorAll('.slot').forEach((s, index) => {
      s.innerHTML = '';
      s.style.setProperty('--slot-delay', `${index * 110}ms`);
      s.classList.remove('invisible', 'dealing');
      // Force the reset to be painted first; otherwise the browser would
      // merge both class changes and skip the entrance animation.
      void s.offsetWidth;
      s.classList.add('dealing');
    });

    setMoney(money - STAKE);

    shuffle(DECK);
    assignColors(DECK);
    flippedCards = [];

    cardEls.forEach((card, i) => {
      setTimeout(() => {
        flipMove(card.el, grid);
      }, i * DEAL_STAGGER);
    });

    setTimeout(
      () => {
        state = STATE.PLAYING;
        updateNewRoundButton();
      },
      cardEls.length * DEAL_STAGGER + 650
    );
  };

  if (centerCards.length === 0) {
    // very first deal: nothing to return, cards start life on the stack
    cardEls.forEach((card) => stack.appendChild(card.el));
    dealOut();
    return;
  }

  centerCards.forEach((card) => card.classList.remove('flipped'));
  flipMoveBatch(centerCards, stack, dealOut);
}

function triggerGameOver() {
  state = STATE.GAME_OVER;
  updateNewRoundButton();

  const message = document.getElementById('message');
  message.textContent = 'GAME OVER - kein Guthaben mehr!';
  message.classList.remove('win', 'lose', 'pop');
  message.classList.add('game-over', 'visible');
  void message.offsetWidth;
  message.classList.add('pop');
}

// Lets us inspect every result effect without playing through rounds or
// changing the actual balance/round state.
function previewResult({ payout, tag, label }) {
  const message = document.getElementById('message');
  const centerDisplay = document.getElementById('center-display');
  const isWin = payout > 0;

  message.textContent = label;
  message.classList.remove('win', 'lose', 'pop', 'visible');
  message.classList.add(isWin ? 'win' : 'lose', 'visible');
  void message.offsetWidth;
  message.classList.add('pop');

  centerDisplay.classList.remove('result-win', 'result-lose');
  centerDisplay.classList.add(isWin ? 'result-win' : 'result-lose');

  if (isWin) {
    winEffect(tag, payout);
  } else {
    loseEffect(tag === 'nearMiss');
  }

  setTimeout(() => centerDisplay.classList.remove('result-win', 'result-lose'), 3000);
}

function setupDebugControls() {
  if (!DEBUG) return document.querySelector('#debug-controls').classList.add('hidden');

  const controls = document.getElementById('debug-controls');
  const events = [
    { payout: 40, tag: 'jackpot', label: 'Test: JACKPOT!' },
    { payout: 10, tag: 'triple', label: 'Test: Dreier' },
    { payout: 4, tag: 'nearMissPair', label: 'Test: Beinahe-Jackpot mit Paar' },
    { payout: 1, tag: 'pair', label: 'Test: Paar' },
    { payout: 0, tag: 'nearMiss', label: 'Test: So knapp am Jackpot vorbei!' },
    { payout: 0, tag: 'none', label: 'Test: Nichts gewonnen.' },
  ];

  events.forEach((event) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = event.label.replace('Test: ', '');
    button.addEventListener('click', () => previewResult(event));
    controls.appendChild(button);
  });

  controls.hidden = false;
}

function newRound() {
  if (state !== STATE.REVIEW) return;
  round += 1;
  document.getElementById('round').textContent = round;
  startNewRound();
}

function newGame() {
  if (state === STATE.DEALING) return;
  document.getElementById('message').classList.remove('game-over');
  setMoney(START_MONEY);
  round = 1;
  document.getElementById('round').textContent = round;
  startNewRound();
}

document.querySelector('#new-game-btn').addEventListener('click', () => {
  newGame();
});

document.querySelector('#new-round-btn').addEventListener('click', () => {
  newRound();
});

fitCardSize();
setupEffects();
buildCardElements();
setupDebugControls();
newGame();
