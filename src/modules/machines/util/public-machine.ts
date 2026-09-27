export interface MachineRecord {
  id: string;
  serialNumber: string;
  branchId: string;
  agentPublicKey: string;
  enrollmentStatus: string;
  name: string | null;
  status: string;
  lastSeen: Date | null;
  createdAt: Date;
}


export function toPublicMachine(machine: MachineRecord) {
  return {
    id: machine.id,
    serialNumber: machine.serialNumber,
    branchId: machine.branchId,
    agentPublicKey: machine.agentPublicKey,
    enrollmentStatus: machine.enrollmentStatus,
    name: machine.name,
    status: machine.status,
    lastSeen: machine.lastSeen,
    createdAt: machine.createdAt,
  };
}
