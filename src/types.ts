export enum JobStatus {
    QUEUED = "QUEUED",
    PROCESSING = "PROCESSING",
    DELIVERED = "DELIVERED",
    RETRYING = "RETRYING",
    DEAD_LETTER = "DEAD_LETTER",
}

export interface WebhookJob {
    id: string;
    tenantId: string;
    url: string;
    payload: unknown;
    status: JobStatus;
    createdAt: Date;
    updatedAt: Date;
    attempts: number;
}

