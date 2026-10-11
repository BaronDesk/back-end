import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import {
  TOURNAMENT_JOBS,
  TOURNAMENT_QUEUE,
  type TournamentJobData,
} from './tournament-timers.schemas.js';
import { TournamentsService } from './tournaments.service.js';

@Processor(TOURNAMENT_QUEUE)
export class TournamentTimersProcessor extends WorkerHost {
  constructor(private readonly tournaments: TournamentsService) {
    super();
  }

  async process(job: Job<TournamentJobData>): Promise<void> {
    if (job.name === TOURNAMENT_JOBS.CLOSE_REGISTRATION)
      return this.tournaments.onRegistrationDeadline(job.data.tournamentId);
    if (job.name === TOURNAMENT_JOBS.OPEN_CHECK_IN)
      return this.tournaments.onCheckInOpen(job.data.tournamentId);
    if (job.name === TOURNAMENT_JOBS.CLOSE_CHECK_IN)
      return this.tournaments.onCheckInDeadline(job.data.tournamentId);
  }
}
