/* =====================================================================
   CARD GAMBLING GAME
   ---------------------------------------------------------------------
   Quick overview of a round's flow, to make the code below easier to
   navigate:

     1. dealOut()            - the stake is deducted, the deck is
                                reshuffled, all cards fly from the stack
                                into the grid.
     2. Clicking 3 cards      - each clicked card flies into one of the
                                3 slots up top; its spot in the grid stays
                                behind as an invisible placeholder.
     3. collectAndReveal()   - the remaining (unpicked) cards fly back
                                onto the stack.
     4. revealCenter()       - the 3 picked cards fly big into the
                                center, the result gets evaluated and
                                celebrated/mourned.
     5. startNewRound()      - everything flies back onto the stack,
                                then it's back to step 1.

   The file is organized into the following sections:
     1. Configuration & balancing
     2. Global state
     3. Deck helpers
     4. Layout (card size, positioning)
     5. FLIP animation helpers
     6. Card DOM & selection logic (click handler)
     7. Round flow: collecting, evaluating, showing the result
     8. Win/lose effects (canvas confetti, reused DOM layers)
     9. Round transitions (new round / new game / game over)
    10. Debug tools
    11. Bootstrap
   ===================================================================== */

/* ---------------------------------------------------------------------
   1. CONFIGURATION & BALANCING
   ------------------------------------------------------------------ */

const STATE = {
  PLAYING: 'playing', // cards are in the grid, clicking is allowed
  COLLECTING: 'collecting', // 3rd card picked, the rest fly to the stack
  REVIEW: 'review', // result is showing, "New round" is enabled
  DEALING: 'dealing', // cards are flying (returning to / dealt from the stack)
  GAME_OVER: 'game_over', // not enough money left for the next stake
};

// Only 3 colors + black instead of 4 colors + black: fewer "buckets"
// means noticeably higher pair/triple odds, so the game doesn't feel
// like it's always "3 different colors or a single black card".
const COLORS = ['red', 'green', 'blue', 'black'];
const DECK_COMPOSITION = { red: 5, green: 5, blue: 5, black: 3 }; // 18 cards

const CONFETTI_COLORS = ['#f0c419', '#963126', '#007e34', '#0070bb', '#fae900', '#ffffff'];
const PARTICLE_POOL_SIZE = 760;

const DEAL_STAGGER = 40; // ms between individual cards while dealing
const STAKE = 2; // stake per round, in play currency
const START_MONEY = 20;

// Development only - set to false before presenting.
const DEBUG = false;

// Payout table. The stake is deducted separately in dealOut(); this only
// holds the raw payout, which is also what the message shows. "pair"
// deliberately pays out less than the stake, but still gets the full win
// treatment (confetti, green) - the classic slot-machine trick "Loss
// Disguised as Win". With the deck distribution below (3 colors x 5 +
// 3 black out of 18 cards) the expected value works out slightly
// negative (~ -0.27 per round): you lose slowly on average, while
// individual rounds can swing hard either way.
const PAYOUTS = {
  megaJackpot: 80, // 3x black (~0.1%) - a rare mega event
  jackpot: 15, // 2x black (~5.5%)
  triple: 6, // 3 matching colors, no black (~3.7%)
  nearMissPair: 2, // 1x black + a pair (~11%)
  pair: 1, // pair without black (~37%) - the "feels like a win" case
  nearMiss: 0, // 1x black, no pair (~28%) - the "so close" tease
  none: 0, // no match at all (~15%)
};

/* ---------------------------------------------------------------------
   2. GLOBAL STATE
   ------------------------------------------------------------------ */

const DECK = createDeck();

let cardEls = []; // persistent card DOM elements, index = deck position
let flippedCards = []; // currently picked cards (in slots / center)
let money = null;
let round = 1;
let state = STATE.PLAYING;

let cardAspect = 160 / 220; // width/height ratio of a card
let resizeTimeout = null;

// Canvas particle system for confetti (see section 8)
let effectCanvas;
let effectContext;
let particleFrame = null;
let particlePool = [];

/* ---------------------------------------------------------------------
   3. DECK HELPERS
   ------------------------------------------------------------------ */

function createDeck() {
  const deck = [];
  for (const [color, count] of Object.entries(DECK_COMPOSITION)) {
    deck.push(...Array(count).fill(color));
  }
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const random = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[random]] = [arr[random], arr[i]];
  }
}

/* ---------------------------------------------------------------------
   4. LAYOUT
   ------------------------------------------------------------------ */

// Computes the largest card size that lets the whole grid (all cards, in
// however many rows the auto-fill grid ends up with) fit in the viewport
// without scrolling, and writes it to the --card-width/--card-height CSS
// variables.
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

