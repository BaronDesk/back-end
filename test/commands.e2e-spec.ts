import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue, QueueEvents } from 'bullmq';
import { Redis } from 'ioredis';

import { AppModule } from '../src/app.module.js';
import { COMMANDS_QUEUE } from '../src/ops/commands.constants.js';

describe('agent-commands queue', () => {
    let app: INestApplication;
    let queue: Queue;
    let events: QueueEvents;

    beforeAll(async () => {
        const fixture: TestingModule = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();

        app = fixture.createNestApplication();
        await app.init();                 // <- starts the worker

        queue = app.get<Queue>(getQueueToken(COMMANDS_QUEUE));
        await queue.obliterate({ force: true });   // clean slate

        events = new QueueEvents(COMMANDS_QUEUE, {
            connection: new Redis(process.env.REDIS_URL!, {
                maxRetriesPerRequest: null,
            }),
        });
        await events.waitUntilReady();
    }, 30_000);

    afterAll(async () => {
        await events.close();
        await app.close();
    });

    it('runs a job to completion and returns an ack', async () => {
        const job = await queue.add('command', {
            machineId: 'm-001',
            type: 'ping',
            payload: {},
        });

        const result = await job.waitUntilFinished(events, 10_000);
        expect(result).toHaveProperty('ackedAt');
        expect(await job.getState()).toBe('completed');
    });

    it('retries a failing job the configured number of times', async () => {
        const job = await queue.add(
            'command',
            { machineId: 'boom', type: 'explode', payload: {} },
            { attempts: 2, backoff: { type: 'fixed', delay: 50 } },
        );

        await expect(job.waitUntilFinished(events, 10_000)).rejects.toThrow();

        const reloaded = await queue.getJob(job.id!);
        expect(reloaded!.attemptsMade).toBe(2);
    });
});
