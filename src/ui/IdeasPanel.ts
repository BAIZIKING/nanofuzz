import JSON5 from "json5";
import * as vscode from "vscode";
import * as zod from "zod";
import { LlmAdapter } from "../fuzzer/adapters/LlmAdapter";
import {
  FunctionDef,
  FuzzIoElement,
  FuzzTestResults,
  ResultWrapped,
  unwrapResult,
} from "../fuzzer/Fuzzer";
import {
  CompositeJudgmentDiff,
  JudgedExample,
} from "../fuzzer/oracles/JudgmentDiff";
import { RunnerFactory } from "../fuzzer/runners/RunnerFactory";
import path from "node:path";
import { CompositeOracle } from "../fuzzer/oracles/CompositeOracle";
import { FuzzPanelMessageToWebView } from "./FuzzPanel";
import { NamedJudgment } from "../fuzzer/oracles/Types";
import { ImplicitOracle } from "../fuzzer/oracles/ImplicitOracle";
import { ArgDefMutator } from "../fuzzer/analysis/typescript/ArgDefMutator";
import seedrandom from "seedrandom";
import { ExampleOracle } from "../fuzzer/oracles/ExampleOracle";
import { ArgDefGenerator } from "../fuzzer/analysis/typescript/ArgDefGenerator";
import { PropertyOracle } from "../fuzzer/oracles/PropertyOracle";
import { propertyOracleFromNodeModule } from "../fuzzer/oracles/Util";
import { isError } from "../Util";

let _isBusy: boolean = false;
const model = new LlmAdapter();
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

// !!!!!!
// !!!!!!!!!! This should not be in the IdeasPanel class
export function proposeProperties(
  webview: vscode.Webview,
  module: NodeJS.Module,
  fn: FunctionDef,
  results: FuzzTestResults,
  prng: seedrandom.prng | undefined = seedrandom()
): void {
  if (
    _isBusy ||
    !LlmAdapter.isConfigured() ||
    !vscode.workspace
      .getConfiguration("nanofuzz.ai.properties")
      .get<boolean>("generate", false) ||
    !results.env.options.useProperty
  ) {
    return;
  } else {
    _isBusy = true;
  }

  const outputSpec = fn.getReturnArg();
  const outputGenerator = outputSpec
    ? new ArgDefGenerator([outputSpec], prng)
    : undefined;
  const propertyOracle: PropertyOracle = propertyOracleFromNodeModule(
    module,
    results.env.validators.map((f) => f.name)
  );

  // Concrete examples actually tested
  const concreteExamples: JudgedExample[] = results.results.map((r) => {
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
        runId: results.runId,
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
    ? results.results
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
                        prng
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
            const implicitJudgment: NamedJudgment = results.env.options
              .useImplicit
              ? ImplicitOracle.judge(
                  m.timeout,
                  m.exception,
                  fn.isVoid(),
                  mutatedOutput
                )
              : ImplicitOracle.unknown;
            const exampleJudgment: NamedJudgment =
              results.env.options.useHuman && r.expectedOutput
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
                runId: results.runId,
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
  model.genProps(fn, schema).then((props) => {
    console.debug(
      `In the post-llm handler w/${concreteExamples.length} concrete example(s), ${mutatedExamples.length} mutated example(s), and these props:: ${JSON5.stringify(props, null, 2)}`
    ); // !!!!!!!!!!
    const propRunners: ConstructorParameters<typeof CompositeJudgmentDiff>[2] =
      [];
    props.forEach((p) => {
      try {
        propRunners.push({
          name: p.functionName,
          runner: RunnerFactory({
            type: "typescript.src",
            src: p.functionSourceCode.join("\n"),
            fnName: p.functionName,
            fileName: path.resolve(
              `${fn.getModule()}.prospective.${p.functionName}.ts`
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
      results.runId,
      [...concreteExamples, ...mutatedExamples],
      propRunners
    );
    const message: FuzzPanelMessageToWebView = {
      command: "props.proposed",
      props: {},
    };
    props.forEach((p) => {
      console.debug(`---------------------`); // !!!!!!!!!!
      const diff = differ.diffFor([p.functionName]);
      // !!!!!!!!!!!!if (diff.priority > 0) {
      message.props[p.functionName] = {
        src: p.functionSourceCode,
        diffSerialized: JSON5.stringify(diff),
      };
      //}
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
    });
    webview.postMessage(message);
    _isBusy = false;
  });
} // !!!!!!

// !!!!!!
export function isBusy(): boolean {
  return _isBusy;
} // !!!!!!
