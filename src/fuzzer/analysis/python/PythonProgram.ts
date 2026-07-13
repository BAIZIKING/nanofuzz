import { spawnSync } from "child_process";
import { AbstractProgram } from "../AbstractProgram";
import {
  ProgramImports,
  IdentifierName,
  TypeRef,
  ArgOptions,
  ArgTag,
} from "../Types";

//Type ALIAS
// These types model the JSON dictionary produced by Python's ast module.

type PythonSourcePosition = {
  lineno?: number;
  col_offset?: number;
  end_lineno?: number;
  end_col_offset?: number;
};

type PythonAliasNode = PythonSourcePosition & {
  _type: "alias";
  name: string;
  asname: string | null;
};

type PythonImportNode = PythonSourcePosition & {
  _type: "Import";
  names: PythonAliasNode[];
};

type PythonImportFromNode = PythonSourcePosition & {
  _type: "ImportFrom";
  module: string | null;
  names: PythonAliasNode[];
  level: number;
};

type PythonAnnotationNode = PythonSourcePosition & {
  _type: string;
  attr?: string;
  elts?: PythonAnnotationNode[];
  id?: string;
  slice?: PythonAnnotationNode | null;
  value?: PythonAnnotationNode | null;
};

type PythonFunctionArgsNode = {
  //support multiple types/styles of python args such as *args or **kwargs
  posonlyargs?: PythonFunctionArgNode[];
  args?: PythonFunctionArgNode[];
  vararg?: PythonFunctionArgNode | null;
  kwonlyargs?: PythonFunctionArgNode[];
  kwarg?: PythonFunctionArgNode | null;
};

type PythonFunctionArgNode = {
  arg: string;
  annotation?: PythonAnnotationNode | null;
};

type PythonOtherNode = PythonSourcePosition & {
  _type: Exclude<string, "Import" | "ImportFrom">;
  annotation?: PythonAnnotationNode | null;
  args?: PythonFunctionArgsNode;
  body?: PythonASTNode[];
  name?: string;
  returns?: PythonAnnotationNode | null;
  target?: PythonAnnotationNode | null;
  targets?: PythonAnnotationNode[];
  value?: PythonAnnotationNode | null;
  docstring?: string | null;
};

type PythonASTNode = PythonImportNode | PythonImportFromNode | PythonOtherNode;

type PythonModuleNode = {
  _type: "Module";
  body: PythonASTNode[];
  type_ignores: unknown[];
};

//mapping of types
// Maps Python/typing annotation names to the shared NaNofuzz ArgTag values.

const PYTHON_TYPE_MAP = new Map<string, ArgTag>([
  // Primitive types
  ["int", ArgTag.NUMBER],
  ["float", ArgTag.NUMBER],
  ["complex", ArgTag.NUMBER],

  ["str", ArgTag.STRING],

  ["bool", ArgTag.BOOLEAN],

  // Container types
  ["list", ArgTag.OBJECT],
  ["List", ArgTag.OBJECT],

  ["dict", ArgTag.OBJECT],
  ["Dict", ArgTag.OBJECT],

  ["set", ArgTag.OBJECT],
  ["Set", ArgTag.OBJECT],

  // Structured types
  ["tuple", ArgTag.TUPLE],
  ["Tuple", ArgTag.TUPLE],

  // Special typing constructs
  ["Literal", ArgTag.LITERAL],
  ["Union", ArgTag.UNION],
  ["Optional", ArgTag.UNION],

  // Fallback-ish builtins
  ["object", ArgTag.OBJECT],
  ["Any", ArgTag.UNRESOLVED],
  ["None", ArgTag.UNRESOLVED],
]);

//Checks whether a Python AST node is a `from x import y` node.
function isImportFromNode(node: PythonASTNode): node is PythonImportFromNode {
  return node._type === "ImportFrom";
}

//Checks whether a Python AST node is a plain `import x` node.
function isImportNode(node: PythonASTNode): node is PythonImportNode {
  return node._type === "Import";
}

//Finds the base annotation name from Python AST annotation nodes.
// Examples: `int` -> int, `typing.List[int]` -> typing.List.
function findChildrenAnnotation(
  annotation: PythonAnnotationNode | null | undefined
): string | undefined {
  if (!annotation) {
    return undefined;
  }

  // Single identifiers: int, float, User, Scores, etc.
  if (annotation._type === "Name") {
    return annotation.id;
  }

  // Qualified names: typing.List, module.CustomType, etc.
  if (annotation._type === "Attribute") {
    const parent = findChildrenAnnotation(annotation.value);
    return parent ? `${parent}.${annotation.attr}` : annotation.attr;
  }

  // Generic types: List[int], dict[str, int], Optional[User], etc.
  if (annotation._type === "Subscript") {
    return findChildrenAnnotation(annotation.value);
  }

  return undefined;
}

