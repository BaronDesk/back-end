export const COMMANDS_QUEUE = 'agent-commands';

export interface CommandJob {
  machineId: string;
  type: string;
  payload: unknown;
}