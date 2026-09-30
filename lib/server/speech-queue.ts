/** Serializes model work with cancellable consumers and priority for active listening. */

/** Playback outranks recording jobs, which outrank speculative opening preparation. */
export type SpeechPriority = "playback" | "background" | "preparation"

/** Options affect one consumer; cancellation never interrupts a model inference in progress. */
export type SpeechQueueOptions = {
  priority?: SpeechPriority
  signal?: AbortSignal
}

/** One consumer waiting for shared synthesis of an identical request. */
type Consumer = {
  priority: number
  resolve: (result: unknown) => void
  reject: (error: unknown) => void
  cleanup: () => void
}

/** One queued or active task, retained while active even if all consumers cancel. */
type Task = {
  key: string
  run: () => Promise<unknown>
  consumers: Set<Consumer>
}

/** Runs one model task at a time and shares matching work without sharing cancellation. */
export class SpeechQueue {
  private tasks = new Map<string, Task>()
  private pending: Task[] = []
  private running = false

  /** Enqueues work or joins an existing key; aborting removes only this caller's interest. */
  enqueue<T>(
    key: string,
    run: () => Promise<T>,
    options: SpeechQueueOptions = {}
  ): Promise<T> {
    if (options.signal?.aborted)
      return Promise.reject(new DOMException("Speech stopped.", "AbortError"))
    let task = this.tasks.get(key)
    if (!task) {
      task = { key, run, consumers: new Set() }
      this.tasks.set(key, task)
      this.pending.push(task)
    }
    const sharedTask = task
    const result = new Promise<T>((resolve, reject) => {
      /** Drops unstarted work when its last interested caller cancels. */
      const onAbort = () => {
        sharedTask.consumers.delete(consumer)
        consumer.cleanup()
        reject(new DOMException("Speech stopped.", "AbortError"))
        if (!sharedTask.consumers.size && this.pending.includes(sharedTask)) {
          this.pending = this.pending.filter((entry) => entry !== sharedTask)
          this.tasks.delete(key)
        }
      }
      const consumer: Consumer = {
        priority: { playback: 2, background: 1, preparation: 0 }[
          options.priority ?? "background"
        ],
        resolve: (value) => resolve(value as T),
        reject,
        cleanup: () => options.signal?.removeEventListener("abort", onAbort),
      }
      sharedTask.consumers.add(consumer)
      options.signal?.addEventListener("abort", onAbort, { once: true })
    })
    // Defer selection so simultaneous arrivals compete by priority before inference starts.
    queueMicrotask(() => void this.drain())
    return result
  }

  /** Selects the highest interested priority, preserving arrival order on ties and after failures. */
  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.pending.length) {
        /** Recomputes priority so joining or cancelled consumers affect queued ordering. */
        const priority = (task: Task) =>
          Math.max(...[...task.consumers].map((consumer) => consumer.priority))
        this.pending.sort((left, right) => priority(right) - priority(left))
        const task = this.pending.shift()!
        try {
          const value = await task.run()
          for (const consumer of task.consumers) consumer.resolve(value)
        } catch (error) {
          for (const consumer of task.consumers) consumer.reject(error)
        } finally {
          for (const consumer of task.consumers) consumer.cleanup()
          this.tasks.delete(task.key)
        }
      }
    } finally {
      this.running = false
    }
  }
}