//Returns the inner annotation arguments for generics.
// Example: Union[int, str] becomes [int, str].
function annotationArgs(
  annotation: PythonAnnotationNode | null | undefined
): PythonAnnotationNode[] {
  if (!annotation) {
    return [];
  }

  return annotation._type === "Tuple" ? (annotation.elts ?? []) : [annotation];
}

//Counts nested Subscript annotations as dimensions.
// Example: List[List[int]] has dims 2.
function annotationDims(
  annotation: PythonAnnotationNode | null | undefined
): number {
  if (!annotation) {
    return 0;
  }

  if (annotation._type === "Subscript") {
    return 1 + annotationDims(annotation.slice);
  }

  if (annotation._type === "Tuple") {
    return Math.max(0, ...(annotation.elts ?? []).map(annotationDims));
  }

  return 0;
}

//Converts the child annotations inside a generic into TypeRef children.
// Example: List[int] creates one number child TypeRef.
function annotationChildren(
  annotation: PythonAnnotationNode,
  filename: string,
  parentName: string
): TypeRef[] {
  if (annotation._type !== "Subscript") {
    return [];
  }

  return annotationArgs(annotation.slice).map((child, index) => {
    const name = `${parentName}_${index}`;
    const typeName = findChildrenAnnotation(child);
    const shortTypeName = typeName?.split(".").at(-1);
    const argTag = shortTypeName
      ? PYTHON_TYPE_MAP.get(shortTypeName)
      : undefined;

    return {
      module: filename,
      name,
      optional: false,
      dims: 0,
      isExported: true,
      ...(argTag && argTag !== ArgTag.UNRESOLVED
        ? {
            type: {
              type: argTag,
              dims: annotationDims(child),
              children: annotationChildren(child, filename, name),
              resolved: false,
            },
          }
        : { typeRefName: typeName }),
    };
  });
}

const PYTHON_AST_TREE = new WeakMap<object, PythonModuleNode>();

//PythonProgram parses Python source and converts it into NaNofuzz's shared Program/Type/Function shapes.
export class PythonProgram extends AbstractProgram {
  public readonly lang = "python";
  public readonly extensions = Object.freeze([".py"]);

  public get ast_tree(): PythonModuleNode | undefined {
    return PYTHON_AST_TREE.get(this);
  }

  public set ast_tree(astTree: PythonModuleNode | undefined) {
    if (astTree) {
      PYTHON_AST_TREE.set(this, astTree);
    } else {
      PYTHON_AST_TREE.delete(this);
    }
  }

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

  //Converts one Python annotation node into the shared TypeRef format.
  protected _annotationToTypeRef(
    annotation: PythonAnnotationNode | null | undefined,
    name: string
  ): TypeRef {
    /**Function takes in a python type annotation in AST format and converts into TypeRef Format */
    const annotationName = findChildrenAnnotation(annotation);
    const shortAnnotationName = annotationName?.split(".").at(-1);
    const tag = shortAnnotationName
      ? PYTHON_TYPE_MAP.get(shortAnnotationName)
      : undefined;

    if (annotation && tag && tag !== ArgTag.UNRESOLVED) {
      return {
        module: this.filename,
        name,
        optional: false,
        dims: 0,
        isExported: false,
        type: {
          type: tag,
          dims: annotationDims(annotation),
          children: annotationChildren(annotation, this.filename, name),
          resolved: false,
        },
      };
    }

    return {
      module: this.filename,
      name,
      typeRefName: annotationName,
      optional: false,
      dims: 0,
      isExported: false,
    };
  }

