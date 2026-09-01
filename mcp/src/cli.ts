#!/usr/bin/env node
/**
 * Executable entry point (the package's `bin`).
 *
 * Deliberately a separate file from index.ts: the module has to be
 * importable by the tests without seizing stdio, and the previous
 * approach — comparing import.meta.url with process.argv[1] to detect
 * "run as a program" — silently did nothing under npx, which launches the
 * bin through a symlink in node_modules/.bin so the two never match. A
 * dedicated entry file has no such heuristic to get wrong.
 */
import { start } from "./index.js";

start();
