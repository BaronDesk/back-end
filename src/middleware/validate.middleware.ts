import { FastifyRequest } from "fastify";
import { AnyZodObject, ZodError } from "zod";
import { BadRequestError } from "../lib/app-error";

/**
 * `preHandler` hook that validates { body, params, query } against a Zod
 * object schema shaped like:
 *   z.object({ body: z.object({...}), params: z.object({...}) })
 * Parsed (and coerced/defaulted) values are written back onto the request so
 * handlers get the typed, sanitized data.
 */
export function validate(schema: AnyZodObject) {
  return async (req: FastifyRequest): Promise<void> => {
    try {
      const parsed = schema.parse({
        body: req.body,
        params: req.params,
        query: req.query,
      });
      if (parsed.body) req.body = parsed.body;
      if (parsed.params) req.params = parsed.params;
      if (parsed.query) req.query = parsed.query;
    } catch (err) {
      if (err instanceof ZodError) {
        const detail = err.errors
          .map((e) => `${e.path.join(".") || "body"}: ${e.message}`)
          .join("; ");
        throw new BadRequestError(`Validation failed — ${detail}`, "VALIDATION_ERROR");
      }
      throw err;
    }
  };
}
