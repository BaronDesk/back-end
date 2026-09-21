import { Module } from "@nestjs/common";
import { MachineRegistry } from "../../lib/realtime/registry";
import { AgentGateway } from "./agent-gateway";
import { DashboardGateway } from "./dashboard-gateway";

/** Real-time transport (no DB access yet): machine agents (ws) + dashboards (Socket.IO). */
@Module({
  providers: [MachineRegistry, AgentGateway, DashboardGateway],
  exports: [MachineRegistry, DashboardGateway],
})
export class OpsModule {}
