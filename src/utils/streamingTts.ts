/**
 * Streaming Sentence-by-Sentence Chunker & Interruptible First-Segment TTS Queue.
 *
 * Enables Zoni AI to start speaking as soon as the FIRST meaningful sentence segment
 * streams back from Gemini — without waiting for the entire response — while keeping
 * sentence boundaries natural and supporting instant user barge-in interruption.
 */

const COMMON_ABBREVIATIONS = new Set([
  'dr.',
  'mr.',
  'mrs.',
  'ms.',
  'prof.',
  'sr.',
  'jr.',
  'st.',
  'vs.',
  'etc.',
  'e.g.',
  'i.e.',
  'no.',
  'fig.',
]);

function endsWithAbbreviation(text: string): boolean {
  const match = text.trimEnd().match(/([a-zA-Z]{1,4}\.)$/);
  if (!match) return false;
  return COMMON_ABBREVIATIONS.has(match[1].toLowerCase());
}

function stripActionTagsForSpeech(text: string): string {
  return text
    .replace(/\[ACTION:[^\]]+\]/gi, ' ')
    .replace(/[*_`#~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export class StreamingSentenceChunker {
  private buffer = '';

  constructor(
    private readonly options: {
      minSentenceChars?: number;
      maxClauseFlushChars?: number;
    } = {}
  ) {}

  public reset(): void {
    this.buffer = '';
  }

  /**
   * Appends a streamed text delta and returns zero or more complete, speakable segments.
   */
  public pushDelta(delta: string): string[] {
    if (!delta) return [];
    this.buffer += delta;

    const minSentenceChars = this.options.minSentenceChars ?? 16;
    const maxClauseFlushChars = this.options.maxClauseFlushChars ?? 76;
    const ready: string[] = [];

    while (this.buffer.length > 0) {
      const splitIdx = this.findSafeBoundaryIndex(this.buffer, minSentenceChars, maxClauseFlushChars);
      if (splitIdx < 0) break;

      const rawSegment = this.buffer.slice(0, splitIdx + 1);
      this.buffer = this.buffer.slice(splitIdx + 1).replace(/^\s+/, '');
      const clean = stripActionTagsForSpeech(rawSegment);
      if (clean.length > 0) {
        ready.push(clean);
      }
    }

    return ready;
  }

  /**
   * Flushes any trailing buffered text when the stream finishes.
   */
  public flush(): string[] {
    const clean = stripActionTagsForSpeech(this.buffer);
    this.buffer = '';
    return clean.length > 0 ? [clean] : [];
  }

  private findSafeBoundaryIndex(
    text: string,
    minSentenceChars: number,
    maxClauseFlushChars: number
  ): number {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const next = text[i + 1] ?? '';

      // Hard sentence terminators: English/Hindi/Bengali (., !, ?, ।, newline)
      if (ch === '\n' || ch === '।' || ch === '!' || ch === '?') {
        if (i + 1 >= minSentenceChars) {
          return i;
        }
        continue;
      }

      if (ch === '.') {
        // Avoid splitting decimals like 3.14 or ellipses mid-token
        const prev = i > 0 ? text[i - 1] : '';
        if (/\d/.test(prev) && /\d/.test(next)) continue;
        if (next === '.') continue;
        if (next !== '' && !/\s/.test(next)) continue;
        const prefix = text.slice(0, i + 1);
        if (endsWithAbbreviation(prefix)) continue;
        if (i + 1 >= minSentenceChars) {
          return i;
        }
      }

      // Long sentence without a period yet: flush cleanly at a natural clause separator
      if ((ch === ',' || ch === ';' || ch === ':' || ch === '—') && i + 1 >= maxClauseFlushChars) {
        if (next === '' || /\s/.test(next)) {
          return i;
        }
      }
    }
    return -1;
  }
}

export interface StreamingTtsQueueCallbacks {
  synthesizeSegment: (segmentText: string, signal: AbortSignal) => Promise<string | null>;
  playAudioBase64: (audioBase64: string) => Promise<void> | void;
  stopAudioPlayback: () => void;
  onSpeakingStateChange?: (speaking: boolean) => void;
  onFirstAudibleSegment?: (segmentText: string, elapsedMs: number) => void;
}

/**
 * Interruptible, ordered sentence-segment TTS queue.
 * Synthesizes the next segment while/before playing so first audible voice starts immediately,
 * and aborts cleanly on user barge-in interruption without audio overlap.
 */
export class StreamingTtsQueue {
  private generationId = 0;
  private queue: Array<{ text: string; audioPromise: Promise<string | null> }> = [];
  private draining = false;
  private activeAbortController: AbortController | null = null;
  private turnStartMs = 0;
  private emittedFirstAudible = false;

  constructor(
    private readonly callbacks: StreamingTtsQueueCallbacks,
    private readonly nowClock: () => number = () =>
      typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now()
  ) {}

  public beginTurn(startMs?: number): void {
    this.interrupt();
    this.turnStartMs = typeof startMs === 'number' ? startMs : this.nowClock();
    this.emittedFirstAudible = false;
    this.activeAbortController = new AbortController();
  }

  public enqueue(segmentText: string): void {
    const clean = stripActionTagsForSpeech(segmentText);
    if (!clean) return;
    if (!this.activeAbortController || this.activeAbortController.signal.aborted) {
      this.activeAbortController = new AbortController();
      if (this.turnStartMs === 0) {
        this.turnStartMs = this.nowClock();
      }
    }
    const signal = this.activeAbortController.signal;
    const currentGen = this.generationId;

    // Kick off synthesis immediately (prefetching in order) so segment N+1 is ready as N finishes
    const audioPromise = this.callbacks
      .synthesizeSegment(clean, signal)
      .catch(() => null);

    this.queue.push({ text: clean, audioPromise });
    if (!this.draining) {
      void this.drain(currentGen);
    }
  }

  public interrupt(): void {
    this.generationId += 1;
    this.queue = [];
    if (this.activeAbortController) {
      try {
        this.activeAbortController.abort();
      } catch {
        // ignore abort errors
      }
      this.activeAbortController = null;
    }
    this.callbacks.stopAudioPlayback();
    this.callbacks.onSpeakingStateChange?.(false);
    this.draining = false;
  }

  public isActive(): boolean {
    return this.draining || this.queue.length > 0;
  }

  private async drain(expectedGen: number): Promise<void> {
    this.draining = true;
    try {
      while (this.queue.length > 0 && this.generationId === expectedGen) {
        const item = this.queue.shift();
        if (!item) continue;

        const audioBase64 = await item.audioPromise;
        if (this.generationId !== expectedGen) break;
        if (!audioBase64) continue;

        this.callbacks.onSpeakingStateChange?.(true);
        if (!this.emittedFirstAudible) {
          this.emittedFirstAudible = true;
          const elapsed = this.turnStartMs > 0 ? Math.max(0, this.nowClock() - this.turnStartMs) : 0;
          this.callbacks.onFirstAudibleSegment?.(item.text, elapsed);
        }

        await this.callbacks.playAudioBase64(audioBase64);
        if (this.generationId !== expectedGen) break;
      }
    } finally {
      if (this.generationId === expectedGen) {
        this.draining = false;
        this.callbacks.onSpeakingStateChange?.(false);
      }
    }
  }
}
