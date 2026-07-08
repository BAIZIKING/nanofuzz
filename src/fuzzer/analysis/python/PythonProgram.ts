import { spawnSync } from "child_process";
import { AbstractProgram } from "../AbstractProgram";
import {
  ProgramImports,
  IdentifierName,
  TypeRef,
  ArgOptions,
  ArgTag,
} from "../Types";
//import { string } from "zod";

type PythonAst = Record<string, unknown>;
const pythonAsts = new WeakMap<PythonProgram, PythonAst>();

//PYTHON_TYPE_MAP will map python classes into ArgTag types
const PYTHON_TYPE_MAP: Map<string, ArgTag> = new Map([
  // Numeric
  ["int", ArgTag.NUMBER],
  ["float", ArgTag.NUMBER],
  ["complex", ArgTag.NUMBER],

  // String-like
  ["str", ArgTag.STRING],
  ["bytes", ArgTag.STRING],
  ["bytearray", ArgTag.STRING],
  ["memoryview", ArgTag.STRING],

  // Boolean
  ["bool", ArgTag.BOOLEAN],

  // Containers
  ["list", ArgTag.OBJECT],
  ["List", ArgTag.OBJECT],
  ["dict", ArgTag.OBJECT],
  ["Dict", ArgTag.OBJECT],
  ["set", ArgTag.OBJECT],
  ["Set", ArgTag.OBJECT],
  ["frozenset", ArgTag.OBJECT],
  ["tuple", ArgTag.TUPLE],
  ["Tuple", ArgTag.TUPLE],

  // Typing module
  ["Sequence", ArgTag.OBJECT],
  ["MutableSequence", ArgTag.OBJECT],
  ["Iterable", ArgTag.OBJECT],
  ["Iterator", ArgTag.OBJECT],
  ["Collection", ArgTag.OBJECT],
  ["Mapping", ArgTag.OBJECT],
  ["MutableMapping", ArgTag.OBJECT],
  ["MappingView", ArgTag.OBJECT],
  ["KeysView", ArgTag.OBJECT],
  ["ValuesView", ArgTag.OBJECT],
  ["ItemsView", ArgTag.OBJECT],

  // Unions
  ["Union", ArgTag.UNION],
  ["Optional", ArgTag.UNION],

  // Literals
  ["Literal", ArgTag.LITERAL],

  // Generic object types
  ["object", ArgTag.OBJECT],
  ["Any", ArgTag.OBJECT],
  ["Callable", ArgTag.OBJECT],
  ["Type", ArgTag.OBJECT],
  ["Generic", ArgTag.OBJECT],
  ["Protocol", ArgTag.OBJECT],

  // Enums
  ["Enum", ArgTag.OBJECT],
  ["IntEnum", ArgTag.OBJECT],

  // Special
  ["None", ArgTag.LITERAL],
  ["NoneType", ArgTag.LITERAL],
]);

export class PythonProgram extends AbstractProgram {
  public readonly lang = "python";
  public readonly extensions = Object.freeze([".py"]);

  constructor(
    getSource: () => string,
    filename: string,
    options?: ArgOptions,
    parent?: AbstractProgram
  ) {
    super(getSource, filename, options, parent);
    if (parent && this.lang !== parent.lang) {
      throw new Error(
        `A "${this.lang}" program cannot be a child of a "${parent.lang}" program.`
      );
    }
  }

  public get ast(): PythonAst | undefined {
    const ast = pythonAsts.get(this);
    return ast === undefined ? undefined : structuredClone(ast);
  }

  public _parse(_src: string): void {
    /* Function parses the provided source code into valid AST by
    running Python's AST module as a subprocess */
    const pythonScript = [
      "import ast",
      "import json",
      "import sys",
      "",
      "def ast_to_dict(node):",
      "    if isinstance(node, ast.AST):",
      "        result = {",
      '            "_type": type(node).__name__',
      "        }",
      "",
      "        for field, value in ast.iter_fields(node):",
      "            result[field] = ast_to_dict(value)",
      "",
      "        return result",
      "",
      "    elif isinstance(node, list):",
      "        return [ast_to_dict(item) for item in node]",
      "",
      "    else:",
      "        return node",
      "",
      "src = sys.stdin.read()",
      "tree = ast.parse(src)",
      "",
      "print(json.dumps(ast_to_dict(tree)))",
    ].join("\n");

    const result = spawnSync("python3", ["-c", pythonScript], {
      input: _src,
      encoding: "utf-8",
    });

    if (result.status !== 0) {
      throw new Error(result.stderr);
    }
    // Python parsed AST in JSON
    pythonAsts.set(this, JSON.parse(result.stdout));
  }

