# Add Python dictionary and container type support

## Summary

Extend the Python type analyzer so annotated mappings and common container
types can be represented, generated, validated, and displayed by NaNofuzz.

## What changed

- Added `ArgTag.DICTIONARY`, which retains a mapping's key and value types.
- Added support for `dict[K, V]`, `typing.Dict[K, V]`, `Mapping[K, V]`, and
  `MutableMapping[K, V]` annotations.
- Added support for common list-like annotations: `List`, `Sequence`,
  `MutableSequence`, `Iterable`, and `Collection`.
- Added JSON-array modeling for `set`, `frozenset`, `Set`, and `FrozenSet`.
- Normalized tree-sitter's distinct AST shapes for built-in generic syntax and
  qualified `typing.X[...]` syntax.
- Updated input generation, validation, mutation, AI-schema conversion, type
  rendering, and the UI to handle dictionary types.
- Added Jasmine coverage for nested dictionaries, `typing.Dict`, sets, unions,
  and `Optional`.

## Notes

- Dictionary inputs cross the JSON boundary as JavaScript objects, so their
  keys are serialized as strings.
- Python execution itself is still outside this change: `PythonRunner.ts` is
  currently unimplemented. This PR prepares type analysis and generated input
  handling for when that runner is available.

## Verification

```bash
yarn run lint:errors
node --no-experimental-strip-types ./node_modules/jasmine/bin/jasmine.js \
  --filter='extracts built-in and typing dictionary/container annotations'
```

Expected focused-test result:

```text
Ran 1 of 207 specs
1 spec, 0 failures
```
