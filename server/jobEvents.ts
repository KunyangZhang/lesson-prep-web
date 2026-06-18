import type { Course, Job } from "./types.js";
import type { Store } from "./store.js";

type JobFinishedListener = (store: Store, course: Course, job: Job) => void | Promise<void>;

const jobFinishedListeners: JobFinishedListener[] = [];

export function onJobFinished(listener: JobFinishedListener) {
  jobFinishedListeners.push(listener);
}

export function emitJobFinished(store: Store, course: Course, job: Job) {
  for (const listener of jobFinishedListeners) {
    Promise.resolve(listener(store, course, job)).catch((error) => {
      console.error("[job-event] listener failed:", error);
    });
  }
}
