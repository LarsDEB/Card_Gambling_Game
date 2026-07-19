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

        setTimeout(() => slot.classList.add('hidden'), 650);

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
    winEffect(tag === 'jackpot');
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

function winEffect(big) {
  playWinSound(big);

  const flash = document.createElement('div');
  flash.classList.add('win-flash');
  document.body.appendChild(flash);

  const layer = document.createElement('div');
  layer.classList.add('confetti-layer');
  document.body.appendChild(layer);

  const pieceCount = big ? 160 : Math.floor(Math.random() * 50) + 30;
  const confettiShapes = ['circle', 'star', 'ribbon', 'square'];
  for (let i = 0; i < pieceCount; i++) {
    const piece = document.createElement('div');
    piece.classList.add('confetti-piece');
    piece.classList.add(`confetti-${confettiShapes[Math.floor(Math.random() * confettiShapes.length)]}`);
    piece.style.left = `${20 + Math.random() * 60}vw`;
    piece.style.background = CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];
    piece.style.setProperty('--drift', `${(Math.random() - 0.5) * (big ? 72 : 48)}vw`);
    piece.style.setProperty('--rise', `${48 + Math.random() * (big ? 42 : 28)}vh`);
    piece.style.setProperty('--spin', `${(Math.random() - 0.5) * 1080}deg`);
    piece.style.animationDuration = `${2.4 + Math.random() * 1.4}s`;
    piece.style.animationDelay = `${Math.random() * (big ? 0.45 : 0.22)}s`;
    if (big) {
      piece.style.width = '14px';
      piece.style.height = '22px';
    }
    layer.appendChild(piece);
  }

  setTimeout(() => flash.remove(), big ? 1400 : 1000);
  setTimeout(() => layer.remove(), big ? 4500 : 3500);
}

// A small original brass fanfare. Web Audio needs no external sound file.
function playWinSound(big) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;

  try {
    const context = new AudioContextClass();
    const notes = [523.25, 659.25, 783.99, 1046.5];
    const start = context.currentTime;

    notes.forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const noteStart = start + index * 0.09;
      const noteEnd = noteStart + (big ? 0.3 : 0.22);

      oscillator.type = 'sawtooth';
      oscillator.frequency.setValueAtTime(frequency, noteStart);
      gain.gain.setValueAtTime(0.0001, noteStart);
      gain.gain.exponentialRampToValueAtTime(big ? 0.045 : 0.028, noteStart + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, noteEnd);
      const filter = context.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(1900, noteStart);
      filter.Q.setValueAtTime(1.4, noteStart);
      oscillator.connect(filter).connect(gain).connect(context.destination);
      oscillator.start(noteStart);
      oscillator.stop(noteEnd);
    });

    setTimeout(() => context.close(), 1200);
  } catch {
    // Sound is an enhancement only; a browser may still deny audio playback.
  }
}

function loseEffect(hard) {
  const flash = document.createElement('div');
  flash.classList.add('lose-flash');
  if (hard) flash.classList.add('hard');
  document.body.appendChild(flash);
  setTimeout(() => flash.remove(), hard ? 1200 : 900);
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
      s.classList.remove('hidden', 'dealing');
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
buildCardElements();
newGame();