// Positions the center display (message + big cards) so its top aligns
// with the grid's top edge - the grid is already sized/positioned to fit
// the viewport by fitCardSize(), so reusing that reference point is
// simpler than recomputing it here. Must run before the cards start
// flying.
function positionCenterDisplay() {
  const centerDisplay = document.getElementById('center-display');
  const grid = document.getElementById('grid');
  const gridTop = grid.getBoundingClientRect().top;

  centerDisplay.style.top = `${gridTop}px`;
  centerDisplay.style.transform = 'translate(-50%, 0)';
}

window.addEventListener('resize', () => {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(fitCardSize, 120);
});

/* ---------------------------------------------------------------------
   5. FLIP ANIMATION HELPERS
   ------------------------------------------------------------------ */

// Moves `el` seamlessly to `toParent`: records its current position,
// reparents it, then animates from the old spot to the new one (the FLIP
// technique: First, Last, Invert, Play).
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

// Moves several elements at once (batched FLIP). Measure ALL starting
// positions first, THEN append all of them, THEN measure the target
// positions - otherwise appending one at a time (e.g. into a flexbox)
// would reflow the already-moved elements' layout on every step, causing
// visible jumps.
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

/* ---------------------------------------------------------------------
   6. CARD DOM & SELECTION LOGIC
   ------------------------------------------------------------------ */

// Builds the physical card DOM elements once. They get reused/reshuffled
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

    card.addEventListener('click', () => handleCardClick(cardObj));

    return cardObj;
  });
}

// Handles a click on a card in the grid: picks it. The actual flight to
// its slot is deliberately delayed by 650ms so the revealed color is
// visible for a moment where it is - but the selection and state change
// (locking further clicks) happen IMMEDIATELY, so a 4th card can't be
// picked during that delay.
function handleCardClick(card) {
  if (state !== STATE.PLAYING) return;
  if (card.el.classList.contains('flipped')) return;

  card.el.classList.add('flipped');

  const slotIndex = flippedCards.length;
  flippedCards.push(card.el);
  const isThird = flippedCards.length === 3;

  if (isThird) {
    state = STATE.COLLECTING;
    syncInteractionState();
  }

  setTimeout(() => {
    const grid = document.getElementById('grid');
    const slot = document.querySelectorAll('.slot')[slotIndex];
    const index = [...grid.children].indexOf(card.el);

    flipMove(card.el, slot);

    // Placeholder at the card's original grid position, so the other
    // cards don't shift into the gap.
    const placeholder = document.createElement('div');
    placeholder.classList.add('card', 'placeholder');
    grid.insertBefore(placeholder, grid.children[index] ?? null);

    setTimeout(() => slot.classList.add('invisible'), 650);

    if (isThird) {
      setTimeout(collectAndReveal, 650);
    }
  }, 650);
}

// Assigns a (shuffled) color order to the persistent card elements,
// without recreating them.
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

/* ---------------------------------------------------------------------
   7. ROUND FLOW: COLLECTING, EVALUATING, SHOWING THE RESULT
   ------------------------------------------------------------------ */

