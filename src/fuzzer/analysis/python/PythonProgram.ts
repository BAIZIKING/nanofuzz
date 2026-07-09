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
  args?: PythonFunctionArgNode[];
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
};

type PythonASTNode = PythonImportNode | PythonImportFromNode | PythonOtherNode;

type PythonModuleNode = {
  _type: "Module";
  body: PythonASTNode[];
  type_ignores: unknown[];
};

//mapping of types

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

function isImportFromNode(node: PythonASTNode): node is PythonImportFromNode {
  return node._type === "ImportFrom";
}

function isImportNode(node: PythonASTNode): node is PythonImportNode {
  return node._type === "Import";
}

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

function annotationArgs(
  annotation: PythonAnnotationNode | null | undefined
): PythonAnnotationNode[] {
  if (!annotation) {
    return [];
  }

  return annotation._type === "Tuple" ? (annotation.elts ?? []) : [annotation];
}

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

export class PythonProgram extends AbstractProgram {
  public readonly lang = "python";
  public readonly extensions = Object.freeze([".py"]);
  public ast_tree?: PythonModuleNode;

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

  protected _findTypes(): Record<IdentifierName, TypeRef> {
    if (!this.ast_tree) {
      return {};
    }

    const types: Record<string, TypeRef> = {};

    //traverse throughout the ast tree nodes
    for (const node of this.ast_tree.body) {
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

  //note that this output should be processed using _resolveTypeRef
  protected _findFunctions(): typeof this._functions {
    /**Function finds the all functions the AST tree parses and displays relevant information */

    const output: typeof this._functions = { supported: {}, unsupported: {} };

    if (!this.ast_tree) {
      return output;
    }

    //traverse the ast tree
    for (const node of this.ast_tree.body) {
      if (node._type !== "FunctionDef" || !node.name) {
        continue;
      }

      const args: TypeRef[] = [];

      for (const param of node.args?.args ?? []) {
        args.push(this._annotationToTypeRef(param.annotation, param.arg));
      }

      const returnType = node.returns
        ? this._annotationToTypeRef(node.returns, "return")
        : undefined;

      output.supported[node.name] = {
        module: this.filename,
        name: node.name,
        src: this._getSource(),
        startOffset: node.lineno ?? 0,
        endOffset: node.end_lineno ?? 0,
        isExported: !node.name.startsWith("_"),
        isVoid: !node.returns,
        args,
        returnType,
      };
    }

    return output;
  }

  protected _findDefaultTypeExport(): TypeRef | undefined {
    return undefined;
  }

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

    const resolvedType = structuredClone(resolved.type);
    for (const child of resolvedType.children) {
      this._resolveTypeRef(child);
    }

    return {
      module: t.module,
      name: t.name,
      optional: t.optional,
      dims: t.dims,
      isExported: t.isExported,
      type: {
        ...resolvedType,
        resolved: true,
      },
    };
  }
}
