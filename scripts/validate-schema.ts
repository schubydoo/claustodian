#!/usr/bin/env node
// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

/**
 * CLI schema validator for Claustodian data files.
 *
 * Usage:
 *   tsx scripts/validate-schema.ts ["data/**\/*.json"]
 *
 * Routes each matched file to the right JSON Schema based on its path:
 *   - path containing "/versions/" or basename "latest.json" -> snapshot schema
 *   - basename "index.json"                                   -> index schema
 *   - basename "schema-version.json"                          -> inline {version: string} schema
 *
 * Exit code 0 if every matched file validates; 1 if any file fails, or an
 * unexpected internal error occurs. A glob that matches zero files is not an
 * error: a notice is printed and the process exits 0.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ErrorObject, ValidateFunction } from 'ajv';
import { glob } from 'tinyglobby';

import symbolSchema from '../schema/symbol.schema.json' with { type: 'json' };
import snapshotSchema from '../schema/snapshot.schema.json' with { type: 'json' };
import indexSchema from '../schema/index.schema.json' with { type: 'json' };

// ajv's and ajv-formats' published .d.ts files use plain ES `export default`
// syntax but ship as CommonJS packages (no "type": "module" in their own
// package.json). Under this repo's NodeNext + esModuleInterop config, a
// direct `import Ajv2020 from 'ajv/dist/2020.js'` default-import type-checks
// incorrectly (TS resolves it to the whole module namespace instead of the
// class). Loading via createRequire + an explicit `typeof import(...)` cast
// sidesteps that mismatch while keeping full static types, and — unlike
// `import X = require(...)` — still runs correctly under tsx's esbuild-based
// transpilation (which does not rewrite that TS-only syntax for ESM output).
const require = createRequire(import.meta.url);
const { Ajv2020 } = require('ajv/dist/2020.js') as typeof import('ajv/dist/2020.js');
const addFormats = (require('ajv-formats') as typeof import('ajv-formats')).default;

const SCHEMA_VERSION_SCHEMA = {
  $id: 'https://schubydoo.github.io/claustodian/schema/schema-version.schema.json',
  type: 'object',
  properties: {
    version: { type: 'string' },
  },
  required: ['version'],
  additionalProperties: false,
} as const;

type SchemaKind = 'snapshot' | 'index' | 'schema-version';
type ValidatorKind = SchemaKind | 'symbol';

export function schemaKindFor(filePath: string): SchemaKind | null {
  const base = basename(filePath);
  if (base === 'index.json') {
    return 'index';
  }
  if (base === 'schema-version.json') {
    return 'schema-version';
  }
  if (base === 'latest.json' || filePath.includes('/versions/')) {
    return 'snapshot';
  }
  return null;
}

export function buildAjv(): InstanceType<typeof Ajv2020> {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(symbolSchema);
  ajv.addSchema(snapshotSchema);
  ajv.addSchema(indexSchema);
  ajv.addSchema(SCHEMA_VERSION_SCHEMA);
  return ajv;
}

export function getValidator(
  ajv: InstanceType<typeof Ajv2020>,
  kind: ValidatorKind
): ValidateFunction {
  const idMap: Record<ValidatorKind, string> = {
    symbol: (symbolSchema as { $id: string }).$id,
    snapshot: (snapshotSchema as { $id: string }).$id,
    index: (indexSchema as { $id: string }).$id,
    'schema-version': SCHEMA_VERSION_SCHEMA.$id,
  };
  const validate = ajv.getSchema(idMap[kind]);
  if (!validate) {
    throw new Error(`No compiled validator found for schema kind "${kind}"`);
  }
  return validate;
}

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  if (!errors || errors.length === 0) {
    return ['(no error details available)'];
  }
  return errors.map((err) => {
    const path = err.instancePath === '' ? '(root)' : err.instancePath;
    return `  instancePath=${path} message=${err.message ?? '(no message)'}`;
  });
}

async function validateFile(ajv: InstanceType<typeof Ajv2020>, filePath: string): Promise<boolean> {
  const kind = schemaKindFor(filePath);
  if (!kind) {
    console.log(`SKIP ${filePath} (no matching schema route)`);
    return true;
  }

  let data: unknown;
  try {
    const raw = await readFile(filePath, 'utf-8');
    data = JSON.parse(raw);
  } catch (err) {
    console.log(`FAIL ${filePath}`);
    console.log(
      `  instancePath=(root) message=could not read/parse file: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return false;
  }

  const validate = getValidator(ajv, kind);
  const valid = validate(data);
  if (valid) {
    console.log(`PASS ${filePath} (${kind})`);
    return true;
  }

  console.log(`FAIL ${filePath} (${kind})`);
  for (const line of formatErrors(validate.errors)) {
    console.log(`  ${filePath} ${line}`);
  }
  return false;
}

async function main(): Promise<number> {
  const patterns = process.argv.slice(2);
  const effectivePatterns = patterns.length > 0 ? patterns : ['data/**/*.json'];

  const files = await glob(effectivePatterns, { absolute: false, dot: false });
  files.sort();

  if (files.length === 0) {
    console.log(
      `No files matched pattern(s): ${effectivePatterns.join(', ')} (nothing to validate)`
    );
    return 0;
  }

  const ajv = buildAjv();

  let allValid = true;
  for (const filePath of files) {
    const ok = await validateFile(ajv, filePath);
    if (!ok) {
      allValid = false;
    }
  }

  return allValid ? 0 : 1;
}

// Only run the CLI when this file is executed directly (e.g. via `tsx
// scripts/validate-schema.ts` or `npm run validate`), not when it's imported
// by tests or other modules.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error('Unexpected error while validating schemas:', err);
      process.exitCode = 1;
    });
}
