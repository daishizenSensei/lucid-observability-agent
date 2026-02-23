import { Type, type TObject, type TSchema } from '@sinclair/typebox';
import type { ToolParamDef } from '../core/tools/types.js';

function paramToTypeBox(def: ToolParamDef): TSchema {
  let schema: TSchema;

  switch (def.type) {
    case 'string':
      schema = Type.String(def.description ? { description: def.description } : {});
      break;
    case 'number': {
      const opts: Record<string, unknown> = {};
      if (def.description) opts.description = def.description;
      if (def.min !== undefined) opts.minimum = def.min;
      if (def.max !== undefined) opts.maximum = def.max;
      schema = Type.Number(opts);
      break;
    }
    case 'boolean':
      schema = Type.Boolean(def.description ? { description: def.description } : {});
      break;
    case 'enum':
      schema = Type.Union(
        (def.values ?? []).map((v) => Type.Literal(v)),
        def.description ? { description: def.description } : {},
      );
      break;
    case 'object':
      if (def.properties) {
        schema = toTypeBoxSchema(def.properties);
      } else {
        schema = Type.Record(Type.String(), Type.Unknown());
      }
      break;
    case 'array':
      schema = Type.Array(def.items ? paramToTypeBox(def.items) : Type.Unknown());
      break;
    default:
      schema = Type.Unknown();
  }

  if (def.default !== undefined) {
    schema = { ...schema, default: def.default };
  }

  return schema;
}

export function toTypeBoxSchema(params: Record<string, ToolParamDef>): TObject {
  const properties: Record<string, TSchema> = {};
  for (const [key, def] of Object.entries(params)) {
    const fieldSchema = paramToTypeBox(def);
    properties[key] = def.required === false ? Type.Optional(fieldSchema) : fieldSchema;
  }
  return Type.Object(properties, { additionalProperties: false });
}
