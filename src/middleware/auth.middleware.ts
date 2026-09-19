import { FastifyRequest } from "fastify";
import { verifyAccessToken } from "../lib/jwt";
import { UnauthorizedError } from "../lib/app-error";
import { prisma } from "../lib/prisma";
import { AuthContext } from "../shared/types/auth";

/** Parses and verifies the Bearer token, or throws UnauthorizedError. */
function parseAuthContext(req: FastifyRequest): AuthContext {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    throw new UnauthorizedError("Missing bearer token");
  }

  const token = header.slice("Bearer ".length).trim();
  const claims = verifyAccessToken(token);

  return {
    sub: claims.sub,
    role: claims.role,
    scope: claims.scope,
    branchId: claims.branchId,
    jti: claims.jti,
  };
}

/**
 * `preHandler` hook: verifies `Authorization: Bearer <accessToken>` and
 * attaches the decoded claims to `req.auth`. Every route except `public` ones
 * should use it. Does not hit the DB — the JWT itself is the source of truth
 * for the request's identity/role/scope/branch, keeping the hot path cheap.
 */
export async function authenticate(req: FastifyRequest): Promise<void> {
  req.auth = parseAuthContext(req);
}

/**
 * Like `authenticate`, but re-checks the account against the DB and rejects
 * suspended/deleted/inactive accounts. Use on sensitive, low-traffic
 * endpoints (e.g. issuing new employee credentials).
 */
export function authenticateFresh() {
  return async (req: FastifyRequest): Promise<void> => {
    req.auth = parseAuthContext(req);

    const user = await prisma.user.findUnique({
      where: { id: req.auth.sub },
      select: { accountStatus: true },
    });

    if (!user || user.accountStatus !== "ACTIVE") {
      throw new UnauthorizedError("Account is not active", "ACCOUNT_INACTIVE");
    }
  };
}
