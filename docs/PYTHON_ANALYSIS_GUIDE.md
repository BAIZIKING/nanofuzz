# Python Analysis Guide

This note documents the current Python analysis support in the repository and where contributors should look when extending it.

## Overview

NaNofuzz now has a Python analysis scaffold under the analysis layer. The code is designed to follow the same abstraction used for TypeScript analysis, but the Python implementation is still in its early stages.

## Key files

- [src/fuzzer/analysis/AbstractProgram.ts](../src/fuzzer/analysis/AbstractProgram.ts) — shared program-analysis interface and lifecycle
- [src/fuzzer/analysis/ProgramFactory.ts](../src/fuzzer/analysis/ProgramFactory.ts) — dispatches analysis to the correct language implementation
- [src/fuzzer/analysis/python/PythonProgram.ts](../src/fuzzer/analysis/python/PythonProgram.ts) — Python-specific analysis entry point
- [src/fuzzer/analysis/python/PythonProgram.test.ts](../src/fuzzer/analysis/python/PythonProgram.test.ts) — placeholder test file for Python analysis
- [src/fuzzer/analysis/typescript/TypescriptProgram.ts](../src/fuzzer/analysis/typescript/TypescriptProgram.ts) — reference implementation for the existing TypeScript analysis pipeline

## Current status

The repository now includes a Python-specific analysis class, but its methods are not implemented yet. In the current branch:

- the language factory can recognize Python files,
- a Python program wrapper exists,
- the Python implementation still needs parsing and analysis logic,
- the UI layer already includes Python in the supported language list.

## How the analysis dispatch works

The analysis entry point is routed through [src/fuzzer/analysis/ProgramFactory.ts](../src/fuzzer/analysis/ProgramFactory.ts).

That factory decides whether to construct:

- a Python program object, or
- a TypeScript program object

based on the filename extension or an explicit language hint.

## Where to implement Python support

If you want to extend Python analysis, the main place to work is [src/fuzzer/analysis/python/PythonProgram.ts](../src/fuzzer/analysis/python/PythonProgram.ts).

That class is expected to implement the same responsibilities currently handled for TypeScript:

- parsing source into an AST-like structure,
- discovering imports,
- discovering types,
- discovering functions and exports,
- resolving type references,
- returning structured analysis information to the rest of the fuzzer.

## Reference implementation

Use [src/fuzzer/analysis/typescript/TypescriptProgram.ts](../src/fuzzer/analysis/typescript/TypescriptProgram.ts) as the main reference for the existing analysis pipeline.

It shows how the project currently:

- parses source,
- walks the AST,
- extracts definitions,
- builds function/type metadata,
- and resolves references.

## Suggested next steps

1. Implement parsing for Python source.
2. Add import discovery.
3. Add function and type extraction.
4. Add type resolution support.
5. Add tests in [src/fuzzer/analysis/python/PythonProgram.test.ts](../src/fuzzer/analysis/python/PythonProgram.test.ts).

## Notes

This repository is still primarily a TypeScript-based VS Code extension. Python support is currently a scaffold and a planned extension point rather than a completed feature.
