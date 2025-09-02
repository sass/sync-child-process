// Copyright 2021 Google LLC. Use of this source code is governed by an
// MIT-style license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

import * as fs from 'fs';
import * as p from 'path';
import * as stream from 'stream';
import {Worker, WorkerOptions} from 'worker_threads';
import * as worker_threads from 'worker_threads';

import {SyncMessagePort} from 'sync-message-port';

import {ExitEvent, InternalEvent, StderrEvent, StdoutEvent} from './event';

export {ExitEvent, StderrEvent, StdoutEvent} from './event';

/** Whether {@link object} can't be transferred between threads, only cloned. */
function isMarkedAsUntransferable(object: unknown): boolean {
  // TODO: Remove this check when we no longer support Node v20 (after
  // 2026-04-30).
  return 'isMarkedAsUntransferable' in worker_threads
    ? // TODO - DefinitelyTyped/DefinitelyTyped#71033: Remove this cast
      (worker_threads.isMarkedAsUntransferable as (object: unknown) => boolean)(
        object,
      )
    : false;
}

/**
 * A child process that runs synchronously while also allowing the user to
 * interact with it before it shuts down.
 */
export class SyncChildProcess
  implements Iterator<StderrEvent | StdoutEvent, ExitEvent | undefined>
{
  /** The port that communicates with the worker thread. */
  private readonly port: SyncMessagePort;

  /** The worker in which the child process runs. */
  private readonly worker: Worker;

  /** The standard input stream to write to the process. */
  readonly stdin: stream.Writable;

  /** Creates a new synchronous process running `command` with `args`. */
  constructor(command: string, options?: Options);
  constructor(command: string, args: string[], options?: Options);

  constructor(
    command: string,
    argsOrOptions?: string[] | Options,
    options?: Options,
  ) {
    let args: string[];
    if (Array.isArray(argsOrOptions)) {
      args = argsOrOptions;
    } else {
      args = [];
      options = argsOrOptions;
    }

    const {port1, port2} = SyncMessagePort.createChannel();
    this.port = new SyncMessagePort(port1);

    this.worker = spawnWorker(p.join(p.dirname(__filename), 'worker'), {
      workerData: {port: port2, command, args, options},
      transferList: [port2],
    });

    // The worker shouldn't emit any errors unless it breaks in development.
    this.worker.on('error', console.error);

    this.stdin = new stream.Writable({
      write: (chunk: Buffer<ArrayBuffer>, encoding, callback) => {
        this.port.postMessage(
          {
            type: 'stdin',
            data: chunk,
          },
          isMarkedAsUntransferable(chunk.buffer) ? undefined : [chunk.buffer],
        );
        callback();
      },
      final: () => this.port.postMessage({type: 'stdinClosed'}),
    });
  }

  /**
   * Blocks until the child process is ready to emit another event, then returns
   * that event. This will return an [IteratorReturnResult] with an [ExitEvent]
   * once when the process exits. If it's called again after that, it will
   * return `{done: true}` without a value.
   *
   * If there's an error running the child process, this will throw that error.
   */
  next(): IteratorResult<StdoutEvent | StderrEvent, ExitEvent | undefined> {
    if (this.stdin.destroyed) return {done: true, value: undefined};

    const message = this.port.receiveMessage() as InternalEvent;
    switch (message.type) {
      case 'stdout':
        return {
          value: {type: 'stdout', data: Buffer.from(message.data.buffer)},
        };

      case 'stderr':
        return {
          value: {type: 'stderr', data: Buffer.from(message.data.buffer)},
        };

      case 'error':
        this.close();
        throw message.error;

      case 'exit':
        this.close();
        return {done: true, value: message};
    }
  }

  // TODO(nex3): Add a non-blocking `yieldIfReady()` function that returns
  // `null` if the worker hasn't queued up an event.

  // TODO(nex3): Add a `yieldAsync()` function that returns a `Promise<Event>`.

  /**
   * Sends a signal (`SIGTERM` by default) to the child process.
   *
   * This has no effect if the process has already exited.
   */
  kill(signal?: NodeJS.Signals | number): void {
    this.port.postMessage({type: 'kill', signal});
  }

  /** Closes down the worker thread and the stdin stream. */
  private close(): void {
    this.port.close();
    void this.worker.terminate();
    this.stdin.destroy();
  }
}

/**
 * Spawns a worker for the given `fileWithoutExtension` in either a JS or TS
 * worker, depending on which file exists.
 */
function spawnWorker(
  fileWithoutExtension: string,
  options: WorkerOptions,
): Worker {
  // The released version always spawns the JS worker. The TS worker is only
  // used for development.
  const jsFile = fileWithoutExtension + '.js';
  if (fs.existsSync(jsFile)) return new Worker(jsFile, options);

  const tsFile = fileWithoutExtension + '.ts';
  if (fs.existsSync(tsFile)) {
    return new Worker(
      `
        require('ts-node').register();
        require(${JSON.stringify(tsFile)});
      `,
      {...options, eval: true},
    );
  }

  throw new Error(`Neither "${jsFile}" nor ".ts" exists.`);
}

/**
 * A subset of the options for [`child_process.spawn()`].
 *
 * [`child_process.spawn()`]: https://nodejs.org/api/child_process.html#child_processspawncommand-args-options
 */
export interface Options {
  cwd?: string;
  env?: Record<string, string>;
  argv0?: string;
  uid?: number;
  gid?: number;
  shell?: boolean | string;
  windowsVerbatimArguments?: boolean;
  windowsHide?: boolean;
  timeout?: number;
  killSignal?: string | number;
}
