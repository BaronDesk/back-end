import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';

import {
  STATION_EVENT_JOBS,
  STATION_EVENTS_QUEUE,
  type SettleJobData,
  type StationEventJobData,
  type StatusJobData,
} from '../schemas/station-events.schemas.js';
import { StationLinkService } from './station-link.service.js';

/**
 * Runs the billing follow-up of a queued presence event. One at a time, so a
 * station's lock / unlock / offline changes apply in the order they happened.
 * A throw hands the job back to BullMQ for a retry: every handler is
 * idempotent (settlement shares its debit key and closes the session, XP
 * included, only once).
 */
@Processor(STATION_EVENTS_QUEUE, { concurrency: 1 })
export class StationEventsProcessor extends WorkerHost {
  private readonly logger = new Logger(StationEventsProcessor.name);

  constructor(private readonly stationLink: StationLinkService) {
    super();
  }

  async process(job: Job<StationEventJobData>): Promise<void> {
    if (job.name === STATION_EVENT_JOBS.SETTLE) {
      await this.stationLink.handleSessionEnded((job.data as SettleJobData).event);
      return;
    }
    if (job.name === STATION_EVENT_JOBS.STATUS) {
      const { event, at } = job.data as StatusJobData;
      await this.stationLink.handleStationStatus(event, new Date(at));
      return;
    }
    this.logger.warn(`unknown station event job: ${job.name}`);
  }
}
