import { z } from 'zod';

export const idParamSchema = z.string().uuid();

export const listMachinesQuerySchema = z.object({
  branchId: z.string().uuid().optional(),
  status: z.enum(['PENDING', 'ENROLLED', 'INACTIVE', 'DEACTIVATED']).optional(),
});
export type ListMachinesQueryDto = z.infer<typeof listMachinesQuerySchema>;
