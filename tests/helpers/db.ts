import { createFakePrisma } from "./fake-prisma";

/** The one in-memory Prisma stand-in shared by the whole test process. Reset before every test (tests/setup.ts). */
export const fakePrisma = createFakePrisma();

export const db = () => fakePrisma.__db;
