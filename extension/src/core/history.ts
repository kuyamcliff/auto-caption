// Snapshot-based undo/redo. Projects are immutable, so snapshots share
// structure and are cheap.

export class History<T> {
  private past: { state: T; label: string }[] = [];
  private future: { state: T; label: string }[] = [];

  constructor(private limit = 200) {}

  /** Record `prev` before moving to a new state. */
  push(prev: T, label: string): void {
    this.past.push({ state: prev, label });
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }

  undo(current: T): { state: T; label: string } | null {
    const entry = this.past.pop();
    if (!entry) return null;
    this.future.push({ state: current, label: entry.label });
    return entry;
  }

  redo(current: T): { state: T; label: string } | null {
    const entry = this.future.pop();
    if (!entry) return null;
    this.past.push({ state: current, label: entry.label });
    return entry;
  }

  clear(): void {
    this.past = [];
    this.future = [];
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  get undoLabel(): string | undefined {
    return this.past[this.past.length - 1]?.label;
  }

  get redoLabel(): string | undefined {
    return this.future[this.future.length - 1]?.label;
  }
}
