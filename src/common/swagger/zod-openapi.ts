import type { INestApplication } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import type { OpenAPIObject } from '@nestjs/swagger';
import { z, type ZodType } from 'zod';

import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';
import { REQUIRE_SCOPE_KEY } from '../decorators/require-scope.decorator.js';
import { RESPONSE_EXAMPLES, type ResponseExample } from './response-examples.js';

type Json = Record<string, any>;

// Nest keeps `@Body/@Query/@Param` pipes under this key, numbered by parameter type.
const ROUTE_ARGS_METADATA = '__routeArguments__';
const RouteParamtypes = { BODY: 3, QUERY: 4, PARAM: 5 } as const;

const SAMPLE_UUID = '3f2b8c1e-7a4d-4e5b-9c61-0d2f8a9b1c34';
const SAMPLE_DATE = '2026-06-01T18:00:00.000Z';
const SAMPLE_DATE_END = '2026-06-01T19:00:00.000Z';

const SCOPE_TEXT: Record<string, string> = {
  self: 'any signed-in user',
  staff: 'staff (employee, manager or admin)',
  admin: 'admin',
  hq: 'headquarters admin',
};

const ERROR_EXAMPLES: Record<string, { description: string; example: Json }> = {
  '400': {
    description: 'Request failed validation',
    example: { error: 'request failed validation', code: 'VALIDATION_ERROR', issues: [{ path: 'machineId', message: 'Invalid UUID' }] },
  },
  '401': { description: 'Missing or invalid access token', example: { error: 'Unauthorized', code: 'UNAUTHORIZED' } },
  '403': { description: 'Caller scope is too low for this endpoint', example: { error: 'Forbidden', code: 'FORBIDDEN' } },
};

/** A plausible value for a JSON Schema node, so every body shows a ready-to-send example. */
function exampleFor(schema: Json, key = ''): unknown {
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (schema.const !== undefined) return schema.const;
  if (schema.enum) return schema.enum[0];
  const variant = schema.anyOf ?? schema.oneOf;
  if (variant) return exampleFor(variant.find((v: Json) => v.type !== 'null') ?? variant[0], key);
  if (schema.allOf) return Object.assign({}, ...schema.allOf.map((s: Json) => exampleFor(s, key)));

  switch (schema.type) {
    case 'object': {
      const out: Json = {};
      for (const [name, child] of Object.entries<Json>(schema.properties ?? {})) {
        // Only required fields: optional ones clutter the example.
        if ((schema.required ?? []).includes(name)) out[name] = exampleFor(child, name);
      }
      return out;
    }
    case 'array':
      return [exampleFor(schema.items ?? {}, key)];
    case 'integer':
    case 'number':
      return Math.min(Math.max(schema.minimum ?? 1, 1), schema.maximum ?? Infinity);
    case 'boolean':
      return true;
    case 'string':
      if (schema.format === 'uuid') return SAMPLE_UUID;
      if (schema.format === 'date-time') return /end|to$/i.test(key) ? SAMPLE_DATE_END : SAMPLE_DATE;
      if (schema.format === 'email') return 'gamer@example.com';
      if (/password/i.test(key)) return 'Passw0rd!2026';
      if (/username/i.test(key)) return 'gamer01';
      if (/token/i.test(key)) return 'eyJhbGciOiJIUzI1NiIs...';
      return schema.minLength && schema.minLength > 6 ? 'x'.repeat(schema.minLength) : 'string';
    default:
      return undefined;
  }
}

function toJsonSchema(schema: ZodType): Json {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any', target: 'openapi-3.0' }) as Json;
  delete json.$schema;
  stripFormatPatterns(json);
  return json;
}

/** Zod adds a huge regex next to `format: uuid|date-time`; the format already says it. */
function stripFormatPatterns(node: unknown): void {
  if (Array.isArray(node)) return node.forEach(stripFormatPatterns);
  if (!node || typeof node !== 'object') return;
  const obj = node as Json;
  if (obj.format === 'uuid' || obj.format === 'date-time') delete obj.pattern;
  Object.values(obj).forEach(stripFormatPatterns);
}

