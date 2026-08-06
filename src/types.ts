export interface WebhookJob {
    id: string;
    url: string;
    payload: unknown;
    status: 'QUEUED' | 'PROCESSING' | 'DELIVERED' | 'FAILED';
    createdAt: Date;
    updatedAt: Date;
}

