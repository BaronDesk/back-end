import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { hash } from '@node-rs/argon2';

import { PrismaClient } from '../src/generated/prisma/index.js';

// @node-rs/argon2's Algorithm is an ambient `const enum`, which isolatedModules
// forbids referencing directly. 2 is Algorithm.Argon2id (also the library default).
const ARGON2ID = 2;

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

async function main() {
  const username = process.env.SEED_ADMIN_USERNAME ?? 'hq-admin';
  const password = process.env.SEED_ADMIN_PASSWORD ?? 'change-me-immediately';

  const passwordHash = await hash(password, { algorithm: ARGON2ID });

  const admin = await prisma.user.upsert({
    where: { username },
    update: {},
    create: {
      username,
      passwordHash,
      role: 'ADMIN',
      accountStatus: 'ACTIVE',
    },
  });

  console.log(`seeded hq ADMIN: ${admin.username} (${admin.id})`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
