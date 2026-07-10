import * as assert from 'assert';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as net from 'net';
import * as path from 'path';
import * as readline from 'readline';
import { afterEach, describe, it } from 'mocha';
import { findSystemPython, fixturesDir, projectRoot, sleep } from './testHelpers';

interface DapMessage {
  type?: string;
  seq?: number;
  command?: string;
  request_seq?: number;
  success?: boolean;
  message?: string;
  event?: string;
  body?: Record<string, unknown>;
}

class RawDapClient {
  private readonly socket: net.Socket;
  private buffer = Buffer.alloc(0);
  private nextSeq = 1;
  private messages: DapMessage[] = [];
  private waiters: Array<{
    predicate: (message: DapMessage) => boolean;
    resolve: (message: DapMessage) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  private constructor(socket: net.Socket) {
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.parseMessages();
    });
    socket.on('error', (error) => this.rejectAll(error));
    socket.on('close', () => this.rejectAll(new Error('DAP socket closed')));
  }

  static async connect(host: string, port: number): Promise<RawDapClient> {
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const candidate = net.createConnection({ host, port });
      candidate.once('connect', () => resolve(candidate));
      candidate.once('error', reject);
    });
    return new RawDapClient(socket);
  }

  request(command: string, args?: Record<string, unknown>): number {
    const seq = this.nextSeq++;
    const message: Record<string, unknown> = { seq, type: 'request', command };
    if (args !== undefined) {
      message.arguments = args;
    }
    const payload = Buffer.from(JSON.stringify(message), 'utf8');
    this.socket.write(`Content-Length: ${payload.length}\r\n\r\n`);
    this.socket.write(payload);
    return seq;
  }

  waitFor(
    predicate: (message: DapMessage) => boolean,
    timeoutMs: number = 5_000,
  ): Promise<DapMessage> {
    const index = this.messages.findIndex(predicate);
    if (index >= 0) {
      return Promise.resolve(this.messages.splice(index, 1)[0]);
    }
    return new Promise<DapMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiterIndex = this.waiters.findIndex((item) => item.timer === timer);
        if (waiterIndex >= 0) {
          this.waiters.splice(waiterIndex, 1);
        }
        reject(new Error('Timed out waiting for DAP message'));
      }, timeoutMs);
      this.waiters.push({ predicate, resolve, reject, timer });
    });
  }

  response(requestSeq: number): Promise<DapMessage> {
    return this.waitFor(
      (message) => message.type === 'response' && message.request_seq === requestSeq,
    );
  }

  event(name: string): Promise<DapMessage> {
    return this.waitFor((message) => message.type === 'event' && message.event === name);
  }

  hasResponse(requestSeq: number): boolean {
    return this.messages.some(
      (message) => message.type === 'response' && message.request_seq === requestSeq,
    );
  }

  close(): void {
    this.socket.destroy();
  }

  private parseMessages(): void {
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) {
        return;
      }
      const headers = this.buffer.subarray(0, headerEnd).toString('ascii');
      const match = headers.match(/(?:^|\r\n)Content-Length:\s*(\d+)/i);
      if (!match) {
        throw new Error(`DAP response has no Content-Length: ${headers}`);
      }
      const length = parseInt(match[1], 10);
      const messageEnd = headerEnd + 4 + length;
      if (this.buffer.length < messageEnd) {
        return;
      }
      const payload = this.buffer.subarray(headerEnd + 4, messageEnd).toString('utf8');
      this.buffer = this.buffer.subarray(messageEnd);
      this.dispatch(JSON.parse(payload) as DapMessage);
    }
  }

  private dispatch(message: DapMessage): void {
    const index = this.waiters.findIndex((waiter) => waiter.predicate(message));
    if (index < 0) {
      this.messages.push(message);
      return;
    }
    const waiter = this.waiters.splice(index, 1)[0];
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  }

  private rejectAll(error: Error): void {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object');
  return value as Record<string, unknown>;
}

async function probeEndpoint(host: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    socket.once('connect', () => socket.end());
    socket.once('close', () => resolve());
    socket.once('error', reject);
  });
}

