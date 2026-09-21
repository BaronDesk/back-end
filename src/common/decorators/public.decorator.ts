import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC_KEY = "cstam:is-public";

/**
 * Marks a route as intentionally requiring no authentication.
 *
 *   @Public()
 *   @Post("login")
 *   login() {}
 *
 * Required on every route that has no `@Auth()` / `@RequireScope()` /
 * `@AllowAny()` — see `common/guards/deny-by-default.guard.ts`, which rejects
 * any route carrying none of the four markers. This keeps a route from
 * becoming silently public just because someone forgot to decorate it.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
