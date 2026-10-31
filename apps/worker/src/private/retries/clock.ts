export class SafetyClock {
  private wallOrigin: number;
  private monoOrigin: number;
  private blocked = false;
  constructor(
    private readonly onDrift: () => void,
    private readonly wall = Date.now,
    private readonly mono = () => performance.now(),
  ) {
    this.wallOrigin = wall();
    this.monoOrigin = mono();
  }
  now(): number {
    const current = this.wall(),
      elapsed = this.mono() - this.monoOrigin;
    if (
      this.blocked ||
      elapsed < 0 ||
      !Number.isSafeInteger(current) ||
      Math.abs(current - (this.wallOrigin + elapsed)) >= 5000
    ) {
      if (!this.blocked) {
        this.blocked = true;
        this.onDrift();
      }
      throw new Error("worker clock requires reconciliation");
    }
    return current;
  }
  rebase(): void {
    this.wallOrigin = this.wall();
    this.monoOrigin = this.mono();
    this.blocked = false;
  }
}
