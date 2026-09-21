import { PrismaClient, UserRole } from "../src/generated/prisma";
import { hashPassword } from "../src/lib/password";

const prisma = new PrismaClient();

async function main() {
  const username = process.env.SEED_ADMIN_USERNAME ?? "admin";
  const password = process.env.SEED_ADMIN_PASSWORD ?? "ChangeMe123!";

  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) {
    console.log(`Admin "${username}" already exists — skipping.`);
    return;
  }

  const passwordHash = await hashPassword(password);
  await prisma.user.create({
    data: { username, passwordHash, role: UserRole.ADMIN },
  });
  

  console.log(`Seeded hq ADMIN "${username}". Change the password immediately.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
