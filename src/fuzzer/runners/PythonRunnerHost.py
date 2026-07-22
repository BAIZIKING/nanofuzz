import importlib.util
import sys
import os
import io
import struct
import logging
import traceback
from contextlib import redirect_stdout
from typing import Any, Literal, List, Union, TypedDict, NotRequired

try:
    import json5
    import coverage
except ModuleNotFoundError as e:
    print(f"ERROR {e}")
    exit(3)


class RunnerInput(TypedDict):
    args: List[any]
    seq: int


class RunnerValueResult(TypedDict):
    tag: Literal["value"]
    value: Any
    seq: int
    coverageData: NotRequired[List[int]]


class RunnerErrorResult(TypedDict):
    tag: Literal["error"]
    name: str
    message: str
    stack: NotRequired[str]
    source: Literal["put", "host"]
    seq: int
    coverageData: NotRequired[List[int]]


type RunnerResult = Union[RunnerValueResult, RunnerErrorResult]


def loadPythonFn(filename: str, modulename: str, fn: str) -> Union[RunnerErrorResult, None]:
    spec = importlib.util.spec_from_file_location(modulename, filename)
    if spec is None:
        return [RunnerErrorResult(
            tag="error",
            name="PythonRunnerHostError",
            message=f"Could not import python module: {filename}",
            source="host",
            seq=-1
        ), None]
    module = importlib.util.module_from_spec(spec)

    try:
        sys.modules[modulename] = module
        with redirect_stdout(io.StringIO()) as f:
            spec.loader.exec_module(module)
        return [None, getattr(module, fnname)]
    except Exception as e:
        return [RunnerErrorResult(
            tag="error",
            name="PythonPutLoadError",
            message=str(e),
            source="put",
            stack=traceback.format_exc(),
            seq=-1
        ), None]


def get_inputs() -> RunnerInput:
    logging.debug("Waiting for input")
    while True:
        # Read the 4-byte length header
        header = sys.stdin.buffer.read(4)
        if not header:
            break
        length = struct.unpack('>I', header)[0]
        logging.debug(f" - Incoming input of length {length}")

        # Read exactly that many bytes
        payload = sys.stdin.buffer.read(length).decode('utf-8')
        logging.debug(f" - With value {payload}")

        # De-serialize arguments for calling the function
        input: RunnerInput = json5.loads(payload)
        logging.debug(f" - Parsed ok")

        return input


def coverage_lines(cov: coverage.Coverage, filename: str) -> List[int]:
    """
    Returns the sorted line numbers executed since the last `cov.erase()`.

    Note: `CoverageData.lines()` returns None (not an error) when `filename`
    does not exactly match the key coverage.py recorded, so fall back to
    matching against the measured files.
    """
    data = cov.get_data()
    lines = data.lines(filename)
    if lines is None:
        target = os.path.normcase(os.path.realpath(filename))
        for measured in data.measured_files():
            if os.path.normcase(os.path.realpath(measured)) == target:
                lines = data.lines(measured)
                break
    return sorted(lines or [])


def run_put(input: RunnerInput, filename: str, cov: coverage.Coverage) -> RunnerResult:
    logging.debug(f"Running function '{fnname}' for {input}")

    # Measure only the call itself: module-level code already ran at load
    cov.erase()
    cov.start()
    error = None
    value = None
    try:
        with redirect_stdout(io.StringIO()) as f:
            value = fn(*input["args"])
    except Exception as e:
        error = e
    finally:
        cov.stop()

    # Read coverage after stopping: a failing input still covers lines, and
    # those inputs are often the interesting ones.
    coverageData = coverage_lines(cov, filename)

    if error is not None:
        return RunnerErrorResult(
            tag="error",
            name="PythonPutError",
            message=str(error),
            source="put",
            stack="".join(traceback.format_exception(
                type(error), error, error.__traceback__)),
            seq=input["seq"],
            coverageData=coverageData
        )

    return RunnerValueResult(
        tag="value",
        value=value,
        seq=input["seq"],
        coverageData=coverageData
    )


def put_result(result: RunnerResult) -> None:
    logging.debug(f"Returning result")
    send_msg(result)
    logging.debug(f" - Result returned")


def send_msg(data: RunnerResult):
    msg = json5.dumps(data).encode('utf-8')
    logging.debug(f" - Writing {len(msg)} bytes: {msg}")
    sys.stdout.buffer.write(struct.pack(
        '>I', len(msg)))  # payload size
    sys.stdout.buffer.write(msg)  # payload
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    logging.basicConfig(filename='debug.log',
                        level=logging.DEBUG)  # !!!!!!!!!!

    if len(sys.argv) != 4:
        print(
            "Usage: python PythonRunnerHost.py <filename.py> <module_name> <function_name>")
        sys.exit(2)

    # Arguments for loading the function
    filename = sys.argv[1]
    modulename = sys.argv[2]
    fnname = sys.argv[3]

    # Normalize the path: coverage.py keys its data by the resolved filename,
    # and `include` patterns must match it.
    filename = os.path.realpath(filename)

    # One in-memory coverage instance for the whole run. `data_file=None`
    # keeps coverage.py from writing a .coverage file into the user's project
    # on every test.
    cov = coverage.Coverage(include=[filename], branch=False, data_file=None)

    # Static analysis of the PUT: the set of executable lines. This is the
    # denominator for coverage and is stable for the whole run, so send it
    # once rather than with every result.
    _, statements, _excluded, _missing, _ = cov.analysis2(filename)

    # Try to load the function: either results in a RunnerErrorResult
    # or a callable function
    logging.debug(f"Loading function '{fnname}' in {filename}")
    [loadError, fn] = loadPythonFn(filename, modulename, fnname)
    if (loadError):
        logging.debug(" - Unable to load")
    else:
        logging.debug(" - Loaded function")

    # Change cwd from the extension to that of the Python script
    os.chdir(os.path.dirname(filename))

    # Ready for inputs
    msg = "READY".encode('utf-8')
    sys.stdout.buffer.write(msg)
    sys.stdout.buffer.flush()
    logging.debug(f"Sent READY message (length {len(msg)})")

    # Send the static coverage info once, as a length-prefixed message so it
    # uses the same framing as every other message on this pipe.
    msg = json5.dumps({
        "tag": "coverageInfo",
        "file": filename,
        "executable": sorted(statements),
    }).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('>I', len(msg)))  # payload size
    sys.stdout.buffer.write(msg)  # payload
    sys.stdout.buffer.flush()
    logging.debug(f"Sent coverageInfo ({len(statements)} executable lines)")

    # Start the run loop
    while True:
        logging.debug("Top of main loop")
        if (loadError == None):
            put_result(run_put(get_inputs(), filename, cov))  # Call the put
        else:
            get_inputs()
            put_result(loadError)  # Return the load error
