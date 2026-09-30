import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';

import { hash } from '@node-rs/argon2';
import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import WebSocket from 'ws';

import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/infra/prisma/prisma.service.js';

describe('machine enrollment (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let baseUrl: string;
  let branchId: string;
  let otherBranchId: string;
  let managerToken: string;

  const password = 'super-secret-1';
  const managerUsername = `mgr-${randomUUID()}`;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    // listening (not just inject) so the /agent-ws upgrade can be exercised
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as { port: number };
    baseUrl = `http://127.0.0.1:${address.port}`;

    prisma = app.get(PrismaService);

    const branch = await prisma.branch.create({
      data: { name: `branch-${randomUUID()}`, location: 'test' },
    });
    branchId = branch.id;
    const other = await prisma.branch.create({
      data: { name: `branch-${randomUUID()}`, location: 'test' },
    });
    otherBranchId = other.id;

    const passwordHash = await hash(password);
    await prisma.user.create({
      data: {
        username: managerUsername,
        passwordHash,
        role: 'MANAGER',
        employeeProfile: {
          create: { managedBranchId: branchId, hireDate: new Date() },
        },
      },
    });

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: managerUsername, password },
    });
    managerToken = login.json().accessToken;
  }, 30_000);

  afterAll(async () => {
    if (!prisma) return;
    await prisma.machine.deleteMany({
      where: { branchId: { in: [branchId, otherBranchId] } },
    });
    await prisma.user.deleteMany({ where: { username: managerUsername } });
    await prisma.branch.deleteMany({
      where: { id: { in: [branchId, otherBranchId] } },
    });
    await app.close();
  });

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  // Strictly increasing across the whole spec: the service refuses a poll
  // whose signedAt does not move forward.
  let lastSignedAt = Date.now();
  const nextSignedAt = () => (lastSignedAt += 1);

  const newKeyPair = () =>
    generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const derPublicKey = (keyPair: ReturnType<typeof newKeyPair>) =>
    keyPair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

  /** A request as the agent builds it: Base64 DER SPKI key, Base64 DER ECDSA-SHA256 signature. */
  function enrollmentPayload(
    oneTimeToken: string,
    serialNumber: string,
    keyPair = newKeyPair(),
  ) {
    const fields = {
      oneTimeToken,
      serialNumber,
      machineName: 'Test station',
      agentVersion: '1.0.0',
      agentPublicKey: derPublicKey(keyPair),
      mac: '00:11:22:33:44:55',
      ip: '192.0.2.10',
      signedAt: nextSignedAt(),
    };
    const canonical = `BARONDESK-ENROLL-V1\n${fields.oneTimeToken}\n${fields.serialNumber}\n${fields.mac}\n${fields.ip}\n${fields.agentPublicKey}\n${fields.signedAt}`;
    return {
      ...fields,
      signature: sign(
        'sha256',
        Buffer.from(canonical),
        keyPair.privateKey,
      ).toString('base64'),
    };
  }

  function request(payload: Record<string, unknown>) {
    return app.inject({ method: 'POST', url: '/enrollment/request', payload });
  }

  async function issueToken(): Promise<string> {
    const issue = await app.inject({
      method: 'POST',
      url: '/machines/enrollment-tokens',
      headers: auth(managerToken),
      payload: { branchId },
    });
    expect(issue.statusCode).toBe(201);
    return issue.json().token;
  }

  function adminPost(url: string) {
    return app.inject({ method: 'POST', url, headers: auth(managerToken) });
  }

  function agentUpgradeStatus(token: string): Promise<number> {
    const socket = new WebSocket(`${baseUrl.replace('http', 'ws')}/agent-ws`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return new Promise((resolve) => {
      socket.on('unexpected-response', (_req, res) => {
        resolve(res.statusCode ?? 0);
        socket.terminate();
      });
      socket.on('open', () => {
        resolve(101);
        socket.close();
      });
      socket.on('error', () => undefined);
    });
  }

  it('blocks a manager from issuing a token for another branch', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/machines/enrollment-tokens',
      headers: auth(managerToken),
      payload: { branchId: otherBranchId },
    });
    expect(res.statusCode).toBe(403);
  });

  it('answers 200 REJECTED for a token that was never issued', async () => {
    const res = await request(
      enrollmentPayload('not-a-real-token-000000000000', `SN-${randomUUID()}`),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'REJECTED',
      reason: 'INVALID_ENROLLMENT_TOKEN',
    });
  });

  it('answers 200 REJECTED for a malformed body and for a bad signature', async () => {
    const malformed = await request({ serialNumber: 'x' });
    expect(malformed.statusCode).toBe(200);
    expect(malformed.json()).toEqual({
      status: 'REJECTED',
      reason: 'INVALID_REQUEST',
    });

    const payload = enrollmentPayload(await issueToken(), `SN-${randomUUID()}`);
    const tampered = await request({ ...payload, mac: '00:00:00:00:00:00' });
    expect(tampered.statusCode).toBe(200);
    expect(tampered.json()).toEqual({
      status: 'REJECTED',
      reason: 'INVALID_SIGNATURE',
    });
  });

  it('enrolls through PENDING -> approve -> ENROLLED, and the issued token opens /agent-ws and the station catalog', async () => {
    const token = await issueToken();
    const serialNumber = `SN-${randomUUID()}`;
    const keyPair = newKeyPair();

    const first = await request(enrollmentPayload(token, serialNumber, keyPair));
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({
      status: 'PENDING',
      machineId: expect.any(String),
    });
    const machineId = first.json().machineId as string;
    const pending = await prisma.machine.findUniqueOrThrow({
      where: { id: machineId },
    });
    expect(pending.enrollmentStatus).toBe('PENDING');
    expect(pending.agentPublicKey).toBe(derPublicKey(keyPair));

    // polling before approval stays PENDING and does not burn the token
    const poll = await request(enrollmentPayload(token, serialNumber, keyPair));
    expect(poll.json()).toEqual({ status: 'PENDING', machineId });

    // another key for the same serial is refused
    const impostor = await request(enrollmentPayload(token, serialNumber));
    expect(impostor.statusCode).toBe(200);
    expect(impostor.json()).toEqual({
      status: 'REJECTED',
      reason: 'PUBLIC_KEY_MISMATCH',
    });

    expect((await adminPost(`/machines/${machineId}/approve`)).statusCode).toBe(200);

    const enrolled = await request(enrollmentPayload(token, serialNumber, keyPair));
    expect(enrolled.statusCode).toBe(200);
    expect(enrolled.json()).toEqual({
      status: 'ENROLLED',
      machineId,
      stationToken: expect.any(String),
    });
    const stationToken = enrolled.json().stationToken as string;

    // token is burned once the station token has been handed out
    const replay = await request(enrollmentPayload(token, serialNumber, keyPair));
    expect(replay.json()).toEqual({
      status: 'REJECTED',
      reason: 'INVALID_ENROLLMENT_TOKEN',
    });

    // the seam: enrollment's token is what the gateway and catalog verify
    expect(await agentUpgradeStatus(stationToken)).toBe(101);
    const catalog = await app.inject({
      method: 'GET',
      url: '/stations/me/games',
      headers: auth(stationToken),
    });
    expect(catalog.statusCode).toBe(200);

    // a station token never passes as a user access token
    const asUser = await app.inject({
      method: 'GET',
      url: '/machines',
      headers: auth(stationToken),
    });
    expect(asUser.statusCode).toBe(401);

    // revoking the machine shuts the same token out
    expect((await adminPost(`/machines/${machineId}/revoke`)).statusCode).toBe(200);
    expect(await agentUpgradeStatus(stationToken)).not.toBe(101);
    const revoked = await app.inject({
      method: 'GET',
      url: '/stations/me/games',
      headers: auth(stationToken),
    });
    expect(revoked.statusCode).toBe(403);
  });

  it('answers REJECTED once an admin rejects the pending machine', async () => {
    const token = await issueToken();
    const serialNumber = `SN-${randomUUID()}`;
    const keyPair = newKeyPair();

    const first = await request(enrollmentPayload(token, serialNumber, keyPair));
    const machineId = first.json().machineId as string;
    expect((await adminPost(`/machines/${machineId}/reject`)).statusCode).toBe(200);

    const poll = await request(enrollmentPayload(token, serialNumber, keyPair));
    expect(poll.statusCode).toBe(200);
    expect(poll.json()).toEqual({
      status: 'REJECTED',
      reason: 'ENROLLMENT_REJECTED',
    });
  });

  it('rotates the credential of an enrolled station', async () => {
    const token = await issueToken();
    const serialNumber = `SN-${randomUUID()}`;
    const keyPair = newKeyPair();
    const machineId = (
      await request(enrollmentPayload(token, serialNumber, keyPair))
    ).json().machineId as string;
    await adminPost(`/machines/${machineId}/approve`);
    await request(enrollmentPayload(token, serialNumber, keyPair));

    const rotate = await adminPost(`/machines/${machineId}/rotate-token`);
    expect(rotate.statusCode).toBe(201);
    const { token: rotateToken } = rotate.json();

    const wrongSerial = await request(
      enrollmentPayload(rotateToken, `SN-${randomUUID()}`),
    );
    expect(wrongSerial.statusCode).toBe(200);
    expect(wrongSerial.json()).toEqual({
      status: 'REJECTED',
      reason: 'SERIAL_NUMBER_MISMATCH',
    });

    const rotatedKeyPair = newKeyPair();
    const rotated = await request(
      enrollmentPayload(rotateToken, serialNumber, rotatedKeyPair),
    );
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json()).toEqual({
      status: 'ENROLLED',
      machineId,
      stationToken: expect.any(String),
    });
    expect(
      (await prisma.machine.findUniqueOrThrow({ where: { id: machineId } }))
        .agentPublicKey,
    ).toBe(derPublicKey(rotatedKeyPair));
  });

  it('refuses a fresh enrollment for a serial number another key already holds', async () => {
    const serialNumber = `SN-${randomUUID()}`;
    await request(enrollmentPayload(await issueToken(), serialNumber));

    const dupe = await request(
      enrollmentPayload(await issueToken(), serialNumber),
    );
    expect(dupe.statusCode).toBe(200);
    expect(dupe.json()).toEqual({
      status: 'REJECTED',
      reason: 'SERIAL_NUMBER_TAKEN',
    });
  });
});