// The unpicked cards fly back onto the stack, starting at index 0. Each
// one leaves behind a placeholder (just like on click), so the remaining
// cards don't shift.
function collectAndReveal() {
  const stack = document.getElementById('stack');
  const grid = document.getElementById('grid');

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

// Moves the 3 picked cards from their slots into the center display
// together (batched, so they land as a stable group instead of jumping
// mid-flight). The win/lose glow fades in during the flight, but the
// message text only pops in once the cards have actually landed -
// otherwise they'd slide right over it.
function revealCenter() {
  const centerCards = document.getElementById('center-cards');
  const { payout, tag } = evaluate(flippedCards);

  applyResultEffects(payout, tag);
  positionCenterDisplay();

  flipMoveBatch(flippedCards, centerCards, () => {
    state = STATE.REVIEW;
    syncInteractionState();

    const message = document.getElementById('message');
    message.classList.add('visible');
    void message.offsetWidth; // restart the pop-in animation
    message.classList.add('pop');

    if (payout === 0) {
      // Trigger the shake only now: while the cards are still flying,
      // the inline FLIP transform would just override/hide a CSS
      // animation.
      centerCards.classList.add(tag === 'nearMiss' ? 'shake-hard' : 'shake');
      setTimeout(() => centerCards.classList.remove('shake', 'shake-hard'), 600);
    }
  });
}

// Evaluates 3 revealed cards. Special rules for the addictiveness factor:
// 3x black is the rare mega event, 2x black is the jackpot, and 1x black
// without a pair is the "so close to the jackpot" near-miss.
function evaluate(flippedCards) {
  const counts = {};
  for (const card of flippedCards) {
    const color = card.querySelector('.card-front').textContent;
    counts[color] = (counts[color] || 0) + 1;
  }

  const blackCount = counts.black || 0;
  const hasTriple = Object.values(counts).includes(3);
  const hasPair = Object.values(counts).includes(2);

  if (blackCount === 3) return { payout: PAYOUTS.megaJackpot, tag: 'megaJackpot' };
  if (blackCount === 2) return { payout: PAYOUTS.jackpot, tag: 'jackpot' };
  if (hasTriple) return { payout: PAYOUTS.triple, tag: 'triple' };
  if (blackCount === 1 && hasPair) return { payout: PAYOUTS.nearMissPair, tag: 'nearMissPair' };
  if (hasPair) return { payout: PAYOUTS.pair, tag: 'pair' };
  if (blackCount === 1) return { payout: PAYOUTS.nearMiss, tag: 'nearMiss' };
  return { payout: PAYOUTS.none, tag: 'none' };
}

// Sets the message, colors, and effect triggers for the round result. The
// raw payout is what gets shown/celebrated - deliberately NOT the net
// amount (payout minus the stake, which was already deducted in
// dealOut()). A "pair" pays out less than the stake but still gets the
// full win treatment (see the PAYOUTS comment above).
function applyResultEffects(payout, tag) {
  const message = document.getElementById('message');
  const centerDisplay = document.getElementById('center-display');

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

  // Triggers the box-shadow/shake CSS transitions, which fade in over the
  // same 0.6s as the flight to the center.
  centerDisplay.classList.add(isWin ? 'result-win' : 'result-lose');

  if (isWin) {
    winEffect(tag, payout);
  } else {
    loseEffect(tag === 'nearMiss');
  }
}

function setMoney(value) {
  money = value;
  const el = document.getElementById('money');
  el.textContent = `${money}€`;
  el.classList.remove('bump');
  void el.offsetWidth; // restart the bump animation
  el.classList.add('bump');
}

/* ---------------------------------------------------------------------
   8. WIN/LOSE EFFECTS
   ------------------------------------------------------------------ */

// Confetti runs entirely through canvas + a reused particle pool instead
// of hundreds of individual DOM elements - for the jackpot that would
// otherwise be hundreds of createElement()/remove() calls per win.
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

function launchConfetti(count, tag) {
  const isJackpot = tag === 'jackpot' || tag === 'megaJackpot';
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

// Resets a reused effect layer (by ID) back to its base class, forces a
// reflow, then re-adds 'active' (+ any extra classes). Since the actual
// @keyframes animations are gated behind ".active", this reliably
// restarts an animation that already played once, without recreating the
// element.
function restartEffectLayer(id, ...classes) {
  const layer = document.getElementById(id);
  layer.className = layer.className.split(' ')[0];
  void layer.offsetWidth;
  layer.classList.add('active', ...classes);
  return layer;
}

// Only the triple and jackpot get the full-screen flash + banner; smaller
// wins just get confetti so it doesn't feel too heavy-handed.
function winEffect(tag, payout) {
  const isMega = tag === 'megaJackpot';
  const isJackpot = tag === 'jackpot' || isMega;
  const isTriple = tag === 'triple';
  const isMajorWin = isJackpot || isTriple;

  if (isMajorWin) {
    restartEffectLayer('win-flash-layer', 'major', ...(isJackpot ? ['jackpot'] : []));

    const banner = document.getElementById('win-banner');
    banner.textContent = isMega ? 'MEGA JACKPOT!' : isJackpot ? 'JACKPOT!' : 'DREIER!';
    restartEffectLayer('win-banner', isJackpot ? 'jackpot' : 'triple');
  }

  if (isJackpot) createJackpotOverload(payout, isMega);

  const pieceCount = isMega ? 420 : isJackpot ? 260 : isTriple ? 160 : 90;
  launchConfetti(pieceCount, tag);
}

// Re-randomizes the 8 burst elements and 3 echo texts that are already in
// the HTML (via inline styles) instead of creating new DOM nodes for
// every jackpot, then triggers the (".active"-gated) animation.
function createJackpotOverload(payout, isMega) {
  const spectacle = document.getElementById('jackpot-spectacle');

  spectacle.querySelectorAll('.jackpot-burst').forEach((burst) => {
    burst.style.left = `${8 + Math.random() * 84}%`;
    burst.style.top = `${12 + Math.random() * 66}%`;
    burst.style.setProperty('--burst-delay', `${Math.random() * 1.4}s`);
    burst.style.setProperty('--burst-size', `${(isMega ? 220 : 180) + Math.random() * 260}px`);
  });

  const echoLabel = isMega ? 'MEGA JACKPOT!' : 'JACKPOT!';
  const echoes = spectacle.querySelectorAll('.jackpot-echo');
  const echoTexts = [echoLabel, `${payout}€`, echoLabel];
  echoes.forEach((echo, index) => {
    echo.textContent = echoTexts[index] ?? echoLabel;
    echo.style.setProperty('--echo-delay', `${0.25 + index * 0.42}s`);
    echo.style.setProperty('--echo-turn', `${index % 2 === 0 ? -1 : 1}deg`);
  });

  restartEffectLayer('jackpot-spectacle');
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

/* ---------------------------------------------------------------------
   9. ROUND TRANSITIONS
   ------------------------------------------------------------------ */

// Keeps the button state and "can the cards in the grid be interacted
// with" in sync with the global `state`. Called on every state
// transition. The #grid.locked class makes sure (via CSS) that neither
// the hover-grow effect nor the pointer cursor apply while it's not
// actually the player's turn (e.g. while 3 cards are already picked, or
// while cards are being dealt/collected).
function syncInteractionState() {
  document.getElementById('new-round-btn').disabled = state !== STATE.REVIEW;
  document.getElementById('grid').classList.toggle('locked', state !== STATE.PLAYING);
}

// Flies the 3 revealed cards back onto the stack, then deals the whole
// (reshuffled) deck back out.
function startNewRound() {
  if (state === STATE.DEALING) return;

  state = STATE.DEALING;
  syncInteractionState();

  // Hide the message right as the cards start leaving, instead of
  // letting it linger until the whole round reset is done.
  document.getElementById('message').classList.remove('visible');

  const stack = document.getElementById('stack');
  const grid = document.getElementById('grid');
  const centerCards = flippedCards.slice();

  if (centerCards.length === 0) {
    // very first deal: nothing to return, cards start life on the stack
    cardEls.forEach((card) => stack.appendChild(card.el));
    dealOut();
    return;
  }

  centerCards.forEach((card) => card.classList.remove('flipped'));
  flipMoveBatch(centerCards, stack, dealOut);
}

// Deducts the stake and deals out the deck. Bails into game-over if the
// stake can no longer be afforded.
function dealOut() {
  if (money < STAKE) {
    triggerGameOver();
    return;
  }

  const grid = document.getElementById('grid');

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
    // Let the reset render first, otherwise the browser would batch both
    // class changes together and skip the entrance animation.
    void s.offsetWidth;
    s.classList.add('dealing');
  });

  setMoney(money - STAKE);

  shuffle(DECK);
  assignColors(DECK);
  flippedCards = [];

  cardEls.forEach((card, i) => {
    setTimeout(() => flipMove(card.el, grid), i * DEAL_STAGGER);
  });

  setTimeout(
    () => {
      state = STATE.PLAYING;
      syncInteractionState();
    },
    cardEls.length * DEAL_STAGGER + 650
  );
}

function triggerGameOver() {
  state = STATE.GAME_OVER;
  syncInteractionState();

  const message = document.getElementById('message');
  message.textContent = 'GAME OVER - kein Guthaben mehr!';
  message.classList.remove('win', 'lose', 'pop');
  message.classList.add('game-over', 'visible');
  void message.offsetWidth;
  message.classList.add('pop');
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

/* ---------------------------------------------------------------------
   10. DEBUG TOOLS
   ------------------------------------------------------------------ */

// Shows each result effect in isolation, without playing an actual round
// or changing money/round count.
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
  const controls = document.getElementById('debug-controls');
  if (!DEBUG) {
    controls.classList.add('hidden');
    return;
  }

  const events = [
    { payout: PAYOUTS.megaJackpot, tag: 'megaJackpot', label: 'MEGA JACKPOT (3 schwarz)' },
    { payout: PAYOUTS.jackpot, tag: 'jackpot', label: 'Jackpot (2 schwarz)' },
    { payout: PAYOUTS.triple, tag: 'triple', label: 'Dreier' },
    { payout: PAYOUTS.nearMissPair, tag: 'nearMissPair', label: 'Beinahe-Jackpot mit Paar' },
    { payout: PAYOUTS.pair, tag: 'pair', label: 'Paar' },
    { payout: PAYOUTS.nearMiss, tag: 'nearMiss', label: 'So knapp am Jackpot vorbei!' },
    { payout: PAYOUTS.none, tag: 'none', label: 'Nichts gewonnen' },
  ];

  events.forEach((event) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = event.label;
    button.addEventListener('click', () => previewResult(event));
    controls.appendChild(button);
  });

  controls.hidden = false;
}

/* ---------------------------------------------------------------------
   11. BOOTSTRAP
   ------------------------------------------------------------------ */

document.querySelector('#new-game-btn').addEventListener('click', () => newGame());
document.querySelector('#new-round-btn').addEventListener('click', () => newRound());

fitCardSize();
setupEffects();
buildCardElements();
setupDebugControls();
newGame();
