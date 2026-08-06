export interface WebhookJob {
    id: string;
    url: string;
    payload: unknown;
    status: 'QUEUED' | 'PROCESSING' | 'DELIVERED' | 'RETRYING' | 'DEAD_LETTER';
    createdAt: Date;
    updatedAt: Date;
    attempts: number;
}