  //Parses Python source by asking Python's ast module for a JSON-shaped AST.
  protected _parse(_src: string): void {
    /**This function parses the python source code and returns the AST tree
     * Source code is first parsed, then fed into the pythonScript, which is then ran into terminal via
     * TS's spawnSync and the output python AST is rendered in dictionary format and saved to
     * object variable: `tree_ast`
     */
    const pythonScript = `
import ast, sys, json

def ast_to_dict(node):
    if isinstance(node, ast.AST):
        result = {
            "_type": type(node).__name__,
            **{
                field: ast_to_dict(getattr(node, field))
                for field in node._fields
            }
        }

        # Include source position information if present
        for attr in ("lineno", "col_offset", "end_lineno", "end_col_offset"):
            if hasattr(node, attr):
                result[attr] = getattr(node, attr)
        if isinstance(
          node,
          (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)
      ):
          result["docstring"] = ast.get_docstring(node, clean=False)

        return result

    elif isinstance(node, list):
        return [ast_to_dict(x) for x in node]

    return node

src = sys.stdin.read()

if not src:
    raise ValueError("Source not provided")

tree = ast.parse(src)
print(json.dumps(ast_to_dict(tree)))
`;

    //Run this script in terminal
    const result = spawnSync("python3", ["-c", pythonScript], {
      input: _src,
      encoding: "utf-8",
    });

    if (result.error) {
      throw result.error;
    }

    if (result.status !== 0) {
      throw new Error(result.stderr);
    }
    //store the parsed ast (dict) format into the tree_ast variable
    this.ast_tree = JSON.parse(result.stdout);
  }

  //Finds top-level Python imports and converts them into ProgramImports.
  protected _findImports(): ProgramImports {
    //**This function finds all imports and extracts them from the python ast tree into the desired
    // ProgramImports type alias format */

    // if no ast_tree
    if (!this.ast_tree) {
      return { programs: {}, identifiers: {} };
    }

    const imports: ProgramImports = {
      programs: {},
      identifiers: {},
    };

    //traverse through the dictionary and grab Import, ImportFrom, name used in file,
    //original name by module, what module it came from, resolved=faksem default=false
    for (const node of this.ast_tree?.body ?? []) {
      //Handles the programs section of the mapping
      if (isImportNode(node)) {
        for (const alias of node.names) {
          const imported = alias.name;
          const local = alias.asname ?? imported;

          imports.programs[local] = imported;
        }
      }

      //The type is directly an import and should be filled inside programs
      if (isImportFromNode(node)) {
        const programPath = node.module ?? "";

        //Handles the identifiers section of the mapping
        for (const alias of node.names) {
          // imported is what is being actually imported from module
          const imported = alias.name;
          //local is what the user is calling it as
          const local = alias.asname ?? imported;

          imports.identifiers[local] = {
            local,
            imported,
            programPath,
            resolved: false,
            default: false,
          };
        }
      }
    }
    return imports;
  }

