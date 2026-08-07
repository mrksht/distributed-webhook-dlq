import { onJob } from "../queue/queue";
import { processJob } from "./worker";

onJob(processJob);

console.log("Worker process started, listening for jobs...");
