/**
 * Quality presets and the adaptive scaler. Pure logic, unit tested.
 */
import type { QualityLevel } from './types';

export interface QualitySettings {
  /** blur pass resolution as a fraction of render resolution */
  blurScale: number;
  /** number of poisson taps in the gather */
  dofTaps: number;
}

export const QUALITY_PRESETS: Record<Exclude<QualityLevel, 'auto'>, QualitySettings> = {
  low: { blurScale: 0.45, dofTaps: 12 },
  medium: { blurScale: 0.5, dofTaps: 24 },
  high: { blurScale: 0.7, dofTaps: 36 },
};

const LADDER: Array<Exclude<QualityLevel, 'auto'>> = ['low', 'medium', 'high'];

/**
 * Adaptive controller: exponential-moving-average of frame time; steps the
 * quality ladder down when sustained frame time exceeds `downMs`, up when it
 * stays under `upMs` for `holdFrames` frames. Hysteresis prevents oscillation.
 */
export class AdaptiveQuality {
  ema = 16.7;
  level: Exclude<QualityLevel, 'auto'> = 'high';
  private calm = 0;
  private cooldown = 0;

  constructor(
    private readonly downMs = 24,
    private readonly upMs = 14,
    private readonly holdFrames = 180,
    private readonly alpha = 0.05,
  ) {}

  private warmup = 90;

  /** Feed one frame time (ms). Returns true if the level changed. */
  update(frameMs: number): boolean {
    // Startup grace period: shader compiles + first texture uploads are not
    // representative of steady-state cost.
    if (this.warmup > 0) {
      this.warmup--;
      return false;
    }
    // Ignore absurd spikes (tab switches, GC) so one hitch doesn't drop quality.
    const clamped = Math.min(frameMs, 100);
    this.ema = this.ema * (1 - this.alpha) + clamped * this.alpha;
    if (this.cooldown > 0) this.cooldown--;

    const idx = LADDER.indexOf(this.level);
    if (this.ema > this.downMs && idx > 0 && this.cooldown === 0) {
      this.level = LADDER[idx - 1];
      this.calm = 0;
      this.cooldown = 120;
      return true;
    }
    if (this.ema < this.upMs && idx < LADDER.length - 1) {
      this.calm++;
      if (this.calm >= this.holdFrames && this.cooldown === 0) {
        this.level = LADDER[idx + 1];
        this.calm = 0;
        this.cooldown = 240;
        return true;
      }
    } else {
      this.calm = 0;
    }
    return false;
  }

  get settings(): QualitySettings {
    return QUALITY_PRESETS[this.level];
  }
}

/** Resolve user-selected level + adaptive state to concrete settings. */
export function resolveQuality(level: QualityLevel, adaptive: AdaptiveQuality): QualitySettings {
  return level === 'auto' ? adaptive.settings : QUALITY_PRESETS[level];
}
