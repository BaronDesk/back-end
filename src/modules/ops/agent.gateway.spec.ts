import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentRegistry } from '../../infra/realtime/registry.js';
import { AgentGateway } from './agent.gateway.js';
import { StationSessionPort, type StationSessionHandler } from './services/station-session.port.js';

const PRINCIPAL = { machineId: 'm1', serialNumber: 'SN-1', branchId: 'b1' };

interface Frame {
  type: string;
  id: string;
  seq: number;
  payload: Record<string, unknown>;
}

/** Just enough of a `ws` socket: records what the gateway sends. */
class FakeSocket extends EventEmitter {
  readyState = 1; // WebSocket.OPEN
  readonly sent: Frame[] = [];
  send(data: string, cb?: (err?: Error) => void): void {
    this.sent.push(JSON.parse(data));
    cb?.();
  }
  close(): void {
    this.readyState = 3;
  }
}

describe('AgentGateway session login and lease', () => {
  let presence: Record<string, any>;
  let commands: { issueSessionUnlock: ReturnType<typeof vi.fn> };
  let handler: { [K in keyof StationSessionHandler]: ReturnType<typeof vi.fn> };
  let port: StationSessionPort;
  let gateway: AgentGateway;
  let socket: FakeSocket;
  let seq: number;

  const frame = (type: string, payload: unknown, id: string = randomUUID()) =>
    Buffer.from(JSON.stringify({ type, id, ts: new Date().toISOString(), seq: ++seq, payload }));

  const receive = (type: string, payload: unknown, id?: string) =>
    (gateway as any).handleMessage(socket, frame(type, payload, id)) as Promise<void>;

  const sentOf = (type: string) => socket.sent.filter((f) => f.type === type);

  beforeEach(async () => {
    seq = 0;
    presence = {
      statusChanges: new Subject(),
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      touch: vi.fn(async () => undefined),
      reportState: vi.fn(async () => undefined),
      sessionOf: vi.fn(() => 'sess-1'),
    };
    commands = { issueSessionUnlock: vi.fn(async () => true) };
    handler = {
      login: vi.fn(async () => ({ accepted: true, sessionId: 'sess-1', lease: { leaseSeconds: 120, serverTime: new Date().toISOString() } })),
      lease: vi.fn(async () => ({ leaseSeconds: 90, serverTime: new Date().toISOString() })),
      reconcile: vi.fn(async () => undefined),
    };
    port = new StationSessionPort();
    port.register(handler as unknown as StationSessionHandler);
    gateway = new AgentGateway(
      {} as any,
      new AgentRegistry(),
      presence as any,
      {} as any,
      {} as any,
      commands as any,
      {} as any,
      {} as any,
      port,
    );

    socket = new FakeSocket();
    const request = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };
    (gateway as any).principals.set(request, PRINCIPAL);
    (gateway as any).handleConnection(socket, request);
    await receive('handshake', { serialNumber: 'SN-1' });
    expect(sentOf('handshake_ack')).toHaveLength(1);
  });

  it('answers an accepted login with login_result echoing the request id, then sends the UNLOCK with a lease', async () => {
    const sentBeforeUnlock: string[] = [];
    commands.issueSessionUnlock.mockImplementation(async () => {
      sentBeforeUnlock.push(...socket.sent.map((f) => f.type));
      return true;
    });
    const requestId = randomUUID();
    await receive('login_request', { method: 'pin', credential: '482193' }, requestId);

    expect(handler.login).toHaveBeenCalledWith({ machineId: 'm1', branchId: 'b1', serialNumber: 'SN-1' }, 'pin', '482193');
    expect(sentOf('login_result')).toEqual([expect.objectContaining({ payload: { requestId, accepted: true } })]);
    expect(commands.issueSessionUnlock).toHaveBeenCalledWith(
      'm1',
      { sessionId: 'sess-1', leaseSeconds: 120, serverTime: expect.any(String) },
      'login accepted',
    );
    // The UNLOCK is only issued once the login_result is on the wire.
    expect(sentBeforeUnlock).toContain('login_result');
  });

  it('answers a rejected login with the reason and never unlocks', async () => {
    handler.login.mockResolvedValueOnce({ accepted: false, reason: 'invalid_pin' });
    const requestId = randomUUID();
    await receive('login_request', { method: 'pin', credential: '000000' }, requestId);
    expect(sentOf('login_result')).toEqual([
      expect.objectContaining({ payload: { requestId, accepted: false, reason: 'invalid_pin' } }),
    ]);
    expect(commands.issueSessionUnlock).not.toHaveBeenCalled();
  });

  it('rejects the login, without unlocking, when the check itself fails or no handler is registered', async () => {
    handler.login.mockRejectedValueOnce(new Error('db down'));
    await receive('login_request', { method: 'pin', credential: '482193' });
    expect(sentOf('login_result')[0].payload).toMatchObject({ accepted: false, reason: 'unavailable' });

    (port as any).handler = undefined;
    await receive('login_request', { method: 'pin', credential: '482193' });
    expect(sentOf('login_result')[1].payload).toMatchObject({ accepted: false, reason: 'unavailable' });
    expect(commands.issueSessionUnlock).not.toHaveBeenCalled();
  });

  it('drops a malformed login_request without answering or crashing, and keeps serving the socket', async () => {
    await receive('login_request', { method: 'pin' });
    await receive('login_request', 'not an object');
    await receive('login_request', { method: '', credential: 7 });
    expect(sentOf('login_result')).toHaveLength(0);
    expect(handler.login).not.toHaveBeenCalled();

    await receive('heartbeat', { locked: true, sessionId: null });
    expect(sentOf('heartbeat_ack')).toHaveLength(1);
  });

  it('renews the lease on every heartbeat_ack, for the session the station reports', async () => {
    await receive('heartbeat', { locked: false, sessionId: 'sess-1' });
    await receive('heartbeat', { locked: false, sessionId: 'sess-1' });
    const acks = sentOf('heartbeat_ack');
    expect(acks).toHaveLength(2);
    for (const ack of acks) {
      expect(ack.payload).toEqual({ leaseSeconds: 90, serverTime: expect.any(String) });
      expect(ack.payload).not.toHaveProperty('leaseExpiresAt');
    }
    expect(handler.lease).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'm1' }), 'sess-1');
  });

  it('falls back to the last presence-known session for a malformed heartbeat, and still acks with a lease', async () => {
    await receive('heartbeat', { locked: 'nope' });
    expect(handler.lease).toHaveBeenCalledWith(expect.anything(), 'sess-1');
    expect(sentOf('heartbeat_ack')[0].payload).toMatchObject({ leaseSeconds: 90 });
  });

  it('fails closed when a renewal cannot be computed: the lease already granted is re-sent, never extended', async () => {
    await receive('heartbeat', { locked: false, sessionId: 'sess-1' }); // granted 90s
    handler.lease.mockRejectedValueOnce(new Error('db down'));
    await receive('heartbeat', { locked: false, sessionId: 'sess-1' });
    const fallback = sentOf('heartbeat_ack')[1].payload.leaseSeconds as number;
    expect(fallback).toBeGreaterThanOrEqual(89);
    expect(fallback).toBeLessThanOrEqual(90);

    (port as any).handler = undefined;
    const fresh = new FakeSocket();
    const request = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };
    (gateway as any).principals.set(request, PRINCIPAL);
    (gateway as any).handleConnection(fresh, request);
    socket = fresh;
    seq = 0;
    await receive('handshake', { serialNumber: 'SN-1' });
    await receive('heartbeat', { locked: false, sessionId: 'sess-1' });
    expect(sentOf('heartbeat_ack')[0].payload).toMatchObject({ leaseSeconds: 0 });
  });

  it('reconciles a state_report after presence has recorded it', async () => {
    const report = { locked: true, sessionId: 'sess-1', runningGameId: null, leaseExpiresAt: null };
    await receive('state_report', report);
    expect(presence.reportState).toHaveBeenCalledWith('SN-1', report);
    expect(handler.reconcile).toHaveBeenCalledWith({ machineId: 'm1', branchId: 'b1', serialNumber: 'SN-1' }, report);
    expect(presence.reportState.mock.invocationCallOrder[0]).toBeLessThan(handler.reconcile.mock.invocationCallOrder[0]);
  });
});
