import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FIXTURE_ROOT = fileURLToPath(new URL("../../fixtures/", import.meta.url));

export interface FixtureCase<I, O> {
  readonly input: I;
  readonly output: O;
}

interface FamilyFile {
  readonly family: string;
  readonly functions: Readonly<Record<string, readonly FixtureCase<unknown, unknown>[]>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads `web/fixtures/<relPath>` as JSON. `T` is the caller's claim about the file's shape. */
export function readFixture<T>(relPath: string): T {
  return JSON.parse(readFileSync(FIXTURE_ROOT + relPath, "utf8")) as T;
}

function parseFamily(relPath: string, raw: unknown): FamilyFile {
  if (!isRecord(raw) || typeof raw["family"] !== "string" || !isRecord(raw["functions"])) {
    throw new Error(`${relPath}: not a fixture family file`);
  }
  return raw as unknown as FamilyFile;
}

/**
 * Cases the Python exporter recorded for one function of a family, e.g.
 * `fixtureCases<string, string>("cache", "cache_key")`. `I` and `O` are the
 * caller's claim about the recorded input and output.
 */
export function fixtureCases<I, O>(family: string, fn: string): readonly FixtureCase<I, O>[] {
  const relPath = `core/${family}.json`;
  const file = parseFamily(relPath, readFixture<unknown>(relPath));
  const cases = file.functions[fn];
  if (cases === undefined || cases.length === 0) {
    throw new Error(`${relPath}: no cases recorded for ${fn}`);
  }
  return cases as readonly FixtureCase<I, O>[];
}
