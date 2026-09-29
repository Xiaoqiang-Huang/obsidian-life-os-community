/** One desktop conversation survives ChatView unmount/remount while its request is in flight. */
export class ChatContinuity<T> {
  private listeners = new Set<(state: T, run: ChatRun | null, source: object | null) => void>();
  private run: ChatRun | null = null;

  constructor(public state: T) {}

  get activeRun(): ChatRun | null { return this.run; }

  publish(state: T, source: object | null = null): void {
    this.state = state;
    this.notify(source);
  }

  subscribe(listener: (state: T, run: ChatRun | null, source: object | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  beginRun(sessionId: string, controller: AbortController, source: object): boolean {
    if (this.run) return false;
    this.run = { sessionId, controller };
    this.notify(source);
    return true;
  }

  endRun(controller: AbortController, source: object): void {
    if (this.run?.controller !== controller) return;
    this.run = null;
    this.notify(source);
  }

  private notify(source: object | null): void {
    for (const listener of [...this.listeners]) listener(this.state, this.run, source);
  }
}

export interface ChatRun {
  sessionId: string;
  controller: AbortController;
}
