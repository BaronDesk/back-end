import { randomUUID } from "node:crypto";

/**
 * A tiny in-memory stand-in for the PrismaClient calls the identity module
 * makes. It lets the whole HTTP stack (hooks, JWT, services) run in tests
 * with no PostgreSQL. It only implements what this module actually uses.
 */
type Row = Record<string, any>;

const match = (where: Row) => (row: Row) => Object.entries(where).every(([k, v]) => row[k] === v);

/** Applies a Prisma-style `select` (including one level of nested selects). */
function pick(row: Row | null, select?: Row): Row | null {
  if (!row) return null;
  if (!select) return { ...row };
  const out: Row = {};
  for (const [key, val] of Object.entries(select)) {
    if (!val) continue;
    out[key] = typeof val === "object" && val.select ? pick(row[key] ?? null, val.select) : row[key];
  }
  return out;
}

function simpleModel(rows: Row[], defaults: () => Row) {
  return {
    async findUnique({ where, select }: { where: Row; select?: Row }) {
      const r = rows.find(match(where));
      return r ? pick(r, select) : null;
    },
    async create({ data }: { data: Row }) {
      const r = { ...defaults(), ...data };
      rows.push(r);
      return { ...r };
    },
    async update({ where, data }: { where: Row; data: Row }) {
      const r = rows.find(match(where));
      if (!r) throw new Error("Record to update not found");
      Object.assign(r, data);
      return { ...r };
    },
  };
}

export function createFakePrisma() {
  const db = {
    users: [] as Row[],
    employeeProfiles: [] as Row[],
    gamerProfiles: [] as Row[],
    refreshTokens: [] as Row[],
    auditLogs: [] as Row[],
  };

  const hydrate = (u: Row) => ({
    ...u,
    employeeProfile: db.employeeProfiles.find((p) => p.userId === u.id) ?? null,
    gamerProfile: db.gamerProfiles.find((p) => p.userId === u.id) ?? null,
  });

  const user = {
    async findUnique({ where, select }: { where: Row; select?: Row }) {
      const u = db.users.find(match(where));
      return u ? pick(hydrate(u), select) : null;
    },
    async create({ data, select }: { data: Row; select?: Row }) {
      const now = new Date();
      const u: Row = {
        id: randomUUID(),
        username: data.username,
        passwordHash: data.passwordHash,
        role: data.role ?? "GAMER",
        accountStatus: "ACTIVE",
        createdAt: now,
        updatedAt: now,
      };
      db.users.push(u);
      if (data.gamerProfile?.create) {
        db.gamerProfiles.push({ userId: u.id, xp: 0, level: 1, ...data.gamerProfile.create });
      }
      if (data.employeeProfile?.create) {
        db.employeeProfiles.push({
          userId: u.id,
          employmentStatus: "ACTIVE",
          ...data.employeeProfile.create,
        });
      }
      return pick(hydrate(u), select);
    },
    async update({ where, data, select }: { where: Row; data: Row; select?: Row }) {
      const u = db.users.find(match(where));
      if (!u) throw new Error("Record to update not found");
      Object.assign(u, data, { updatedAt: new Date() });
      return pick(hydrate(u), select);
    },
  };

  return {
    user,
    employeeProfile: simpleModel(db.employeeProfiles, () => ({})),
    refreshToken: simpleModel(db.refreshTokens, () => ({
      id: randomUUID(),
      revoked: false,
      replacedByJti: null,
      createdAt: new Date(),
    })),
    auditLog: simpleModel(db.auditLogs, () => ({ id: randomUUID(), createdAt: new Date() })),
    async $transaction(ops: Promise<unknown>[]) {
      return Promise.all(ops);
    },
    async $disconnect() {},

    // --- test-only helpers ---
    __db: db,
    __reset() {
      Object.values(db).forEach((rows) => (rows.length = 0));
    },
  };
}

export type FakePrisma = ReturnType<typeof createFakePrisma>;
