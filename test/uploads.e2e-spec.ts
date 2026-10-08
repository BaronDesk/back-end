import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';

import { hash } from '@node-rs/argon2';
import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import sharp from 'sharp';

import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/infra/prisma/prisma.service.js';
import { ImagesService } from '../src/modules/uploads/services/images.service.js';
import { registerUploads } from '../src/modules/uploads/uploads.setup.js';
import { fileOf, MAX_IMAGE_BYTES } from '../src/modules/uploads/util/image-files.js';

/** A multipart/form-data body with one file part, as a browser's FormData sends it. */
function multipart(data: Buffer, filename = 'badge.png', type = 'image/png') {
  const boundary = `----e2e${randomUUID()}`;
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`;
  return {
    payload: Buffer.concat([Buffer.from(head), data, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

const picture = (width = 300, height = 200) =>
  sharp({ create: { width, height, channels: 4, background: { r: 30, g: 140, b: 60, alpha: 1 } } }).png().toBuffer();

describe('image uploads (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let root: string;
  let managerToken: string;
  let gamerToken: string;
  const created = { membershipPlans: [] as string[], subscriptionPlans: [] as string[], ranks: [] as string[] };

  const suffix = randomUUID().slice(0, 8);
  const password = 'super-secret-1';
  const managerUsername = `manager-${suffix}`;
  const gamerUsername = `gamer-${suffix}`;
  const as = (token: string) => ({ authorization: `Bearer ${token}` });
  const onDisk = (url: string) => access(fileOf(root, url)!).then(() => true, () => false);

  const upload = async (token: string, data: Buffer, filename?: string, type?: string) => {
    const body = multipart(data, filename, type);
    return app.inject({ method: 'POST', url: '/uploads/images', payload: body.payload, headers: { ...as(token), ...body.headers } });
  };
  const uploadedUrl = async () => {
    const res = await upload(managerToken, await picture());
    expect(res.statusCode).toBe(201);
    return res.json().url as string;
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await registerUploads(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    prisma = app.get(PrismaService);
    root = app.get(ImagesService).root;

    const passwordHash = await hash(password);
    const branch = await prisma.branch.create({ data: { name: `uploads-${suffix}`, location: 'test' } });
    await prisma.user.create({
      data: {
        username: managerUsername, passwordHash, role: 'MANAGER',
        employeeProfile: { create: { managedBranchId: branch.id, hireDate: new Date() } },
      },
    });
    await app.inject({ method: 'POST', url: '/users', payload: { username: gamerUsername, password, branchId: branch.id } });

    const login = async (username: string) =>
      (await app.inject({ method: 'POST', url: '/auth/login', payload: { username, password } })).json().accessToken as string;
    managerToken = await login(managerUsername);
    gamerToken = await login(gamerUsername);
  });

  afterAll(async () => {
    await prisma.membershipPlan.deleteMany({ where: { id: { in: created.membershipPlans } } });
    await prisma.subscriptionPlan.deleteMany({ where: { id: { in: created.subscriptionPlans } } });
    await prisma.rank.deleteMany({ where: { id: { in: created.ranks } } });
    await prisma.user.deleteMany({ where: { username: { in: [managerUsername, gamerUsername] } } });
    await prisma.branch.deleteMany({ where: { name: `uploads-${suffix}` } });
    await app.close();
  });

  it('stores a picture as WebP and serves it publicly, cached for good', async () => {
    const res = await upload(managerToken, await picture(1200, 600));
    expect(res.statusCode).toBe(201);
    const { url } = res.json();
    expect(url).toMatch(/^\/uploads\/images\/[0-9a-f-]{36}\.webp$/);

    const file = await app.inject({ method: 'GET', url }); // no token: images are public
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('image/webp');
    expect(file.headers['cache-control']).toContain('immutable');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(await sharp(file.rawPayload).metadata()).toMatchObject({ format: 'webp', width: 512, height: 256 });
  });

  it('refuses gamers, non-pictures, big files and bodies without a file', async () => {
    expect((await upload(gamerToken, await picture())).statusCode).toBe(403);

    const pdf = await upload(managerToken, Buffer.from('%PDF-1.7 not a picture'), 'badge.png', 'image/png');
    expect(pdf.statusCode).toBe(400);
    expect(pdf.json()).toMatchObject({ code: 'IMAGE_UNSUPPORTED' });

    const big = await upload(managerToken, Buffer.alloc(MAX_IMAGE_BYTES + 1, 1));
    expect(big.statusCode).toBe(413);
    expect(big.json()).toMatchObject({ code: 'IMAGE_TOO_LARGE' });

    const json = await app.inject({ method: 'POST', url: '/uploads/images', headers: as(managerToken), payload: { url: 'x' } });
    expect(json.statusCode).toBe(400);
    expect(json.json()).toMatchObject({ code: 'IMAGE_REQUIRED' });
  });

  it('serves only the files it wrote', async () => {
    for (const url of ['/uploads/../package.json', '/uploads/%2e%2e/package.json', '/uploads/images/', '/uploads/images/nope.webp']) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBeGreaterThanOrEqual(400);
    }
  });

  it('keeps a tier badge, deletes the old file when it is replaced, and refuses foreign links', async () => {
    const first = await uploadedUrl();
    const plan = await app.inject({
      method: 'POST', url: '/membership-plans', headers: as(managerToken),
      payload: { name: `badge-${suffix}`, price: 5, durationDays: 30, discountPercent: 5, badgeUrl: first },
    });
    expect(plan.statusCode).toBe(201);
    expect(plan.json()).toMatchObject({ badgeUrl: first });
    created.membershipPlans.push(plan.json().id);

    const foreign = await app.inject({
      method: 'PATCH', url: `/membership-plans/${plan.json().id}`, headers: as(managerToken),
      payload: { badgeUrl: 'https://example.com/badge.png' },
    });
    expect(foreign.statusCode).toBe(400);
    expect(await onDisk(first)).toBe(true);

    const second = await uploadedUrl();
    const replaced = await app.inject({
      method: 'PATCH', url: `/membership-plans/${plan.json().id}`, headers: as(managerToken), payload: { badgeUrl: second },
    });
    expect(replaced.json()).toMatchObject({ badgeUrl: second });
    expect(await onDisk(first)).toBe(false);
    expect(await onDisk(second)).toBe(true);

    // Another field changes: the badge, unchanged, stays.
    await app.inject({ method: 'PATCH', url: `/membership-plans/${plan.json().id}`, headers: as(managerToken), payload: { durationDays: 31 } });
    expect(await onDisk(second)).toBe(true);
  });

  it('keeps a file two rows share until neither uses it', async () => {
    const shared = await uploadedUrl();
    const pass = await app.inject({
      method: 'POST', url: '/subscription-plans', headers: as(managerToken),
      payload: { name: `pass-${suffix}`, price: 5, durationDays: 7, benefits: { windows: [] }, badgeUrl: shared },
    });
    expect(pass.statusCode).toBe(201);
    created.subscriptionPlans.push(pass.json().id);
    const rank = await app.inject({
      method: 'POST', url: '/ranks', headers: as(managerToken), payload: { name: `Rank-${suffix}`, minXp: 900_000 + Math.floor(Math.random() * 1000), badgeUrl: shared },
    });
    expect(rank.statusCode).toBe(201);
    created.ranks.push(rank.json().id);

    expect((await app.inject({ method: 'DELETE', url: `/subscription-plans/${pass.json().id}`, headers: as(managerToken) })).statusCode).toBe(200);
    expect(await onDisk(shared)).toBe(true); // the rank still shows it

    expect((await app.inject({ method: 'DELETE', url: `/ranks/${rank.json().id}`, headers: as(managerToken) })).statusCode).toBe(200);
    expect(await onDisk(shared)).toBe(false);
  });

  it('lists the ranks to gamers, lowest XP first, and lets only staff edit them', async () => {
    const list = await app.inject({ method: 'GET', url: '/ranks', headers: as(gamerToken) });
    expect(list.statusCode).toBe(200);
    const xp = (list.json() as { minXp: number }[]).map((r) => r.minXp);
    expect(xp).toEqual([...xp].sort((a, b) => a - b));

    const denied = await app.inject({ method: 'POST', url: '/ranks', headers: as(gamerToken), payload: { name: 'Mine', minXp: 1 } });
    expect(denied.statusCode).toBe(403);
  });

  it("sets, replaces and removes a gamer's own avatar", async () => {
    const put = async () => {
      const body = multipart(await picture(800, 500), 'me.jpg', 'image/jpeg');
      return app.inject({ method: 'PUT', url: '/users/me/avatar', payload: body.payload, headers: { ...as(gamerToken), ...body.headers } });
    };
    const first = await put();
    expect(first.statusCode).toBe(200);
    const firstUrl = first.json().avatarUrl as string;
    expect(firstUrl).toMatch(/^\/uploads\/avatars\/[0-9a-f-]{36}\.webp$/);
    const served = await app.inject({ method: 'GET', url: firstUrl });
    expect(await sharp(served.rawPayload).metadata()).toMatchObject({ width: 256, height: 256 });

    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: as(gamerToken) });
    expect(me.json()).toMatchObject({ avatarUrl: firstUrl });

    const second = await put();
    expect(await onDisk(firstUrl)).toBe(false);

    const removed = await app.inject({ method: 'DELETE', url: '/users/me/avatar', headers: as(gamerToken) });
    expect(removed.json()).toMatchObject({ avatarUrl: null });
    expect(await onDisk(second.json().avatarUrl)).toBe(false);
  });

  it('gives staff no avatar', async () => {
    const body = multipart(await picture());
    const res = await app.inject({ method: 'PUT', url: '/users/me/avatar', payload: body.payload, headers: { ...as(managerToken), ...body.headers } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'NOT_A_GAMER' });
  });
});
