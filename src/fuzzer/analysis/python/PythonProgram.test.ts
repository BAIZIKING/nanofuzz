import * as ProgramFactory from "../ProgramFactory";
import { ArgTag } from "../Types";

describe("fuzzer/analysis/python/PythonProgram:", () => {
  it("Local type alias", () => {
    expect(
      ProgramFactory.fromSource(
        () => `type a = str
def greeting(name: a) -> a:
  return 'Hello ' + name`,
        "python"
      ).types
    ).toEqual({
      a: {
        isExported: true,
        optional: false,
        dims: 0,
        module: "",
        type: {
          dims: 0,
          type: ArgTag.STRING,
          children: [],
          resolved: true,
        },
      },
    });
  });

  it("Local type alias in function", () => {
    const fns = ProgramFactory.fromSource(
      () => `type a = str
def greeting(name: a) -> a:
  return 'Hello ' + name`,
      "python"
    ).functionsExported;
    expect(Object.keys(fns).length).toEqual(1);
    expect(fns["greeting"]).toBeDefined();
    expect(fns["greeting"].getName()).toEqual("greeting");
    expect(fns["greeting"].getCmt()).not.toBeDefined();
    expect(fns["greeting"].getSrc()).toEqual(`def greeting(name: a) -> a:
  return 'Hello ' + name`);

    const args = fns["greeting"].getArgDefs();
    expect(args.length).toEqual(1);
    expect(args[0].getName()).toEqual("name");
    expect(args[0].getDim()).toEqual(0);
    expect(args[0].getChildren().length).toEqual(0);
    expect(args[0].getType()).toEqual(ArgTag.STRING);
    expect(args[0].isConstant()).toBeFalse();
    expect(args[0].getTypeRef()).toEqual("a");
    expect(args[0].getTypeAnnotation()).toEqual("a");
  });
});
