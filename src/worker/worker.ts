import { JobStatus, WebhookJob } from "../types";
import { incrementAttempts, updateJob } from "../store/jobStore";
import { enqueue } from "../queue/queue";

const MAX_ATTEMPTS = 3;

export const processJob = async (job: WebhookJob): Promise<void> => {
  try {
    console.log(`Processing job ${job.id} for URL: ${job.url}`);
    await updateJob(job.id, JobStatus.PROCESSING);
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

    await updateJob(job.id, JobStatus.DELIVERED);
    console.log(`Job ${job.id} delivered successfully.`);
  } catch (error) {
    const attempts = await incrementAttempts(job.id);
    if (attempts < MAX_ATTEMPTS) {
      console.log(`Will retry job ${job.id} (attempt ${attempts}) due to error:`, error);
      await updateJob(job.id, JobStatus.RETRYING);

      setTimeout(() => {
        enqueue(job).catch((err) => console.error(`Failed to re-enqueue job ${job.id}:`, err));
      }, 1000 * attempts);
    } else {
        console.log(`Job ${job.id} has reached max attempts (${MAX_ATTEMPTS}). Marking as DEAD_LETTER.`);
        await updateJob(job.id, JobStatus.DEAD_LETTER);
    }
  }
}