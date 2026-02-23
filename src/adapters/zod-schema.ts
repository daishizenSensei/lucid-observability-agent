import { z } from 'zod';
import type { ToolParamDef } from '../core/tools/types.js';

function paramToZod(def: ToolParamDef): z.ZodType {
  let schema: z.ZodType;

  switch (def.type) {
    case 'string':
      schema = z.string();
      break;
    case 'number': {
      let num = z.number();
      if (def.min !== undefined) num = num.min(def.min);
      if (def.max !== undefined) num = num.max(def.max);
      schema = num;
      break;
    }
    case 'boolean':
      schema = z.boolean();
      break;
    case 'enum':
      schema = z.enum(def.values as [string, ...string[]]);
      break;
    case 'object':
      if (def.properties) {
        schema = toZodSchema(def.properties);
      } else {
        schema = z.record(z.string(), z.unknown());
      }
      break;
    case 'array':
      schema = z.array(def.items ? paramToZod(def.items) : z.unknown());
      break;
    default:
      schema = z.unknown();
  }

  if (def.description) {
    schema = schema.describe(def.description);
  }

  return schema;
}

export function toZodSchema(params: Record<string, ToolParamDef>): z.ZodObject<any> {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, def] of Object.entries(params)) {
    let fieldSchema = paramToZod(def);
    if (def.required === false) {
      fieldSchema = fieldSchema.optional();
    }
    if (def.default !== undefined) {
      fieldSchema = (fieldSchema as any).default(def.default);
    }
    shape[key] = fieldSchema;
  }
  return z.object(shape);
}
