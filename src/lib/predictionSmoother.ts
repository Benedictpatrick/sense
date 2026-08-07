/**
 * Smooths per-cycle classification noise with an exponential moving average
 * over class probabilities, plus a switch-confirmation delay: the displayed
 * label only changes once the new class has led the EMA for several
 * consecutive cycles, not on a single noisy read. Without this, independent
 * per-cycle argmax flickers between classes whenever two probabilities are
 * close (very common with real-world echoes vs. the synthetic training data).
 */

const EMA_ALPHA = 0.35;
const SWITCH_CONFIRM_CYCLES = 3;

export interface SmoothedPrediction {
  label: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export class PredictionSmoother {
  private ema: Record<string, number> | null = null;
  private displayedLabel = "none";
  private candidateLabel: string | null = null;
  private candidateStreak = 0;

  update(raw: Record<string, number>): SmoothedPrediction {
    if (!this.ema) {
      this.ema = { ...raw };
    } else {
      for (const label of Object.keys(raw)) {
        this.ema[label] = this.ema[label] * (1 - EMA_ALPHA) + raw[label] * EMA_ALPHA;
      }
    }

    let topLabel = this.displayedLabel;
    let topProb = -Infinity;
    for (const [label, prob] of Object.entries(this.ema)) {
      if (prob > topProb) {
        topProb = prob;
        topLabel = label;
      }
    }

    if (topLabel === this.displayedLabel) {
      this.candidateLabel = null;
      this.candidateStreak = 0;
    } else if (topLabel === this.candidateLabel) {
      this.candidateStreak += 1;
      if (this.candidateStreak >= SWITCH_CONFIRM_CYCLES) {
        this.displayedLabel = topLabel;
        this.candidateLabel = null;
        this.candidateStreak = 0;
      }
    } else {
      this.candidateLabel = topLabel;
      this.candidateStreak = 1;
    }

    return {
      label: this.displayedLabel,
      confidence: this.ema[this.displayedLabel],
      probabilities: { ...this.ema },
    };
  }

  reset(): void {
    this.ema = null;
    this.displayedLabel = "none";
    this.candidateLabel = null;
    this.candidateStreak = 0;
  }
}
