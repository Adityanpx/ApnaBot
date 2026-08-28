// Sentinel used for "paused indefinitely" instead of a separate boolean
// column — keeps bot_paused_until a single nullable timestamp: null/past
// means active, this far-future value means paused until manually resumed,
// anything else in between is a normal timed pause.
const INDEFINITE_PAUSE_SENTINEL = '9999-12-31T00:00:00.000Z';

const isIndefinitePause = (botPausedUntil) => {
  if (!botPausedUntil) return false;
  return new Date(botPausedUntil).getTime() === new Date(INDEFINITE_PAUSE_SENTINEL).getTime();
};

module.exports = { INDEFINITE_PAUSE_SENTINEL, isIndefinitePause };
