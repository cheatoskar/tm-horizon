import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ajv } from 'ajv';
import addFormatsModule from 'ajv-formats';
import type { HubConfig, SourceContext } from '../src/config.ts';
import { loadConfig } from '../src/config.ts';
import { Http } from '../src/lib/http.ts';

export const root = path.resolve(import.meta.dirname, '..');

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(root, 'test', 'fixtures', name), 'utf8')) as T;
}

export function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tm-hub-api-test-'));
}

/** A context with no network: cache in a temp folder, offline. */
export function offlineContext(patch: (c: HubConfig) => void = () => {}, env: Record<string, string | undefined> = {}): SourceContext & { warnings: string[] } {
  const config = loadConfig(path.join(root, 'config', 'hub.config.json'));
  patch(config);
  const http = new Http(tempDir(), 'tm-hub-test');
  http.offline = true;
  const warnings: string[] = [];
  return { http, config, root, env, warn: (m) => warnings.push(m), log: () => {}, warnings };
}

let ajv: Ajv | null = null;
export function validator(name: string) {
  if (!ajv) {
    ajv = new Ajv({ allErrors: true, strict: false });
    const addFormats = addFormatsModule as unknown as (a: Ajv) => void;
    addFormats(ajv);
  }
  const schema = JSON.parse(fs.readFileSync(path.join(root, 'schema', `${name}.json`), 'utf8'));
  return ajv.getSchema(schema.$id) ?? ajv.compile(schema);
}
