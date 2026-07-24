interface WaitingConsumer<T> {
  readonly resolve: (value: IteratorResult<T>) => void;
}

interface WaitingProducer {
  readonly resolve: () => void;
}

export class BoundedAsyncQueue<T> implements AsyncIterable<T> {
  readonly #capacity: number;
  readonly #values: T[] = [];
  readonly #consumers: WaitingConsumer<T>[] = [];
  readonly #producers: WaitingProducer[] = [];
  #closed = false;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("Queue capacity must be a positive integer.");
    }
    this.#capacity = capacity;
  }

  async push(value: T): Promise<void> {
    while (!this.#closed) {
      const consumer = this.#consumers.shift();
      if (consumer !== undefined) {
        consumer.resolve({ done: false, value });
        return;
      }
      if (this.#values.length < this.#capacity) {
        this.#values.push(value);
        return;
      }
      await new Promise<void>((resolve) => {
        this.#producers.push({ resolve });
      });
    }
    throw new Error("Cannot push to a closed queue.");
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    if (this.#values.length === 0) {
      for (const consumer of this.#consumers.splice(0)) {
        consumer.resolve({ done: true, value: undefined });
      }
    }
    for (const producer of this.#producers.splice(0)) {
      producer.resolve();
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        const value = this.#values.shift();
        if (value !== undefined) {
          this.#producers.shift()?.resolve();
          return { done: false, value };
        }
        if (this.#closed) {
          return { done: true, value: undefined };
        }
        return await new Promise<IteratorResult<T>>((resolve) => {
          this.#consumers.push({ resolve });
        });
      },
    };
  }
}