  //briefly changed to public for testing purposes
  public _findImports(): ProgramImports {
    /**Function takes in a python parsed AST gets the necessary imports and modules that the program used */
    const imports: ProgramImports = {
      programs: {},
      identifiers: {},
    };

    //Return empty if no imports or no ast
    if (!this.ast || !Array.isArray(this.ast.body)) {
      return imports;
    }

    //traverse through the ast
    for (const node of this.ast.body) {
      // normal python imports
      if (node._type === "Import") {
        for (const alias of node.names ?? []) {
          const moduleName = alias.name;
          const localName = alias.asname ?? alias.name;
          //Populate the actual files into the object
          imports.programs[moduleName] = moduleName;

          //populated based on if the import is short handed numpy -> np
          imports.identifiers[localName] = {
            local: localName,
            imported: moduleName,
            programPath: moduleName,
            resolved: false,
            default: false,
          };
        }
      }

      //import is being written in short hand
      if (node._type === "ImportFrom") {
        const moduleName = node.module;

        if (!moduleName) {
          continue;
        }
        //Populate the actual files into the object
        imports.programs[moduleName] = moduleName;

        //populated based on if the import is short handed numpy -> np.
        // Iterate through each potential names from the import
        for (const alias of node.names ?? []) {
          const importedName = alias.name;
          const localName = alias.asname ?? importedName;
          imports.identifiers[localName] = {
            local: localName,
            imported: importedName,
            programPath: moduleName,
            resolved: false,
            default: false,
          };
        }
      }
    }

    return imports;
  }

  //Temporary change to public
  public _findTypes(): Record<IdentifierName, TypeRef> {
    const types: Record<string, TypeRef> = {};

    // Check if the AST is valid
    if (!this.ast || !Array.isArray(this.ast.body)) {
      return types;
    }

    // User-defined classes and aliases
    for (const node of this.ast.body) {
      if (node._type === "ClassDef") {
        const className = node.name;

        types[className] = {
          module: this.filename,
          name: className,
          optional: false,
          dims: 0,
          isExported: true,
          type: {
            type: ArgTag.OBJECT,
            dims: 0,
            children: [],
            resolved: true,
          },
        };
      }
      //AST has an assign map w/ targets: ..., value:.... for a type alias in the format of
      // Name = type

      if (node._type === "Assign") {
        const targets = node.targets;
        const value = node.value;

        //Check if valid format
        if (
          Array.isArray(targets) &&
          targets.length === 1 &&
          targets[0]._type === "Name" &&
          value?._type === "Name"
        ) {
          const aliasName = targets[0].id;
          const originalTypeName = value.id;

          const tag = PYTHON_TYPE_MAP.get(originalTypeName);

          if (tag) {
            types[aliasName] = {
              module: this.filename,
              name: aliasName,
              optional: false,
              dims: 0,
              isExported: true,
              type: {
                type: tag,
                dims: 0,
                children: [],
                resolved: true,
              },
            };
          }
        }
      }
    }

    return types;
  }

