import { AuthContext } from "./auth";

declare module "fastify" {
  interface FastifyRequest {
    /** Populated by the `authenticate` hook after a valid Bearer JWT. */
    auth?: AuthContext;
  }
}

export {};
