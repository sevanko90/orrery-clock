import { describe, expect, it } from 'vitest';
import { SPACE_1999, VOGON_DEMOLITION, WAR_OF_THE_WORLDS, tooFrequent } from './catalog';

const HOUR_S = 3600,
  DAY_S = 86_400,
  WEEK_S = 7 * DAY_S;

describe('tooFrequent: recurring events skipped when they would come round within a minute', () => {
  it('shows the weekly Demolition up to an hour a second, skips it at a day a second', () => {
    expect(tooFrequent(VOGON_DEMOLITION, HOUR_S)).toBe(false);
    expect(tooFrequent(VOGON_DEMOLITION, DAY_S)).toBe(true);
  });
  it('shows the yearly War of the Worlds at a day a second, skips it at a week a second', () => {
    expect(tooFrequent(WAR_OF_THE_WORLDS, DAY_S)).toBe(false);
    expect(tooFrequent(WAR_OF_THE_WORLDS, WEEK_S)).toBe(true);
  });
  it('applies in reverse too, and never when paused', () => {
    expect(tooFrequent(VOGON_DEMOLITION, -DAY_S)).toBe(true);
    expect(tooFrequent(VOGON_DEMOLITION, 0)).toBe(false);
  });
  it('never skips a one-off event', () => {
    expect(tooFrequent(SPACE_1999, 365 * DAY_S)).toBe(false);
  });
});