function humanize(methodName: string): string {
  const words = methodName.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function tagOf(controllerName: string): string {
  return controllerName.replace(/Controller$/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

interface RouteInfo {
  controller: string;
  method: string;
  isPublic: boolean;
  scope?: string;
  body?: ZodType;
  query?: ZodType;
  params: Map<number, ZodType>;
}

/** Pulls every route's Zod schemas out of the `@Body(new ZodValidationPipe(...))` metadata. */
function collectRoutes(app: INestApplication): Map<string, RouteInfo> {
  const routes = new Map<string, RouteInfo>();
  const modules = app.get(ModulesContainer, { strict: false });

  for (const module of modules.values()) {
    for (const wrapper of module.controllers.values()) {
      const ctor = wrapper.metatype as (new (...args: any[]) => unknown) | null;
      if (!ctor) continue;
      const proto = ctor.prototype as Record<string, unknown>;

      for (const method of Object.getOwnPropertyNames(proto)) {
        if (method === 'constructor' || typeof proto[method] !== 'function') continue;
        const handler = proto[method] as object;
        const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, ctor, method) ?? {}) as Record<
          string,
          { index: number; pipes?: Array<{ schema?: ZodType }> }
        >;

        const info: RouteInfo = {
          controller: ctor.name,
          method,
          isPublic: Boolean(Reflect.getMetadata(IS_PUBLIC_KEY, handler) ?? Reflect.getMetadata(IS_PUBLIC_KEY, ctor)),
          scope: Reflect.getMetadata(REQUIRE_SCOPE_KEY, handler) ?? Reflect.getMetadata(REQUIRE_SCOPE_KEY, ctor),
          params: new Map(),
        };

        for (const [key, arg] of Object.entries(args)) {
          const type = Number(key.split(':')[0]);
          const schema = arg.pipes?.find((pipe) => pipe?.schema)?.schema;
          if (!schema) continue;
          if (type === RouteParamtypes.BODY) info.body = schema;
          else if (type === RouteParamtypes.QUERY) info.query = schema;
          else if (type === RouteParamtypes.PARAM) info.params.set(arg.index, schema);
        }
        routes.set(`${ctor.name}_${method}`, info);
      }
    }
  }
  return routes;
}

function errorResponses(info: RouteInfo): Json {
  const out: Json = {};
  const add = (status: string) => {
    const { description, example } = ERROR_EXAMPLES[status];
    out[status] = { description, content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' }, example } } };
  };
  if (info.body || info.query || info.params.size) add('400');
  if (!info.isPublic) {
    add('401');
    if (info.scope && info.scope !== 'self') add('403');
  }
  return out;
}

function applyResponseExample(operation: Json, example: ResponseExample, defaultStatus: string) {
  const status = String(example.status ?? defaultStatus);
  const prior = operation.responses?.[status] ?? {};
  operation.responses = {
    ...operation.responses,
    [status]: {
      description: example.description ?? prior.description ?? 'Success',
      content: { 'application/json': { example: example.body } },
    },
  };
}

/**
 * Fills the gaps the Nest Swagger scanner leaves because this project validates
 * with Zod pipes instead of DTO classes: request bodies, query params, examples,
 * auth requirements and error shapes. Nothing in the controllers changes.
 */
export function enrichDocumentFromZod(app: INestApplication, doc: OpenAPIObject): OpenAPIObject {
  const routes = collectRoutes(app);

  doc.components ??= {};
  doc.components.schemas ??= {};
  doc.components.schemas.ErrorResponse = {
    type: 'object',
    required: ['error', 'code'],
    properties: {
      error: { type: 'string', example: 'request failed validation' },
      code: { type: 'string', example: 'VALIDATION_ERROR' },
      issues: {
        type: 'array',
        items: { type: 'object', properties: { path: { type: 'string' }, message: { type: 'string' } } },
      },
    },
  };

  const tags = new Set<string>();

  for (const item of Object.values(doc.paths)) {
    for (const [verb, op] of Object.entries(item as Record<string, Json>)) {
      if (!op?.operationId) continue;
      const info = routes.get(op.operationId);
      if (!info) continue;

      const tag = tagOf(info.controller);
      tags.add(tag);
      op.tags = [tag];
      const name = humanize(info.method);
      op.summary ??= name.includes(' ') ? name : `${name} (${tag.toLowerCase()})`;

      op.security = info.isPublic ? [] : [{ bearer: [] }];
      const access = info.isPublic ? 'Public, no token needed.' : `Needs a bearer token. Minimum scope: **${info.scope ?? 'self'}** (${SCOPE_TEXT[info.scope ?? 'self'] ?? info.scope}).`;
      op.description = [op.description, access].filter(Boolean).join('\n\n');

      if (info.body) {
        const schema = toJsonSchema(info.body);
        op.requestBody = {
          required: true,
          content: { 'application/json': { schema, example: exampleFor(schema) } },
        };
      }

      if (info.query) {
        const schema = toJsonSchema(info.query);
        const required = new Set<string>(schema.required ?? []);
        op.parameters = (op.parameters ?? []).filter((p: Json) => p.in !== 'query');
        for (const [name, child] of Object.entries<Json>(schema.properties ?? {})) {
          op.parameters.push({ name, in: 'query', required: required.has(name), schema: child, example: exampleFor(child, name) });
        }
      }

      for (const param of (op.parameters ?? []) as Json[]) {
        if (param.in !== 'path') continue;
        param.example ??= SAMPLE_UUID;
        param.schema = { type: 'string', format: 'uuid' };
      }

      const ok = verb === 'post' && !op.responses?.['200'] ? '201' : '200';
      const example = RESPONSE_EXAMPLES[op.operationId];
      op.responses ??= {};
      if (example) applyResponseExample(op, example, op.responses['200'] ? '200' : ok);
      Object.assign(op.responses, errorResponses(info));
    }
  }

  doc.tags = [...tags].sort().map((name) => ({ name }));
  return doc;
}
