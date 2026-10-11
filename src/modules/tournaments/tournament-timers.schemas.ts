export const TOURNAMENT_QUEUE = 'tournament-lifecycle';
export const TOURNAMENT_JOBS = {
  CLOSE_REGISTRATION: 'close-registration',
  OPEN_CHECK_IN: 'open-check-in',
  CLOSE_CHECK_IN: 'close-check-in',
} as const;
export type TournamentJobName =
  (typeof TOURNAMENT_JOBS)[keyof typeof TOURNAMENT_JOBS];
export interface TournamentJobData {
  tournamentId: string;
}
