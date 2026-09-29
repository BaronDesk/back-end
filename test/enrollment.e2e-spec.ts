import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';

import { hash } from '@node-rs/argon2';
import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';

import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/infra/prisma/prisma.service.js';

describe('machine enrollment (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
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
    await app.getHttpAdapter().getInstance().ready();

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

  function enrollmentPayload(
    oneTimeToken: string,
    serialNumber: string,
    keyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }),
  ) {
    const agentPublicKey = keyPair.publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString();
    const fields = {
      oneTimeToken,
      serialNumber,
      machineName: 'Test station',
      agentVersion: '1.0.0',
      agentPublicKey,
      mac: '00:11:22:33:44:55',
      ip: '192.0.2.10',
      signedAt: Date.now(),
    };
    const canonical = `BARONDESK-ENROLL-V1\n${fields.oneTimeToken}\n${fields.serialNumber}\n${fields.mac}\n${fields.ip}\n${fields.agentPublicKey}\n${fields.signedAt}`;
    return {
      fields,
      keyPair,
      payload: {
        ...fields,
        signature: sign(
          'sha256',
          Buffer.from(canonical),
          keyPair.privateKey,
        ).toString('base64'),
      },
    };
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

  it('rejects an enrollment token that was never issued', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/enrollment/request',
      payload: enrollmentPayload(
        'not-a-real-token-000000000000',
        `SN-${randomUUID()}`,
      ).payload,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      status: 'REJECTED',
      reason: 'INVALID_ENROLLMENT_TOKEN',
    });
  });

  it('walks a station through issue -> enroll -> rotate -> revoke', async () => {
    const issue = await app.inject({
      method: 'POST',
      url: '/machines/enrollment-tokens',
      headers: auth(managerToken),
      payload: { branchId },
    });
    expect(issue.statusCode).toBe(201);
    const { token } = issue.json();

    const serialNumber = `SN-${randomUUID()}`;
    const enrollment = enrollmentPayload(token, serialNumber);
    const redeem = await app.inject({
      method: 'POST',
      url: '/enrollment/request',
      payload: enrollment.payload,
    });
    expect(redeem.statusCode).toBe(201);
    expect(redeem.json()).toMatchObject({
      status: 'ENROLLED',
      machineId: expect.any(String),
      stationToken: expect.any(String),
    });
    const machineId = redeem.json().machineId as string;
    expect(
      (await prisma.machine.findUniqueOrThrow({ where: { id: machineId } }))
        .enrollmentStatus,
    ).toBe('ENROLLED');

    // the same token can't be redeemed twice
    const replay = await app.inject({
      method: 'POST',
      url: '/enrollment/request',
      payload: enrollmentPayload(token, `SN-${randomUUID()}`).payload,
    });
    expect(replay.json()).toEqual({
      status: 'REJECTED',
      reason: 'INVALID_ENROLLMENT_TOKEN',
    });

    const rotate = await app.inject({
      method: 'POST',
      url: `/machines/${machineId}/rotate-token`,
      headers: auth(managerToken),
    });
    expect(rotate.statusCode).toBe(201);
    const { token: rotateToken } = rotate.json();

    // rotating with the wrong serial number is rejected
    const wrongSerial = await app.inject({
      method: 'POST',
      url: '/enrollment/request',
      payload: enrollmentPayload(rotateToken, `SN-${randomUUID()}`).payload,
    });
    expect(wrongSerial.statusCode).toBe(409);

    // issue a fresh rotation token since the previous one got consumed by the failed attempt above
    const rotateAgain = await app.inject({
      method: 'POST',
      url: `/machines/${machineId}/rotate-token`,
      headers: auth(managerToken),
    });
    const { token: rotateToken2 } = rotateAgain.json();

    const rotatedKeyPair = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    });
    const rotateRedeem = await app.inject({
      method: 'POST',
      url: '/enrollment/request',
      payload: enrollmentPayload(rotateToken2, serialNumber, rotatedKeyPair)
        .payload,
    });
    expect(rotateRedeem.statusCode).toBe(201);
    expect(rotateRedeem.json()).toMatchObject({
      status: 'ENROLLED',
      machineId,
      stationToken: expect.any(String),
    });

    const get = await app.inject({
      method: 'GET',
      url: `/machines/${machineId}`,
      headers: auth(managerToken),
    });
    expect(get.statusCode).toBe(200);
    expect(get.json().agentPublicKey).toBe(
      rotatedKeyPair.publicKey
        .export({ type: 'spki', format: 'pem' })
        .toString(),
    );

    const revoke = await app.inject({
      method: 'POST',
      url: `/machines/${machineId}/revoke`,
      headers: auth(managerToken),
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json().enrollmentStatus).toBe('DEACTIVATED');
  });

  it('rejects a fresh enrollment with a serial number that is already registered', async () => {
    const issue1 = await app.inject({
      method: 'POST',
      url: '/machines/enrollment-tokens',
      headers: auth(managerToken),
      payload: { branchId },
    });
    const serialNumber = `SN-${randomUUID()}`;
    await app.inject({
      method: 'POST',
      url: '/enrollment/request',
      payload: enrollmentPayload(issue1.json().token, serialNumber).payload,
    });

    const issue2 = await app.inject({
      method: 'POST',
      url: '/machines/enrollment-tokens',
      headers: auth(managerToken),
      payload: { branchId },
    });
    const dupe = await app.inject({
      method: 'POST',
      url: '/enrollment/request',
      payload: enrollmentPayload(issue2.json().token, serialNumber).payload,
    });
    expect(dupe.statusCode).toBe(409);
  });
});
