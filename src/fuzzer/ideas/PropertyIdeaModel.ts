import JSON5 from "json5";
import * as vscode from "vscode";
import * as zod from "zod";
import { LlmAdapter } from "../adapters/LlmAdapter";
import { FuzzIoElement, ResultWrapped, unwrapResult } from "../Fuzzer";
import {
  CompositeJudgmentDiff,
  JudgedExample,
  JudgmentDiff,
} from "../oracles/JudgmentDiff";
import { RunnerFactory } from "../runners/RunnerFactory";
import path from "node:path";
import { CompositeOracle } from "../oracles/CompositeOracle";
import { NamedJudgment } from "../oracles/Types";
import { ImplicitOracle } from "../oracles/ImplicitOracle";
import { ExampleOracle } from "../oracles/ExampleOracle";
import { PropertyOracle } from "../oracles/PropertyOracle";
import { propertyOracleFromNodeModule } from "../oracles/Util";
import { ArgDefGenerator } from "../analysis/typescript/ArgDefGenerator";
import { ArgDefMutator } from "../analysis/typescript/ArgDefMutator";
import {
  AbstractIdeaData,
  AbstractIdeaModel,
  IdeaBasis,
} from "./AbstractIdeaModel";
import { isError } from "../../Util";
import { PropertyIdeaView } from "./PropertyIdeaView";

export class PropertyIdeaModel extends AbstractIdeaModel {
  protected static _model: LlmAdapter = new LlmAdapter();
  protected _diff: JudgmentDiff;
  protected _view: PropertyIdeaView | undefined;
  protected _src: string[];

  protected constructor(idea: PropertyIdeaData, basis: IdeaBasis) {
    super(idea, basis);
    this._priority = idea.priority;
    this._src = idea.src;
    this._diff = idea.diff;
  }

  public get diff(): JudgmentDiff {
    return this._diff;
  }

  public get type(): "idea.property" {
    return "idea.property";
  }

  public get src(): string[] {
    return [...this._src];
  }

  public refresh(): boolean {
    // !!!!!!!!!! implement
    return false;
  }

  public accept(): void {
    super.accept();
    this._basis.panel._doAddValidatorCmd({
      src: this._src.join("\n"),
      name: this._name,
    });
    this._basis.panel._doGetValidators();
  }

  public reject(): void {
    super.reject();
  }

