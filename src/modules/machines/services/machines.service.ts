import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import { assertScope } from '../../../common/utils/assert-scope.js';
import { AgentGateway } from '../../ops/agent.gateway.js';
import { SessionsService } from '../../session-billing/services/sessions.service.js';
import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import type { MachineEnrollmentStatus } from '../../../generated/prisma/index.js';
import { MachinesRepository } from '../repository/machines.repository.js';
import type { ListMachinesQueryDto } from '../schemas/machines.schemas.js';
import { toPublicMachine, type MachineRecord } from '../util/public-machine.js';


@Injectable()
export class MachinesService {
  constructor(
    private readonly machines: MachinesRepository,
    private readonly agents: AgentGateway,
    private readonly sessions: SessionsService,
  ) {}

  async list(caller: AccessTokenPayload, query: ListMachinesQueryDto) {
    if (query.branchId) assertScope(caller, { branchId: query.branchId });

   
    const branchId = caller.scope === 'hq' ? query.branchId : (caller.branchId ?? undefined);
    const machines = await this.machines.list({ branchId, enrollmentStatus: query.status });
    return machines.map(toPublicMachine);
  }

  async get(caller: AccessTokenPayload, id: string) {
    const machine = await this.findOrThrow(id);
    assertScope(caller, { branchId: machine.branchId });
    return toPublicMachine(machine);
  }

  
  async approve(caller: AccessTokenPayload, id: string) {
    const machine = await this.findOrThrow(id);
    assertScope(caller, { branchId: machine.branchId });
    this.assertStatus(machine, 'PENDING', 'MACHINE_NOT_PENDING', 'machine enrollment is not pending');

    const updated = await this.machines.updateStatus(id, 'ENROLLED');
    return toPublicMachine(updated);
  }

  
  async reject(caller: AccessTokenPayload, id: string) {
    const machine = await this.findOrThrow(id);
    assertScope(caller, { branchId: machine.branchId });
    this.assertStatus(machine, 'PENDING', 'MACHINE_NOT_PENDING', 'machine enrollment is not pending');

    const updated = await this.machines.updateStatus(id, 'DEACTIVATED');
    this.agents.disconnectStation(machine.serialNumber, 'station rejected');
    return toPublicMachine(updated);
  }

  /**
   * Takes a station out of service at once: its live connection is dropped
   * (the token is refused from now on), the session on it is settled, and its
   * bookings still ahead are cancelled. It can enroll again later.
   */
  async revoke(caller: AccessTokenPayload, id: string) {
    const machine = await this.findOrThrow(id);
    assertScope(caller, { branchId: machine.branchId });

    const updated = await this.machines.updateStatus(id, 'DEACTIVATED');
    this.agents.disconnectStation(machine.serialNumber, 'station revoked');
    await this.sessions.retireMachine(machine.id);
    return toPublicMachine(updated);
  }

  private async findOrThrow(id: string): Promise<MachineRecord> {
    const machine = await this.machines.findById(id);
    if (!machine) throw new NotFoundException({ code: 'MACHINE_NOT_FOUND', error: 'machine not found' });
    return machine;
  }

  private assertStatus(
    machine: Pick<MachineRecord, 'enrollmentStatus'>,
    expected: MachineEnrollmentStatus,
    code: string,
    error: string,
  ): void {
    if (machine.enrollmentStatus !== expected) {
      throw new ConflictException({ code, error });
    }
  }
}
