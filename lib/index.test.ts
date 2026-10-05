// Copyright 2021 Google LLC. Use of this source code is governed by an
// MIT-style license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

import * as fs from 'fs';
import * as p from 'path';

import {ExitEvent, StderrEvent, StdoutEvent, SyncChildProcess} from './index';

describe('SyncChildProcess', () => {
  describe('stdio', () => {
    it('emits stdout', () => {
      withJSProcess('console.log("hello, world!");', node => {
        expectStdout(node.next(), 'hello, world!\n');
      });
    });

    it('emits stderr', () => {
      withJSProcess('console.error("hello, world!");', node => {
        expectStderr(node.next(), 'hello, world!\n');
      });
    });

    it('receives stdin', () => {
      withJSProcess(
        'process.stdin.on("data", (data) => process.stdout.write(data));',
        node => {
          node.stdin.write('hi there!\n');
          expectStdout(node.next(), 'hi there!\n');
          node.stdin.write('fblthp\n');
          expectStdout(node.next(), 'fblthp\n');
        },
      );
    });

    it('closes stdin', () => {
      withJSProcess(
        `
          process.stdin.on("data", () => {});
          process.stdin.on("end", () => console.log("closed!"));
        `,
        node => {
          node.stdin.end();
          expectStdout(node.next(), 'closed!\n');
        },
      );
    });
  });

  describe('emits exit', () => {
    it('with code 0 by default', () => {
      withJSProcess('', node => {
        expectExit(node.next(), 0);
      });
    });

    it('with a non-0 code', () => {
      withJSProcess('process.exit(123);', node => {
        expectExit(node.next(), 123);
      });
    });

    it('with a signal code', () => {
      withJSProcess('for (;;) {}', node => {
        node.kill('SIGINT');
        expectExit(node.next(), 'SIGINT');
      });
    });
  });

  describe('emits an error', () => {
    it('when writing to a closed stdin', () => {
      withJSProcess('console.log("ready!");', node => {
        expectStdout(node.next(), 'ready!\n');
        node.stdin.write('hi there!\n');

        // This test is inherently time-dependent: in order to throw an error,
        // the inner process must exit before the worker thread writes to
        // stdin. In order to accommodate that, we expect one of two paths:
        // either the write succeeds and the process exits immediatley, or the
        // write fails and we get an EPIPE followed by an exit.
        //
        // The main thing we *don't* want to see here is a deadlock, in which
        // case neither expectation will be satisfied.
        let result: NextResult;
        try {
          result = node.next();
        } catch (err) {
          expect(`${err}`).toMatch(/EPIPE/);
          result = node.next();
        }
        expectExit(result, 0);
      });
    });

    it('when the process fails to start', () => {
      const process = new SyncChildProcess('non-existent-executable');
      expect(() => process.next()).toThrow(/ENOENT/);
      expectExit(process.next(), undefined);
    });
  });

  it('passes options to the subprocess', () => {
    withJSFile('console.log(process.env.SYNC_PROCESS_TEST);', file => {
      const node = new SyncChildProcess(process.argv0, [file], {
        env: {...process.env, SYNC_PROCESS_TEST: 'abcdef'},
      });
      expectStdout(node.next(), 'abcdef\n');
      node.kill();
    });
  });
});

type NextResult = IteratorResult<
  StdoutEvent | StderrEvent,
  ExitEvent | undefined
>;

/** Asserts that `result` contains a `StdoutEvent` with text `text`. */
function expectStdout(result: NextResult, text: string): void {
  expect(result.done).toBeFalsy();
  const event = (result as IteratorYieldResult<StdoutEvent | StderrEvent>)
    .value;
  if (event.type === 'stderr') {
    throw `Expected stdout event, was stderr event: ${event.data.toString()}`;
  }

  expect(event.type).toEqual('stdout');
  expect((event as StdoutEvent).data.toString()).toEqual(text);
}

/** Asserts that `result` contains a `StderrEvent` with text `text`. */
function expectStderr(result: NextResult, text: string): void {
  expect(result.done).toBeFalsy();
  const event = (result as IteratorYieldResult<StdoutEvent | StderrEvent>)
    .value;
  if (event.type === 'stdout') {
    throw `Expected stderr event, was stdout event: ${event.data.toString()}`;
  }

  expect(event.type).toEqual('stderr');
  expect((event as StderrEvent).data.toString()).toEqual(text);
}

/**
 * Asserts that `result` contains an `ExitEvent` with either the given exit code
 * (if `codeOrSignal` is a number) or signal (if `codeOrSignal` is a string).
 */
function expectExit(
  result: NextResult,
  codeOrSignal: number | NodeJS.Signals | undefined,
): void {
  expect(result.done).toBe(true);
  const event = result.value!;
  if (event.type !== 'exit') {
    throw (
      `Expected exit event, was ${event.type} event: ` + event.data.toString()
    );
  }

  expect(event).toEqual(
    typeof codeOrSignal === 'number'
      ? {type: 'exit', code: codeOrSignal}
      : {type: 'exit', signal: codeOrSignal},
  );
}

/**
 * Starts a `SyncChildProcess` running a JS file with the given `contents` and
 * passes it to `callback`.
 */
function withJSProcess(
  contents: string,
  callback: (process: SyncChildProcess) => void,
): void {
  return withJSFile(contents, file => {
    const node = new SyncChildProcess(process.argv0, [file]);

    try {
      callback(node);
    } finally {
      node.kill();
    }
  });
}

/**
 * Creates a JS file with the given `contents` for the duration of `callback`.
 *
 * The `callback` is passed the name of the created file.
 */
function withJSFile(contents: string, callback: (file: string) => void): void {
  const testDir = p.join('spec', 'sandbox', `${Math.random()}`.slice(2));
  fs.mkdirSync(testDir, {recursive: true});
  const file = p.join(testDir, 'script.js');
  fs.writeFileSync(file, contents);

  try {
    callback(file);
  } finally {
    fs.rmSync(testDir, {force: true, recursive: true});
  }
}