describe('Feature: dependency-free experimental DAP tracer', function () {
  let target: ChildProcessWithoutNullStreams | undefined;
  let client: RawDapClient | undefined;

  afterEach(async function () {
    client?.close();
    if (target && target.exitCode === null && !target.signalCode) {
      target.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        target?.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  });

  it('serves attach, breakpoint inspection, stepping, pause, and safe disconnect', async function () {
    this.timeout(30_000);
    const python = await findSystemPython();
    if (!python) {
      this.skip();
      return;
    }

    const fixture = path.join(fixturesDir(), 'native_dap_target.py');
    const source = await fs.readFile(fixture, 'utf8');
    const definitionLine = source.split(/\r?\n/).findIndex((line) => line.startsWith('def calculate(')) + 1;
    const breakpointLine = source.split(/\r?\n/).findIndex((line) => line.includes('# BREAKPOINT')) + 1;
    assert.ok(definitionLine > 0);
    assert.ok(breakpointLine > 0);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PORT_MANAGER_HOOK: '0',
      PORT_MANAGER_HOOK_DISABLED: '1',
    };
    delete env.DYLD_INSERT_LIBRARIES;
    delete env.LD_PRELOAD;
    target = spawn(python, [fixture, path.join(projectRoot(), 'python')], {
      env,
      cwd: fixturesDir(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const outputLines: string[] = [];
    const output = readline.createInterface({ input: target.stdout });
    const info = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Tracer target did not publish endpoint')), 8_000);
      output.once('line', (line) => {
        clearTimeout(timer);
        outputLines.push(line);
        resolve(JSON.parse(line) as Record<string, unknown>);
      });
      target?.once('exit', (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`Tracer target exited early: code=${code} signal=${signal}`));
      });
    });
    output.on('line', (line) => outputLines.push(line));

    assert.strictEqual(info.idempotent, true);
    assert.strictEqual(info.debugpy_loaded, false);
    assert.strictEqual(info.pydevd_loaded, false);
    const host = String(info.host);
    const port = Number(info.port);

    // The extension's liveness check uses a connect-and-close probe. It must
    // not consume the tracer's one real DAP session.
    await probeEndpoint(host, port);
    client = await RawDapClient.connect(host, port);

    const initialize = client.request('initialize', { adapterID: 'django-process' });
    const initializeResponse = await client.response(initialize);
    assert.strictEqual(initializeResponse.success, true);
    assert.strictEqual(initializeResponse.body?.supportsConfigurationDoneRequest, true);
    assert.strictEqual(initializeResponse.body?.supportsVariablePaging, true);
    assert.strictEqual(initializeResponse.body?.supportsConditionalBreakpoints, undefined);

    const attach = client.request('attach', { request: 'attach' });
    await client.event('initialized');
    await sleep(30);
    assert.strictEqual(client.hasResponse(attach), false, 'attach must wait for configurationDone');

    const setBreakpoints = client.request('setBreakpoints', {
      source: { path: fixture },
      breakpoints: [
        { line: definitionLine },
        { line: breakpointLine },
        { line: breakpointLine, condition: 'seed == 20' },
      ],
    });
    const breakpointsResponse = await client.response(setBreakpoints);
    const breakpointRows = breakpointsResponse.body?.breakpoints as Array<Record<string, unknown>>;
    assert.strictEqual(breakpointRows[0].verified, true);
    assert.strictEqual(breakpointRows[1].verified, true);
    assert.strictEqual(breakpointRows[2].verified, false);
    assert.match(String(breakpointRows[2].message), /does not support condition/);

    const exceptions = client.request('setExceptionBreakpoints', { filters: [] });
    assert.strictEqual((await client.response(exceptions)).success, true);
    const unsupportedExceptions = client.request('setExceptionBreakpoints', {
      filters: ['raised'],
    });
    const unsupportedExceptionsResponse = await client.response(unsupportedExceptions);
    assert.strictEqual(unsupportedExceptionsResponse.success, false);
    assert.match(String(unsupportedExceptionsResponse.message), /does not support exception/i);
    const configurationDone = client.request('configurationDone');
    assert.strictEqual((await client.response(configurationDone)).success, true);
    assert.strictEqual((await client.response(attach)).success, true);

    target.stdin.write('GO\n');
    const functionEntry = await client.event('stopped');
    assert.strictEqual(functionEntry.body?.reason, 'breakpoint');
    const functionThreadId = Number(functionEntry.body?.threadId);
    const entryStackRequest = client.request('stackTrace', { threadId: functionThreadId });
    const entryStack = (await client.response(entryStackRequest)).body
      ?.stackFrames as Array<Record<string, unknown>>;
    assert.strictEqual(entryStack[0].line, definitionLine);
    const enterFunction = client.request('continue', { threadId: functionThreadId });
    assert.strictEqual((await client.response(enterFunction)).success, true);

    const stopped = await client.event('stopped');
    assert.strictEqual(stopped.body?.reason, 'breakpoint');
    assert.strictEqual(stopped.body?.allThreadsStopped, false);
    const threadId = Number(stopped.body?.threadId);

    const threadsRequest = client.request('threads');
    const threads = (await client.response(threadsRequest)).body?.threads as Array<Record<string, unknown>>;
    assert.ok(threads.some((thread) => thread.id === threadId && thread.name === 'request-worker'));

    const stackRequest = client.request('stackTrace', { threadId });
    const stack = (await client.response(stackRequest)).body?.stackFrames as Array<Record<string, unknown>>;
    assert.strictEqual(stack[0].line, breakpointLine);
    const frameId = Number(stack[0].id);

    const scopesRequest = client.request('scopes', { frameId });
    const scopes = (await client.response(scopesRequest)).body?.scopes as Array<Record<string, unknown>>;
    const variablesRequest = client.request('variables', {
      variablesReference: Number(scopes[0].variablesReference),
    });
    const variables = (await client.response(variablesRequest)).body?.variables as Array<Record<string, unknown>>;
    assert.ok(variables.some((variable) => variable.name === 'payload'));
    const large = variables.find((variable) => variable.name === 'large');
    assert.ok(large);
    const allVariablesRequest = client.request('variables', {
      variablesReference: Number(large.variablesReference),
      start: 0,
      count: 0,
    });
    const allVariables = (await client.response(allVariablesRequest)).body
      ?.variables as Array<Record<string, unknown>>;
    assert.strictEqual(allVariables.length, 500, 'DAP count=0 must return all remaining variables');
    const pagedVariablesRequest = client.request('variables', {
      variablesReference: Number(large.variablesReference),
      start: 250,
      count: 5,
    });
    const pagedVariables = (await client.response(pagedVariablesRequest)).body
      ?.variables as Array<Record<string, unknown>>;
    assert.deepStrictEqual(pagedVariables.map((variable) => variable.name), ['250', '251', '252', '253', '254']);
    const dangerous = variables.find((variable) => variable.name === 'dangerous');
    assert.ok(dangerous);
    assert.match(String(dangerous.value), /DangerousValue object/);

    const next = client.request('next', { threadId });
    assert.strictEqual((await client.response(next)).success, true);
    const stepped = await client.event('stopped');
    assert.strictEqual(stepped.body?.reason, 'step');
    const expiredScopes = client.request('scopes', { frameId });
    assert.strictEqual((await client.response(expiredScopes)).success, false);

    const continued = client.request('continue', { threadId });
    const continuedResponse = await client.response(continued);
    assert.strictEqual(continuedResponse.success, true);
    assert.strictEqual(continuedResponse.body?.allThreadsContinued, true);
    const pause = client.request('pause', { threadId });
    assert.strictEqual((await client.response(pause)).success, true);
    const paused = await client.event('stopped');
    assert.strictEqual(paused.body?.reason, 'pause');
    assert.strictEqual(paused.body?.allThreadsStopped, false);

    const disconnect = client.request('disconnect', { terminateDebuggee: false });
    assert.strictEqual((await client.response(disconnect)).success, true);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Target did not resume after disconnect')), 8_000);
      target?.once('exit', (code, signal) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Target exit: code=${code} signal=${signal}`));
        }
      });
    });
    assert.ok(outputLines.includes('RESULT=82'));
  });
});
