import { WebhookJob } from "../types";
import { updateJob } from "../store/jobStore";

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
    updateJob(job.id, "FAILED");
    console.error(`Job ${job.id} failed:`, error);
  }
}