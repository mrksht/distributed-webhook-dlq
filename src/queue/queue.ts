import { EventEmitter } from "events";
import { WebhookJob } from "../types";

const emitter = new EventEmitter();
const JOB_EVENT = "job";

export const enqueue = (job: WebhookJob): void => {
  emitter.emit(JOB_EVENT, job);
};

export const onJob = (handler: (job: WebhookJob) => void): void => {
  emitter.on(JOB_EVENT, handler);
};
