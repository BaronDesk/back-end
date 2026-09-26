import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import { assertScope } from '../../../common/utils/assert-scope.js';
import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import type { MachineEnrollmentStatus } from '../../../generated/prisma/index.js';
import { MachinesRepository } from '../repository/machines.repository.js';
import type { ListMachinesQueryDto } from '../schemas/machines.schemas.js';
import { toPublicMachine, type MachineRecord } from '../util/public-machine.js';

/** Everything that happens to a Machine record once it exists: read + the approve/reject/revoke lifecycle. */
@Injectable()
export class MachinesService {
  constructor(private readonly machines: MachinesRepository) {}

  async list(caller: AccessTokenPayload, query: ListMachinesQueryDto) {
    if (query.branchId) assertScope(caller, { branchId: query.branchId });

    // hq with no branchId filter sees every branch; anyone else is pinned to their own.
    const branchId = caller.scope === 'hq' ? query.branchId : (caller.branchId ?? undefined);
    const machines = await this.machines.list({ branchId, enrollmentStatus: query.status });
    return machines.map(toPublicMachine);
  }

  async get(caller: AccessTokenPayload, id: string) {
    const machine = await this.findOrThrow(id);
    assertScope(caller, { branchId: machine.branchId });
    return toPublicMachine(machine);
  }

  /** admin(branch): PENDING -> ENROLLED. The credential was already set at redemption time. */
  async approve(caller: AccessTokenPayload, id: string) {
    const machine = await this.findOrThrow(id);
    assertScope(caller, { branchId: machine.branchId });
    this.assertStatus(machine, 'PENDING', 'MACHINE_NOT_PENDING', 'machine enrollment is not pending');

    const updated = await this.machines.updateStatus(id, 'ENROLLED');
    return toPublicMachine(updated);
  }

  /** admin(branch): PENDING -> DEACTIVATED. Declines a station that redeemed a token but shouldn't be trusted. */
  async reject(caller: AccessTokenPayload, id: string) {
    const machine = await this.findOrThrow(id);
    assertScope(caller, { branchId: machine.branchId });
    this.assertStatus(machine, 'PENDING', 'MACHINE_NOT_PENDING', 'machine enrollment is not pending');

    const updated = await this.machines.updateStatus(id, 'DEACTIVATED');
    return toPublicMachine(updated);
  }

  /** admin(branch): any status -> DEACTIVATED. Kills trust in a machine's current credential. */
  async revoke(caller: AccessTokenPayload, id: string) {
    const machine = await this.findOrThrow(id);
    assertScope(caller, { branchId: machine.branchId });

    const updated = await this.machines.updateStatus(id, 'DEACTIVATED');
    return toPublicMachine(updated);
  }

  private async findOrThrow(id: string): Promise<MachineRecord> {
    const machine = await this.machines.findById(id);
    if (!machine) throw new NotFoundException({ code: 'MACHINE_NOT_FOUND', error: 'machine not found' });
    return machine;
  }

  private assertStatus(
    machine: { enrollmentStatus: MachineEnrollmentStatus },
    expected: MachineEnrollmentStatus,
    code: string,
    error: string,
  ): void {
    if (machine.enrollmentStatus !== expected) {
      throw new ConflictException({ code, error });
    }
  }
}
