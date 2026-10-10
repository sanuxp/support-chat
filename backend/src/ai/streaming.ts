import { editMessage, sendMessage } from "../matrix/messages.js";

/**
 * Streams text into a Matrix message: the first chunk is sent as a new message, later chunks are
 * applied as m.replace edits at most once per `intervalMs`, plus a final edit on finish().
 */
export class StreamingMessage {
  private text = "";
  private eventId?: string;
  private lastSent = "";
  private lastEditAt = 0;
  private timer?: NodeJS.Timeout;
  private chain: Promise<void> = Promise.resolve();

  constructor(private roomId: string, private intervalMs: number) {}

  append(delta: string): void {
    this.text += delta;
    if (!this.eventId && !this.timer) {
      this.queue(() => this.flush()); // first chunk goes out immediately
    } else if (!this.timer) {
      const wait = Math.max(0, this.lastEditAt + this.intervalMs - Date.now());
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.queue(() => this.flush());
      }, wait);
    }
  }

  async finish(): Promise<string> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.queue(() => this.flush());
    await this.chain;
    return this.text;
  }

  private queue(fn: () => Promise<void>) {
    this.chain = this.chain.then(fn).catch(() => {});
  }

  private async flush(): Promise<void> {
    if (!this.text || this.text === this.lastSent) return;
    const snapshot = this.text;
    if (!this.eventId) this.eventId = await sendMessage(this.roomId, snapshot);
    else await editMessage(this.roomId, this.eventId, snapshot);
    this.lastSent = snapshot;
    this.lastEditAt = Date.now();
  }
}
