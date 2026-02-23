import { Type, type TObject, type TSchema } from '@sinclair/typebox';
import type { ToolParamDef } from '../core/tools/types.js';

function paramToTypeBox(def: ToolParamDef): TSchema {
  switch (def.type) {
    case 'string':
      return Type.String(def.description ? { description: def.description } : {});
    case 'number': {
      const opts: Record<string, unknown> = {};
      if (def.description) opts.description = def.description;
      if (def.min !== undefined) opts.minimum = def.min;
      if (def.max !== undefined) opts.maximum = def.max;
      return Type.Number(opts);
    }
    case 'boolean':
      return Type.Boolean(def.description ? { description: def.description } : {});
    case 'enum':
      return Type.Union(
        (def.values ?? []).map((v) => Type.Literal(v)),
        def.description ? { description: def.description } : {},
      );
    case 'object':
      if (def.properties) {
        return toTypeBoxSchema(def.properties);
      }
      return Type.Record(Type.String(), Type.Unknown());
    case 'array':
      return Type.Array(def.items ? paramToTypeBox(def.items) : Type.Unknown());
    default:
      return Type.Unknown();
  }
}

export function toTypeBoxSchema(params: Record<string, ToolParamDef>): TObject {
  const properties: Record<string, TSchema> = {};
  for (const [key, def] of Object.entries(params)) {
    const fieldSchema = paramToTypeBox(def);
    properties[key] = def.required === false ? Type.Optional(fieldSchema) : fieldSchema;
  }
  return Type.Object(properties, { additionalProperties: false });
}
