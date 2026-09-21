import { Module, OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import websocketPlugin from '@fastify/websocket';
import { registerAgentGateway } from './agent.gateway.js';
import { initDashboardGateway } from './dashboard.gateway.js';
import { AuthModule } from '../auth/auth.module.js';
import { TokenService } from '../auth/token.service.js';

@Module({ imports: [AuthModule] })
export class RealtimeModule implements OnModuleInit {
  constructor(private readonly adapterHost: HttpAdapterHost, private readonly tokens: TokenService) {}

  async onModuleInit() {
    const fastify = this.adapterHost.httpAdapter.getInstance();
    await fastify.register(websocketPlugin);
    registerAgentGateway(fastify);
    fastify.addHook('onReady', () => {
      const io = initDashboardGateway(fastify.server, (t) => this.tokens.verifyAccessToken(t));
      fastify.decorate('io', io);
    });
  }
}
