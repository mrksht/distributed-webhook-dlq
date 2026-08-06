import { WebhookJob } from "../types";
import { incrementAttempts, updateJob } from "../store/jobStore";
import { enqueue } from "../queue/queue";

const MAX_ATTEMPTS = 3;

export const processJob = async (job: WebhookJob): Promise<void> => {
  try {
    console.log(`Processing job ${job.id} for URL: ${job.url}`);
    updateJob(job.id, "PROCESSING");
    console.log(`Job ${job.id} is now in PROCESSING state.`);

    const response = await fetch(job.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(job.payload),
    });

    if (!response.ok) {
      throw new Error(`destination responded with status ${response.status}`);
    }

    updateJob(job.id, "DELIVERED");
    console.log(`Job ${job.id} delivered successfully.`);
  } catch (error) {
    const attempts = incrementAttempts(job.id);
    if (attempts < MAX_ATTEMPTS) {
      console.log(`Will retry job ${job.id} (attempt ${attempts}) due to error:`, error);
      updateJob(job.id, "RETRYING");

      setTimeout(() => {
        enqueue(job);
      }, 1000 * attempts);
    } else {
        console.log(`Job ${job.id} has reached max attempts (${MAX_ATTEMPTS}). Marking as DEAD_LETTER.`);
        updateJob(job.id, "DEAD_LETTER");
    }
  }
}