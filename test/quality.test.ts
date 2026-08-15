import { describe, expect, it } from 'vitest';
import { AdaptiveQuality, QUALITY_PRESETS, resolveQuality } from '../src/quality';

describe('quality presets', () => {
  it('costs more as it goes up', () => {
    expect(QUALITY_PRESETS.low.blurScale).toBeLessThan(QUALITY_PRESETS.medium.blurScale);
    expect(QUALITY_PRESETS.medium.blurScale).toBeLessThan(QUALITY_PRESETS.high.blurScale);
    expect(QUALITY_PRESETS.low.dofTaps).toBeLessThan(QUALITY_PRESETS.high.dofTaps);
  });

  it('resolves a fixed level to its preset', () => {
    const a = new AdaptiveQuality();
    expect(resolveQuality('low', a)).toEqual(QUALITY_PRESETS.low);
    expect(resolveQuality('high', a)).toEqual(QUALITY_PRESETS.high);
  });
});

describe('adaptive quality', () => {
  const warm = (a: AdaptiveQuality, ms: number, frames: number) => {
    let changes = 0;
    for (let i = 0; i < frames; i++) if (a.update(ms)) changes++;
    return changes;
  };

  it('ignores the first frames, which are shader compiles', () => {
    const a = new AdaptiveQuality();
    expect(warm(a, 200, 80)).toBe(0);
    expect(a.level).toBe('high');
  });

  it('steps down when frame time is sustained, not when it spikes', () => {
    const a = new AdaptiveQuality();
    warm(a, 8, 120);            // past the warmup, running fast
    a.update(400);              // one hitch
    expect(a.level).toBe('high');
    warm(a, 40, 300);           // genuinely slow
    expect(a.level).toBe('low');
  });

  it('climbs back when the load goes away, with hysteresis', () => {
    const a = new AdaptiveQuality();
    warm(a, 40, 400);
    expect(a.level).toBe('low');
    warm(a, 6, 1200);
    expect(a.level).toBe('high');
  });

  it('never leaves the ladder', () => {
    const a = new AdaptiveQuality();
    warm(a, 999, 2000);
    expect(a.level).toBe('low');
    warm(a, 1, 4000);
    expect(a.level).toBe('high');
  });
});
