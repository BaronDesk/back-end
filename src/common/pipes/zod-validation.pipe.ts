import { ArgumentMetadata, PipeTransform } from "@nestjs/common";
import { ZodTypeAny, z } from "zod";
import { BadRequestError } from "../../lib/app-error";

/**
 * Validates one request part (`@Body()`, `@Param()` or `@Query()`) against a
 * Zod schema and hands the handler the parsed, sanitized value (unknown keys
 * stripped, defaults/coercions applied).
 *
 *   create(@Body(new ZodValidationPipe(createGamerSchema)) body: CreateGamerInput) {}
 *
 * Pipes run after guards, so authentication/authorization errors still win
 * over validation errors.
 */
export class ZodValidationPipe<T extends ZodTypeAny> implements PipeTransform<unknown, z.output<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown, metadata: ArgumentMetadata): z.output<T> {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;

    const part = metadata.type === "param" ? "params" : metadata.type;
    const detail = result.error.errors
      .map((e) => `${[part, ...e.path].join(".")}: ${e.message}`)
      .join("; ");
    throw new BadRequestError(`Validation failed — ${detail}`, "VALIDATION_ERROR");
  }
}
