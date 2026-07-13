import { ArgTag } from "../Types";
import { PythonProgram } from "./PythonProgram";

class DebugPythonProgram extends PythonProgram {
  public findFunctionsForTest() {
    return this._findFunctions();
  }
}

const makeProgram = (source: string) =>
  new DebugPythonProgram(() => source, "example.py");

describe("fuzzer/analysis/python/PythonProgram:", () => {
  it("finds from-import identifiers", () => {
    const program = makeProgram(`from typing import List
`);

    expect(program.imports).toEqual({
      List: {
        local: "List",
        imported: "List",
        programPath: "typing",
        resolved: false,
        default: false,
      },
    });
  });

  it("finds nested list aliases as TypeRefs", () => {
    const program = makeProgram(`from typing import List

Scores = List[List[int]]
`);
    const scores = program.types["Scores"];

    expect(scores.type?.type).toBe(ArgTag.OBJECT);
    expect(scores.type?.dims).toBe(2);
    expect(scores.type?.children.length).toBe(1);
    expect(scores.type?.children[0].type?.type).toBe(ArgTag.OBJECT);
    expect(scores.type?.children[0].type?.dims).toBe(1);
    expect(scores.type?.children[0].type?.children[0].type?.type).toBe(
      ArgTag.NUMBER
    );
  });

  it("finds class definitions as object types", () => {
    const program = makeProgram(`class User:
    pass
`);
    const user = program.types["User"];

    expect(user.type?.type).toBe(ArgTag.OBJECT);
    expect(user.type?.dims).toBe(0);
    expect(user.type?.resolved).toBeTrue();
  });

  it("resolves function argument aliases through AbstractProgram construction", () => {
    const source = `from typing import List

Scores = List[List[int]]

def average(scores: Scores) -> float:
    return sum(scores[0]) / len(scores[0])
`;
    const program = makeProgram(source);
    const average = program.functions["average"];
    const arg = average.getRef().args?.[0];

    expect(arg?.typeRefName).toBe("Scores");
    expect(arg?.type?.type).toBe(ArgTag.OBJECT);
    expect(arg?.type?.dims).toBe(2);
    expect(arg?.type?.resolved).toBeTrue();
    expect(average.getReturnType()?.type?.type).toBe(ArgTag.NUMBER);
  });

  it("finds positional, vararg, keyword-only, and kwarg function args", () => {
    const program = makeProgram(`def combine(a: int, /, b: str, *values: float, flag: bool, **meta: str) -> bool:
    return flag
`);
    const combine = program.functions["combine"];
    const args = combine.getRef().args ?? [];

    expect(args.map((arg) => arg.name)).toEqual([
      "a",
      "b",
      "values",
      "flag",
      "meta",
    ]);
    expect(args.map((arg) => arg.type?.type)).toEqual([
      ArgTag.NUMBER,
      ArgTag.STRING,
      ArgTag.NUMBER,
      ArgTag.BOOLEAN,
      ArgTag.STRING,
    ]);
    expect(combine.getReturnType()?.type?.type).toBe(ArgTag.BOOLEAN);
  });

  it("marks functions with unsupported argument types as unsupported", () => {
    const program = makeProgram(`def unknown_type(value: MissingType) -> int:
    return 1

def missing_annotation(value) -> int:
    return 2
`);
    const found = program.findFunctionsForTest();

    const unknownType = found.unsupported["unknown_type"];
    const missingAnnotation = found.unsupported["missing_annotation"];

    expect(program.functions["unknown_type"]).toBeUndefined();
    expect(program.functions["missing_annotation"]).toBeUndefined();
    expect("argument" in unknownType && unknownType.argument).toBe("value");
    expect("argument" in missingAnnotation && missingAnnotation.argument).toBe(
      "value"
    );
  });

  it("uses character offsets for function source locations", () => {
    const source = `x = 1

def add(a: int, b: int) -> int:
    return a + b
`;
    const program = makeProgram(source);
    const add = program.functions["add"];

    expect(add.getStartOffset()).toBe(source.indexOf("def add"));
    expect(add.getSrc().slice(add.getStartOffset(), add.getEndOffset())).toBe(
      `def add(a: int, b: int) -> int:
    return a + b`
    );
  });

  it("adds Python function docstrings to FunctionRef comments", () => {
    const program = makeProgram(`def documented(value: int) -> int:
    """Return the same value."""
    return value
`);

    expect(program.functions["documented"].getRef().cmt).toBe(
      "Return the same value."
    );
  });

  it("marks underscore-prefixed functions as not exported", () => {
    const program = makeProgram(`def _helper(x: int) -> int:
    return x
`);

    expect(program.functions["_helper"].isExported()).toBeFalse();
    expect(program.functionsExported["_helper"]).toBeUndefined();
  });
});