  //Finds top-level annotated variables and aliases and converts them into TypeRefs.
  protected _findTypes(): Record<IdentifierName, TypeRef> {
    if (!this.ast_tree) {
      return {};
    }

    const types: Record<string, TypeRef> = {};

    //traverse throughout the ast tree nodes
    for (const node of this.ast_tree.body) {
      //Class definitions are treated as object types, e.g. class User: pass
      if (node._type === "ClassDef" && node.name) {
        types[node.name] = {
          module: this.filename,
          name: node.name,
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

      //Assigned types, e.g. x: int = 5
      if (
        node._type === "AnnAssign" &&
        node.target?._type === "Name" &&
        node.target.id &&
        node.annotation
      ) {
        const name = node.target.id;
        const typeName = findChildrenAnnotation(node.annotation);
        const shortTypeName = typeName?.split(".").at(-1);
        const argTag = shortTypeName
          ? PYTHON_TYPE_MAP.get(shortTypeName)
          : undefined;

        types[name] = {
          module: this.filename,
          name,
          optional: false,
          dims: 0,
          isExported: true,
          ...(argTag && argTag !== ArgTag.UNRESOLVED
            ? {
                type: {
                  type: argTag,
                  dims: annotationDims(node.annotation),
                  children: annotationChildren(
                    node.annotation,
                    this.filename,
                    name
                  ),
                  resolved: false,
                },
              }
            : { typeRefName: typeName }),
        };
      }

      //Type aliases, e.g. Scores = List[List[int]]
      if (
        node._type === "Assign" &&
        node.targets?.length === 1 &&
        node.targets[0]._type === "Name" &&
        node.targets[0].id &&
        node.value
      ) {
        const name = node.targets[0].id;
        const typeName = findChildrenAnnotation(node.value);
        const shortTypeName = typeName?.split(".").at(-1);
        const argTag = shortTypeName
          ? PYTHON_TYPE_MAP.get(shortTypeName)
          : undefined;

        types[name] = {
          module: this.filename,
          name,
          optional: false,
          dims: 0,
          isExported: true,
          ...(argTag && argTag !== ArgTag.UNRESOLVED
            ? {
                type: {
                  type: argTag,
                  dims: annotationDims(node.value),
                  children: annotationChildren(node.value, this.filename, name),
                  resolved: false,
                },
              }
            : { typeRefName: typeName }),
        };
      }
    }
    return types;
  }

  private _isSupportedTypeRef(typeRef: TypeRef): boolean {
    //**Function is helper function to be used in the _findFunctions method that determines if a function
    // is unsupported or not */

    try {
      //Copy type ref (deep) and input into resolveTypeRef
      const resolved = this._resolveTypeRef(structuredClone(typeRef));

      if (!resolved.type) {
        return false;
      }

      if (resolved.type.type === ArgTag.UNRESOLVED) {
        return false;
      }

      //recurse on the children
      return resolved.type.children.every((child) =>
        this._isSupportedTypeRef(child)
      );
    } catch {
      return false;
    }
  }

  //note that this output should be processed using _resolveTypeRef
  //Finds top-level Python functions and converts their args/returns into FunctionRef records.
  protected _findFunctions(): typeof this._functions {
    /**Function finds the all functions the AST tree parses and displays relevant information */

    const output: typeof this._functions = { supported: {}, unsupported: {} };

    if (!this.ast_tree) {
      return output;
    }

    const source = this._getSource();
    const lineStarts = [0];
    let offset = 0;

    //splite the source code into individual segments in the array
    for (const line of source.split(/\r?\n/)) {
      offset += line.length + 1;
      lineStarts.push(offset);
    }

    //traverse the ast tree
    for (const node of this.ast_tree.body) {
      if (node._type !== "FunctionDef" || !node.name) {
        continue;
      }

      const args: TypeRef[] = [];

      for (const param of node.args?.posonlyargs ?? []) {
        args.push(this._annotationToTypeRef(param.annotation, param.arg));
      }

      for (const param of node.args?.args ?? []) {
        args.push(this._annotationToTypeRef(param.annotation, param.arg));
      }

      if (node.args?.vararg) {
        args.push(
          this._annotationToTypeRef(
            node.args.vararg.annotation,
            node.args.vararg.arg
          )
        );
      }

      for (const param of node.args?.kwonlyargs ?? []) {
        args.push(this._annotationToTypeRef(param.annotation, param.arg));
      }

      if (node.args?.kwarg) {
        args.push(
          this._annotationToTypeRef(
            node.args.kwarg.annotation,
            node.args.kwarg.arg
          )
        );
      }

      const returnType = node.returns
        ? this._annotationToTypeRef(node.returns, "return")
        : undefined;

      const startOffset =
        node.lineno && node.col_offset !== undefined
          ? lineStarts[node.lineno - 1] + node.col_offset
          : source.length;

      const endOffset =
        node.end_lineno && node.end_col_offset !== undefined
          ? lineStarts[node.end_lineno - 1] + node.end_col_offset
          : source.length;

      const functionRef = {
        module: this.filename,
        name: node.name,
        src: this._getSource(),
        startOffset: startOffset ?? 0,
        endOffset: endOffset ?? 0,
        isExported: !node.name.startsWith("_"),
        isVoid: !node.returns,
        args,
        returnType,
        cmt: node.docstring ?? undefined,
      };

      const unsupportedArg = args.find((arg) => !this._isSupportedTypeRef(arg));

      //Based on helper function if unsupported put in unsupported mapping
      if (unsupportedArg) {
        output.unsupported[node.name] = {
          reason: `Unsupported argument type for '${unsupportedArg.name ?? "(unknown)"}'`,
          argument: unsupportedArg.name,
          function: functionRef,
        };
        continue;
      }
      //if supported
      output.supported[node.name] = functionRef;
    }

    return output;
  }

  //Python does not have TypeScript-style default type exports.
  protected _findDefaultTypeExport(): TypeRef | undefined {
    return undefined;
  }

  //Resolves TypeRefs that point at aliases found by _findTypes().
  public _resolveTypeRef(t: TypeRef): TypeRef {
    /**This function takes in the result from _findFunctions and scans the "typeRefName" key to see if it is expanded or not.
     * if not , it searchs in _findTypes and attaches that/replaces the non expanded type
     */

    if (t.type) {
      for (const child of t.type.children) {
        this._resolveTypeRef(child);
      }
      t.type.resolved = true;
      return t;
    }

    if (!t.typeRefName) {
      return t;
    }

    const types = this._findTypes();
    //the actual expanded type values
    const resolved = types[t.typeRefName];

    if (!resolved?.type) {
      return t;
    }

    t.type = structuredClone(resolved.type);
    for (const child of t.type.children) {
      this._resolveTypeRef(child);
    }
    t.type.resolved = true;
    return t;
  }
}