  private _typeRefFromAnnotation(
    annotation: any,
    name: string,
    isExported = false
  ): TypeRef {
    // No annotation means Python did not give us a type. Return an unresolved
    // TypeRef so the normal resolver path can mark the function unsupported.
    if (!annotation) {
      return {
        module: this.filename,
        name,
        optional: false,
        dims: 0,
        isExported,
      };
    }

    // Simple annotations like "int", "str", and "User" show up as Name nodes.
    // Built-ins become concrete ArgTags; custom names stay as typeRefName.
    if (annotation._type === "Name") {
      const tag = PYTHON_TYPE_MAP.get(annotation.id);

      if (tag) {
        return {
          module: this.filename,
          name,
          optional: false,
          dims: 0,
          isExported,
          type: {
            type: tag,
            dims: 0,
            children: [],
            resolved: true,
          },
        };
      }

      return {
        module: this.filename,
        name,
        typeRefName: annotation.id,
        optional: false,
        dims: 0,
        isExported,
      };
    }

    // More complex annotations, like list[int], can be added here later.
    // For now, leave them unresolved instead of guessing incorrectly.
    return {
      module: this.filename,
      name,
      optional: false,
      dims: 0,
      isExported,
    };
  }

  public _findFunctions(): typeof this._functions {
    /**Function returns all functions in a file and detailed information in the FunctionDef format */
    const source = this._getSource();
    const function_ref: typeof this._functions = {
      supported: {},
      unsupported: {},
    };

    const ast = this.ast;

    if (!ast || !Array.isArray(ast.body)) {
      return function_ref;
    }

    for (const node of ast.body) {
      if (node._type === "FunctionDef") {
        const funcName = node.name;
        const args: TypeRef[] = [];

        for (const arg of node.args?.args ?? []) {
          if (arg.arg === "self") {
            continue;
          }

          args.push(this._typeRefFromAnnotation(arg.annotation, arg.arg));
        }

        const returnType = node.returns
          ? this._typeRefFromAnnotation(node.returns, "return")
          : undefined;

        function_ref.supported[funcName] = {
          module: this.filename,
          name: funcName,
          src: source,
          startOffset: node.lineno ?? 0,
          endOffset: node.end_lineno ?? 0,
          isExported: !funcName.startsWith("_"),
          isVoid: node.returns === null,
          args,
          returnType,
        };
      }
    }

    return function_ref;
  }

  protected _findDefaultTypeExport(): TypeRef | undefined {
    /**Returns undefined due to python not having export */
    return undefined;
  }

  public _resolveTypeRef(t: TypeRef): TypeRef {
    /**Converts a named reference into a concrete fuzzable type from the TypeRef objects created earlier */

    // Case 1: t already has a t.type -> check on its children
    if (t.type) {
      for (const child of t.type.children) {
        this._resolveTypeRef(child);
      }
      t.type.resolved = true;
      return t;
    }

    if (!t.typeRefName) {
      throw new Error(`Unable to resolve TypeRef without typeRefName`);
    }
    // Actual TypeRef Format lookup
    const resolved = this._types[t.typeRefName];
    //Make sure resolved exist
    if (!resolved || !resolved.type) {
      throw new Error(`Unable to resolve type ${t.typeRefName}`);
    }

    t.type = structuredClone(resolved.type);
    // Recurse on children
    for (const children of t.type.children) {
      this._resolveTypeRef(children);
    }
    t.type.resolved = true;
    return t;
  }
}

if (require.main === module) {
  const source = `
import math
import numpy as np
from typing import Optional, List
from collections import defaultdict as dd

CONSTANT = 10


def add(a: int, b: float) -> float:
    return a + b


def _private_helper(name: str) -> str:
    return name.strip().lower()


def no_return(x: int):
    print(x)


class User:
    def __init__(self, name: str, age: int):
        self.name = name
        self.age = age

    def greet(self) -> str:
        return f"Hello, {self.name}"


class Admin(User):
    def ban_user(self, user: User) -> bool:
        return True


def make_user(name: str, age: int) -> User:
    return User(name, age)


def process_scores(scores: list[int]) -> float:
    return sum(scores) / len(scores)


def maybe_get_user(flag: bool) -> Optional[User]:
    if flag:
        return User("Michael", 19)
    return None

`;

  const program = new PythonProgram(() => source, "example.py");
  console.log(JSON.stringify(program.ast, null, 2));
  console.log("####\n\n");
  //console.log(program._findImports());
  // console.log(program._findTypes());
  console.log("$$$$\n");
  // console.log(program._findFunctions());
  console.log(JSON.stringify(program._findFunctions(), null, 2));
}