  public get data(): PropertyIdeaData {
    return {
      ...super.baseData,
      type: "idea.property",
      src: this._src,
      diff: this._diff,
    };
  }
  // !!!!!!
  // !!!!!!!!!! move all the scoring into the object so we can re-run it
  public static propose(
    basis: IdeaBasis,
    callbackFn: (i: AbstractIdeaModel) => void
  ): void {
    if (
      !LlmAdapter.isConfigured() ||
      !vscode.workspace
        .getConfiguration("nanofuzz.ai.properties")
        .get<boolean>("generate", false) ||
      !basis.results.env.options.useProperty
    ) {
      return;
    }

    const outputSpec = basis.fn.getReturnArg();
    const outputGenerator = outputSpec
      ? new ArgDefGenerator([outputSpec], basis.prng)
      : undefined;
    const propertyOracle: PropertyOracle = propertyOracleFromNodeModule(
      module,
      basis.results.env.validators.map((f) => f.name)
    );

    // Concrete examples actually tested
    const concreteExamples: JudgedExample[] = basis.results.results.map((r) => {
      return {
        example: {
          exception: r.exception,
          timeout: r.timeout,
          outWrapped: { tag: "ArgValueTypeWrapped", value: r.output[0].value },
          inWrapped: r.input.map((i) => ({
            tag: "ArgValueTypeWrapped",
            value: i.value,
          })),
        },
        source: {
          type: "test",
          runId: basis.results.runId,
          testId: r.testId,
        },
        judgments: {
          implicit: r.oracles.implicit,
          example: r.oracles.example,
          composite: CompositeOracle.judge([
            [r.oracles.example, r.oracles.property],
            [r.oracles.implicit],
          ]),
          property: r.oracles.property,
          propertyDetail: r.oracles.propertyDetail,
        },
        addlJudgments: {},
      };
    });

    // Mutate outputs of examples with a ground truth example assertion
    const mutatedExamples: JudgedExample[] = outputSpec
      ? basis.results.results
          .filter(
            (r) => r.expectedOutput && r.oracles.example.judgment !== "unknown"
          )
          .map((r) => {
            const mutants: ResultWrapped[] = [];

            // Synthesize an exception example
            if (!r.exception) {
              mutants.push({
                exception: true,
                timeout: false,
                inWrapped: r.input.map((i) => ({
                  tag: "ArgValueTypeWrapped",
                  value: i.value,
                })),
                outWrapped: {
                  tag: "ArgValueTypeWrapped",
                  value: undefined,
                },
              });
            }

            // Synthesize a timeout example
            if (!r.timeout) {
              mutants.push({
                exception: false,
                timeout: true,
                inWrapped: r.input.map((i) => ({
                  tag: "ArgValueTypeWrapped",
                  value: i.value,
                })),
                outWrapped: {
                  tag: "ArgValueTypeWrapped",
                  value: undefined,
                },
              });
            }

            // Synthesize a mutant example if we have an output spec
            if (outputGenerator) {
              try {
                mutants.push({
                  exception: false,
                  timeout: false,
                  inWrapped: r.input.map((i) => ({
                    tag: "ArgValueTypeWrapped",
                    value: i.value,
                  })),
                  outWrapped:
                    r.output[0]?.value === undefined
                      ? outputGenerator.next()[0]
                      : ArgDefMutator.mutate(
                          [outputSpec],
                          [
                            {
                              tag: "ArgValueTypeWrapped",
                              value: r.output[0]?.value,
                            },
                          ],
                          basis.prng
                        )[0],
                });
              } catch (_e: unknown) {
                // Not able to mutate; move on
              }
            }

            return mutants.map((m) => {
              const mutatedOutput: FuzzIoElement[] = [
                {
                  ...r.output[0],
                  isException: m.exception,
                  isTimeout: m.timeout,
                  origin: {
                    type: "unknown", // !!!!!!!!!!
                  },
                  value: m.outWrapped.value,
                },
              ];
              const implicitJudgment: NamedJudgment = basis.results.env.options
                .useImplicit
                ? ImplicitOracle.judge(
                    m.timeout,
                    m.exception,
                    basis.fn.isVoid(),
                    mutatedOutput
                  )
                : ImplicitOracle.unknown;
              const exampleJudgment: NamedJudgment =
                basis.results.env.options.useHuman && r.expectedOutput
                  ? ExampleOracle.judge(
                      m.timeout,
                      m.exception,
                      r.expectedOutput,
                      mutatedOutput
                    )
                  : ExampleOracle.unknown;
              const propertyJudgmentDetail = propertyOracle.judge(
                unwrapResult(m)
              );
              const propertyJudgment = PropertyOracle.summarize(
                propertyJudgmentDetail
              );
              const compositeJudgment = CompositeOracle.judge([
                [exampleJudgment, propertyJudgment],
                [implicitJudgment],
              ]);
              const mutatedExample: JudgedExample = {
                example: m,
                source: {
                  type: "mutation",
                  runId: basis.results.runId,
                  testId: r.testId,
                },
                judgments: {
                  implicit: implicitJudgment,
                  example: exampleJudgment,
                  property: propertyJudgment,
                  propertyDetail: propertyJudgmentDetail,
                  composite: compositeJudgment,
                },
                addlJudgments: {},
              };
              return mutatedExample;
            });
          })
          .flat()
      : [];

    // Generate & diff the candidate property judgments
    this._model.genProps(basis.fn, schema).then((props) => {
      console.debug(
        `In the post-llm handler w/${concreteExamples.length} concrete example(s), ${mutatedExamples.length} mutated example(s), and these props:: ${JSON5.stringify(props, null, 2)}`
      ); // !!!!!!!!!!
      const propRunners: ConstructorParameters<
        typeof CompositeJudgmentDiff
      >[2] = [];
      props.forEach((p) => {
        try {
          propRunners.push({
            name: p.functionName,
            runner: RunnerFactory({
              type: "typescript.src",
              src: p.functionSourceCode.join("\n"),
              fnName: p.functionName,
              fileName: path.resolve(
                `${basis.fn.getModule()}.prospective.${p.functionName}.ts`
              ),
            }),
          });
          console.debug(`created jsrunner for ${p.functionName}`); // !!!!!!!!!!!
        } catch (e: unknown) {
          console.debug(
            `Exception building a runner for generated validator: ${p.functionName}. Src: ${p.functionSourceCode}. Exception: ${isError(e) ? `${e.name}: ${e.message}` : `<unknown>`}`
          );
        }
      });

      const differ = new CompositeJudgmentDiff(
        basis.results.runId,
        [...concreteExamples, ...mutatedExamples],
        propRunners
      );
      props.forEach((p) => {
        console.debug(`---------------------`); // !!!!!!!!!!
        const diff = differ.diffFor([p.functionName]);
        console.debug(
          `diff for "${p.functionName}": ${JSON5.stringify(
            {
              ...diff,
              detail: {
                exceptions: diff.detail.exceptions.length,
                falseFailures: diff.detail.falseFailures.length,
                falsePasses: diff.detail.falsePasses.length,
                trueFailures: diff.detail.trueFailures.length,
                truePasses: diff.detail.truePasses.length,
                prospectiveFailures: diff.detail.prospectiveFailures.length,
              },
            },
            null,
            2
          )}`
        ); // !!!!!!!!!!
        callbackFn(
          new PropertyIdeaModel(
            {
              type: "idea.property",
              id: p.functionName,
              name: p.functionName,
              priority: diff.priority,
              src: p.functionSourceCode,
              diff: diff,
              status: "proposed",
            },
            basis
          )
        );
      });
    });
  }
}

const schema = zod
  .array(
    zod.strictObject({
      functionSourceCode: zod
        .array(
          zod
            .string()
            .describe(
              `One line of source code. Preserve whitespace and comments.`
            )
        )
        .describe(
          `Property assertion function source code organized as an array of source code lines that include the function signature and the docstring comment. The function must return \`"pass" | "fail" | "unknown"\``
        ),
      functionName: zod.string().describe(`Callable name of the function`),
    })
  )
  .toJSONSchema();

export type PropertyIdeaData = AbstractIdeaData & {
  type: "idea.property";
  src: string[];
  diff: JudgmentDiff;
};
