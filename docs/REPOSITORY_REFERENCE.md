# NaNofuzz Repository Reference Guide

This document is a practical map of the NaNofuzz repository for contributors, maintainers, and anyone exploring the codebase.

> Note: This repository is primarily TypeScript-based. It does not currently contain Python source files for the main extension logic.

## 1. Repository at a Glance

- Project name: NaNofuzz
- Type: Visual Studio Code extension for automatic test generation
- Primary language: TypeScript
- Main package entry: [package.json](../package.json)
- Extension entry point: [src/extension.ts](../src/extension.ts)

## 2. Top-Level Structure

- [README.md](../README.md) — high-level project overview, usage, and research context
- [CONTRIBUTING.md](../CONTRIBUTING.md) — setup, development, testing, and contribution workflow
- [package.json](../package.json) — scripts, extension metadata, and VS Code contribution points
- [tsconfig.json](../tsconfig.json) — TypeScript compiler configuration
- [build.mjs](../build.mjs) — build pipeline entry
- [eslint.config.mjs](../eslint.config.mjs) — linting configuration
- [flake.nix](../flake.nix) — Nix-based dev environment support
- [docs/](../docs/) — generated documentation and site assets
- [packages/runtime/](../packages/runtime/) — runtime package used by consumers
- [src/](../src/) — main extension source code
- [spec/](../spec/) — test support and Jasmine configuration

## 3. Where to Start When Contributing

### Contribution guide

Use [CONTRIBUTING.md](../CONTRIBUTING.md) for:

- prerequisites and local setup
- installing dependencies
- build and test commands
- how to run the extension locally
- how to fork, branch, and open a pull request

### Main extension entry point

Start here if you want to understand how the extension boots:

- [src/extension.ts](../src/extension.ts)

This file registers the VS Code commands, webview panel, CodeLens providers, and listeners that activate the extension.

### Core fuzzer workflow

Most of the interesting logic lives under:

- [src/fuzzer/](../src/fuzzer/)

This folder contains the main processing pipeline for:

- input generation
- test execution
- analysis
- oracles
- metrics and coverage
- adapters to LLMs or test frameworks

## 4. Where the AST and TypeScript Analysis Live

If you are working on parsing, type analysis, or abstract syntax tree (AST) handling, the key place is:

- [src/fuzzer/analysis/typescript/TypescriptProgram.ts](../src/fuzzer/analysis/typescript/TypescriptProgram.ts)

This file is the main AST-oriented analysis component. It:

- parses TypeScript source using Babel parser support
- builds a program representation from source
- discovers functions, types, imports, and exports
- resolves types and prepares analysis data for the fuzzer

Other related analysis files include:

- [src/fuzzer/analysis/ArgDef.ts](../src/fuzzer/analysis/ArgDef.ts) — argument definition logic
- [src/fuzzer/analysis/FunctionDef.ts](../src/fuzzer/analysis/FunctionDef.ts) — function-level analysis model
- [src/fuzzer/analysis/ArgDefGenerator.ts](../src/fuzzer/analysis/ArgDefGenerator.ts) — generation of argument definitions
- [src/fuzzer/analysis/ArgDefValidator.ts](../src/fuzzer/analysis/ArgDefValidator.ts) — validation logic
- [src/fuzzer/analysis/Util.ts](../src/fuzzer/analysis/Util.ts) — helper utilities

### In short

- If you want to change how the project parses TypeScript code, look in [src/fuzzer/analysis/typescript/TypescriptProgram.ts](../src/fuzzer/analysis/typescript/TypescriptProgram.ts).
- If you want to change how arguments and function signatures are modeled, look in [src/fuzzer/analysis/ArgDef.ts](../src/fuzzer/analysis/ArgDef.ts) and [src/fuzzer/analysis/FunctionDef.ts](../src/fuzzer/analysis/FunctionDef.ts).

## 5. Main Source Directories

### src/fuzzer/

The core engine of NaNofuzz.

Subdirectories:

- [src/fuzzer/analysis/](../src/fuzzer/analysis/) — static analysis, AST handling, type resolution, and argument modeling
- [src/fuzzer/adapters/](../src/fuzzer/adapters/) — integrations with test frameworks and LLM providers
- [src/fuzzer/generators/](../src/fuzzer/generators/) — input generation strategies
- [src/fuzzer/measures/](../src/fuzzer/measures/) — coverage and failure measurement
- [src/fuzzer/oracles/](../src/fuzzer/oracles/) — correctness oracles and test validation
- [src/fuzzer/runners/](../src/fuzzer/runners/) — execution logic for generated tests

### src/ui/

User interface and webview code:

- [src/ui/FuzzPanelController.ts](../src/ui/FuzzPanelController.ts)
- [src/ui/FuzzPanelView.ts](../src/ui/FuzzPanelView.ts)
- [src/ui/CoverageHeatmap.ts](../src/ui/CoverageHeatmap.ts)

### src/telemetry/

Telemetry and logging infrastructure:

- [src/telemetry/Telemetry.ts](../src/telemetry/Telemetry.ts)
- [src/telemetry/Logger.ts](../src/telemetry/Logger.ts)

## 6. Tests and Validation

Tests are mostly colocated with the relevant implementation files and can also be found under [src/fuzzer/](../src/fuzzer/).

Common test entry points:

- [src/fuzzer/Fuzzer.test.ts](../src/fuzzer/Fuzzer.test.ts)
- [src/fuzzer/adapters/JestAdapter.test.ts](../src/fuzzer/adapters/JestAdapter.test.ts)
- [src/fuzzer/analysis/ArgDef.test.ts](../src/fuzzer/analysis/ArgDef.test.ts)
- [src/fuzzer/analysis/ArgDefValidator.test.ts](../src/fuzzer/analysis/ArgDefValidator.test.ts)
- [src/fuzzer/analysis/typescript/TypescriptProgram.test.ts](../src/fuzzer/analysis/typescript/TypescriptProgram.test.ts)

Use the test suite via:

- `yarn test`
- `yarn build`

## 7. Runtime Package

If you need to work on the published runtime layer, look in:

- [packages/runtime/](../packages/runtime/)

This package has its own package manifest and build configuration.

## 8. If You Meant Python

There are no Python implementation files in the main extension codebase at the moment. If your intent was to work on a Python-related feature, this repository would likely need a new module or integration layer rather than an existing Python entry point.

## 9. Quick Reference Cheat Sheet

- Want to contribute? Open [CONTRIBUTING.md](../CONTRIBUTING.md).
- Want to understand extension activation? Read [src/extension.ts](../src/extension.ts).
- Want to inspect AST and TypeScript parsing? Read [src/fuzzer/analysis/typescript/TypescriptProgram.ts](../src/fuzzer/analysis/typescript/TypescriptProgram.ts).
- Want to change input generation? Explore [src/fuzzer/generators/](../src/fuzzer/generators/).
- Want to change UI behavior? Explore [src/ui/](../src/ui/).
- Want to add or update tests? Start with files under [src/fuzzer/](../src/fuzzer/) and [spec/](../spec/).
