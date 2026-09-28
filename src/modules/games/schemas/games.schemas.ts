import { z } from 'zod';

/**
 * Limits mirror the agent's GameCatalogValidator: an entry the agent would
 * reject is refused here instead of being served and reported back as
 * `installed: false, reason: "Invalid catalog entry: ..."`.
 */
const MAX_GAME_ID = 128;
const MAX_NAME = 200;
const MAX_PATH = 1024;
const MAX_ARGUMENTS = 1024;
const MAX_PROCESS_NAME = 64;

// eslint-disable-next-line no-control-regex
const NO_CONTROL_CHARS = /^[^\u0000-\u001f\u007f]*$/;

export const GAME_LAUNCH_TYPES = ['exe', 'steam', 'epic'] as const;
export type GameLaunchTypeValue = (typeof GAME_LAUNCH_TYPES)[number];

/** The wire id: what the catalog response and LAUNCH_GAME carry. */
export const wireGameIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_GAME_ID)
  .regex(NO_CONTROL_CHARS, 'gameId must not contain control characters');

const optionalText = (max: number) => z.string().trim().min(1).max(max).regex(NO_CONTROL_CHARS).nullable().optional();

const processNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_PROCESS_NAME + 4)
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\\/:*?"<>|\u0000-\u001f]+$/, 'processName must be an executable file name (e.g. cs2.exe), not a path');

const launchFields = {
  launchType: z.enum(GAME_LAUNCH_TYPES),
  target: z.string().trim().min(1).max(MAX_PATH),
  arguments: optionalText(MAX_ARGUMENTS),
  workingDirectory: optionalText(MAX_PATH),
  processName: processNameSchema.nullable().optional(),
};

export const createGameSchema = z.object({
  gameId: wireGameIdSchema,
  name: z.string().trim().min(1).max(MAX_NAME).regex(NO_CONTROL_CHARS),
  ...launchFields,
  launchType: launchFields.launchType.default('exe'),
  iconUrl: z.string().url().max(2048).nullable().optional(),
  enabled: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});
export type CreateGameDto = z.infer<typeof createGameSchema>;

export const updateGameSchema = z
  .object({
    gameId: wireGameIdSchema,
    name: z.string().trim().min(1).max(MAX_NAME).regex(NO_CONTROL_CHARS),
    ...launchFields,
    iconUrl: z.string().url().max(2048).nullable(),
    enabled: z.boolean(),
    sortOrder: z.number().int(),
  })
  .partial()
  .refine((dto) => Object.keys(dto).length > 0, { message: 'nothing to update' });
export type UpdateGameDto = z.infer<typeof updateGameSchema>;

/** Per-machine overrides; null (or absent) keeps the game's own value. */
export const assignStationSchema = z
  .object({
    target: z.string().trim().min(1).max(MAX_PATH).nullable(),
    arguments: optionalText(MAX_ARGUMENTS),
    workingDirectory: optionalText(MAX_PATH),
  })
  .partial()
  .default({});
export type AssignStationDto = z.infer<typeof assignStationSchema>;

export const uuidParamSchema = z.string().uuid();

export interface LaunchSpec {
  launchType: GameLaunchTypeValue;
  target: string;
  workingDirectory?: string | null;
}

/**
 * Shape of `target` / `workingDirectory` for the launch type, as the agent
 * checks it. Returns the problem, or null. Run on the merged values (game +
 * per-machine override), since either side can change one of them.
 */
export function launchSpecError(spec: LaunchSpec): string | null {
  const { launchType, target } = spec;
  if (launchType === 'exe') {
    if (!isWindowsFullPath(target) || !target.toLowerCase().endsWith('.exe')) {
      return 'target must be the fully qualified path of an .exe file (e.g. C:\\Games\\cs2\\cs2.exe)';
    }
    if (spec.workingDirectory && !isWindowsFullPath(spec.workingDirectory)) {
      return 'workingDirectory must be a fully qualified folder path';
    }
    return null;
  }
  if (launchType === 'steam') {
    return /^\d{1,10}$/.test(target) ? null : 'target must be a Steam app id (digits only)';
  }
  return /^[A-Za-z0-9._-]{1,128}$/.test(target) ? null : "target must be an Epic AppName (letters, digits, '.', '_' or '-')";
}

/** `C:\...` or a UNC path `\\server\share\...`, no quotes or control characters. */
function isWindowsFullPath(path: string): boolean {
  return /^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+)/.test(path) && !path.includes('"') && NO_CONTROL_CHARS.test(path);
}

/** Inbound `catalog_status`: sent by the agent after every catalog sync. */
export const catalogStatusPayloadSchema = z.object({
  games: z
    .array(
      z.object({
        gameId: z.string().min(1).max(256),
        installed: z.boolean(),
        reason: z.string().max(1024).nullish(),
      }),
    )
    .max(5000),
});
export type CatalogStatusPayload = z.infer<typeof catalogStatusPayloadSchema>;
