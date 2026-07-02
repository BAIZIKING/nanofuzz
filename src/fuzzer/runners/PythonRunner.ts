import { AbstractRunner } from "./AbstractRunner";
import { VmGlobals } from "../Types";

/**
 * Python runner
 */
export class PythonRunner extends AbstractRunner {
  protected _filename: string;
  protected _fn: string;

  /**
   * Create a new Python runner
   *
   * @param `filename` path and filename of Python program module
   * @param `fn` exported Python function within `module` to call
   */
  public constructor(filename: string, fn: string) {
    super(fn);
    throw new Error(`Not yet implemented`);
  } // fn: constructor

  /**
   * Run `fn` in `module` with `inputs`
   *
   * @param `inputs` inputs to function
   * @param `timeout` stop and fail after `timeout` ms
   * @returns [an unknown output type,environment]
   */
  public run(
    _inputs: unknown[],
    _timeout: number | undefined = 0
  ): [unknown, VmGlobals] {
    throw new Error("Not yet implemented");
  } // fn: run
} // class: PythonRunner
