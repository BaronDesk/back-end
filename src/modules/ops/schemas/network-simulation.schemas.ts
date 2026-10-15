import { z } from 'zod';

/** How long a simulated network outage lasts: 1 s to 1 h. */
export const networkDropBodySchema = z.object({ seconds: z.number().int().min(1).max(3600) });
export type NetworkDropBody = z.infer<typeof networkDropBodySchema>;
