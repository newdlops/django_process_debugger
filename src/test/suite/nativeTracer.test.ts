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

const DAP_AUTH_TOKEN_KEY = '__djangoProcessDebuggerAuthToken';

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
    const conditionFalseLine = source.split(/\r?\n/)
      .findIndex((line) => line.includes('# CONDITION_FALSE')) + 1;
    const conditionErrorLine = source.split(/\r?\n/)
      .findIndex((line) => line.includes('# CONDITION_ERROR')) + 1;
    const hitLogpointLine = source.split(/\r?\n/)
      .findIndex((line) => line.includes('# HIT_LOGPOINT')) + 1;
    const breakpointLine = source.split(/\r?\n/).findIndex((line) => line.includes('# BREAKPOINT')) + 1;
    assert.ok(definitionLine > 0);
    assert.ok(conditionFalseLine > 0);
    assert.ok(conditionErrorLine > 0);
    assert.ok(hitLogpointLine > 0);
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

    let targetErrors = '';
    target.stderr.on('data', (chunk: Buffer) => {
      targetErrors += chunk.toString();
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
        reject(new Error(
          `Tracer target exited early: code=${code} signal=${signal}`
            + (targetErrors ? ` stderr=${targetErrors.trim()}` : ''),
        ));
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

    const unauthorized = await RawDapClient.connect(host, port);
    const unauthorizedInitialize = unauthorized.request('initialize', {
      adapterID: 'django-process',
    });
    assert.strictEqual(
      (await unauthorized.response(unauthorizedInitialize)).success,
      true,
    );
    const unauthorizedAttach = unauthorized.request('attach', {
      request: 'attach',
      [DAP_AUTH_TOKEN_KEY]: 'f'.repeat(64),
    });
    const unauthorizedResponse = await unauthorized.response(unauthorizedAttach);
    assert.strictEqual(unauthorizedResponse.success, false);
    assert.strictEqual(unauthorizedResponse.message, 'Authentication failed');
    unauthorized.close();
    await sleep(30);

    client = await RawDapClient.connect(host, port);

    const initialize = client.request('initialize', {
      adapterID: 'django-process',
      supportsVariablePaging: true,
      supportsVariableType: true,
    });
    const initializeResponse = await client.response(initialize);
    assert.strictEqual(initializeResponse.success, true);
    assert.strictEqual(initializeResponse.body?.supportsConfigurationDoneRequest, true);
    assert.strictEqual(initializeResponse.body?.supportsConditionalBreakpoints, true);
    assert.strictEqual(initializeResponse.body?.supportsHitConditionalBreakpoints, true);
    assert.strictEqual(initializeResponse.body?.supportsLogPoints, true);
    assert.strictEqual(initializeResponse.body?.supportsSetVariable, true);
    assert.strictEqual(initializeResponse.body?.supportsClipboardContext, true);
    assert.strictEqual(initializeResponse.body?.supportsValueFormattingOptions, true);
    assert.strictEqual(initializeResponse.body?.supportsExceptionInfoRequest, true);
    assert.deepStrictEqual(
      (initializeResponse.body?.exceptionBreakpointFilters as Array<Record<string, unknown>>)
        .map((filter) => filter.filter),
      ['raised', 'uncaught', 'djangoRequestUnhandled'],
    );
    assert.strictEqual(initializeResponse.body?.supportsVariablePaging, undefined);
    assert.strictEqual(initializeResponse.body?.supportsVariableType, undefined);
    assert.strictEqual(initializeResponse.body?.supportsEvaluateForHovers, undefined);

    const attach = client.request('attach', {
      request: 'attach',
      [DAP_AUTH_TOKEN_KEY]: String(info.authToken),
    });
    await client.event('initialized');
    await sleep(30);
    assert.strictEqual(client.hasResponse(attach), false, 'attach must wait for configurationDone');

    const setBreakpoints = client.request('setBreakpoints', {
      source: { path: fixture },
      breakpoints: [
        { line: definitionLine, condition: 'seed == 20' },
        {
          line: conditionFalseLine,
          condition: 'payload.__setitem__("false_checked", threading.current_thread().name) and False',
        },
        {
          line: conditionErrorLine,
          condition: '(_ for _ in ()).throw(SystemExit("condition error"))',
        },
        {
          line: breakpointLine,
          condition: 'payload.__setitem__("true_checked", threading.current_thread().name) or any(item == seed for item in payload["items"])',
        },
        {
          line: breakpointLine,
          condition: 'all(item >= seed for item in payload["items"])',
        },
        { line: breakpointLine, condition: 'seed ==' },
        {
          line: hitLogpointLine,
          condition: 'hit_index >= 2',
          hitCondition: '2',
        },
        {
          line: hitLogpointLine,
          logMessage: 'loop={hit_index} total={total} thread={threading.current_thread().name} literal={{ok}} data={ {"value": hit_index} }',
        },
        { line: hitLogpointLine, hitCondition: '% 2', logMessage: 'even={hit_index}' },
        {
          line: hitLogpointLine,
          condition: 'hit_index == 1',
          logMessage: 'error={(_ for _ in ()).throw(SystemExit("log error"))}',
        },
        { line: hitLogpointLine, hitCondition: '% 0' },
        { line: hitLogpointLine, logMessage: 'unclosed={hit_index' },
        { line: breakpointLine, condition: 'x'.repeat((64 * 1024) + 1) },
      ],
    });
    const breakpointsResponse = await client.response(setBreakpoints);
    const breakpointRows = breakpointsResponse.body?.breakpoints as Array<Record<string, unknown>>;
    assert.strictEqual(breakpointRows[0].verified, true);
    assert.strictEqual(breakpointRows[1].verified, true);
    assert.strictEqual(breakpointRows[2].verified, true);
    assert.strictEqual(breakpointRows[3].verified, true);
    assert.strictEqual(breakpointRows[4].verified, true);
    assert.strictEqual(breakpointRows[5].verified, false);
    assert.match(String(breakpointRows[5].message), /invalid breakpoint condition/i);
    assert.strictEqual(breakpointRows[6].verified, true);
    assert.strictEqual(breakpointRows[7].verified, true);
    assert.strictEqual(breakpointRows[8].verified, true);
    assert.strictEqual(breakpointRows[9].verified, true);
    assert.strictEqual(breakpointRows[10].verified, false);
    assert.match(String(breakpointRows[10].message), /invalid hit condition/i);
    assert.strictEqual(breakpointRows[11].verified, false);
    assert.match(String(breakpointRows[11].message), /invalid log message/i);
    assert.strictEqual(breakpointRows[12].verified, false);
    assert.match(String(breakpointRows[12].message), /invalid breakpoint condition/i);
    const definitionBreakpointId = Number(breakpointRows[0].id);
    const errorBreakpointId = Number(breakpointRows[2].id);
    const trueBreakpointId = Number(breakpointRows[3].id);
    const duplicateTrueBreakpointId = Number(breakpointRows[4].id);
    const hitCountBreakpointId = Number(breakpointRows[6].id);
    assert.ok(definitionBreakpointId > 0);
    assert.ok(errorBreakpointId > 0);
    assert.ok(trueBreakpointId > 0);
    assert.ok(duplicateTrueBreakpointId > 0);
    assert.ok(hitCountBreakpointId > 0);

    const exceptions = client.request('setExceptionBreakpoints', { filters: [] });
    assert.strictEqual((await client.response(exceptions)).success, true);
    const configurationDone = client.request('configurationDone');
    assert.strictEqual((await client.response(configurationDone)).success, true);
    assert.strictEqual((await client.response(attach)).success, true);

    target.stdin.write('GO\n');
    const functionEntry = await client.event('stopped');
    assert.strictEqual(functionEntry.body?.reason, 'breakpoint');
    assert.deepStrictEqual(functionEntry.body?.hitBreakpointIds, [definitionBreakpointId]);
    const functionThreadId = Number(functionEntry.body?.threadId);
    const entryStackRequest = client.request('stackTrace', { threadId: functionThreadId });
    const entryStack = (await client.response(entryStackRequest)).body
      ?.stackFrames as Array<Record<string, unknown>>;
    assert.strictEqual(entryStack[0].line, definitionLine);
    const enterFunction = client.request('continue', { threadId: functionThreadId });
    assert.strictEqual((await client.response(enterFunction)).success, true);

    const conditionError = await client.event('stopped');
    assert.strictEqual(conditionError.body?.reason, 'breakpoint');
    assert.strictEqual(
      conditionError.body?.description,
      'Breakpoint condition raised SystemExit',
    );
    assert.deepStrictEqual(conditionError.body?.hitBreakpointIds, [errorBreakpointId]);
    const conditionErrorThreadId = Number(conditionError.body?.threadId);
    const errorStackRequest = client.request('stackTrace', { threadId: conditionErrorThreadId });
    const errorStack = (await client.response(errorStackRequest)).body
      ?.stackFrames as Array<Record<string, unknown>>;
    assert.strictEqual(errorStack[0].line, conditionErrorLine);
    const continueAfterConditionError = client.request('continue', {
      threadId: conditionErrorThreadId,
    });
    assert.strictEqual((await client.response(continueAfterConditionError)).success, true);

    const hitCountStop = await client.event('stopped');
    assert.strictEqual(hitCountStop.body?.reason, 'breakpoint');
    assert.deepStrictEqual(hitCountStop.body?.hitBreakpointIds, [hitCountBreakpointId]);
    const hitCountThreadId = Number(hitCountStop.body?.threadId);
    const hitCountStackRequest = client.request('stackTrace', {
      threadId: hitCountThreadId,
    });
    const hitCountStack = (await client.response(hitCountStackRequest)).body
      ?.stackFrames as Array<Record<string, unknown>>;
    assert.strictEqual(hitCountStack[0].line, hitLogpointLine);
    const hitIndexRequest = client.request('evaluate', {
      expression: 'hit_index',
      frameId: Number(hitCountStack[0].id),
      context: 'watch',
    });
    assert.strictEqual((await client.response(hitIndexRequest)).body?.result, '3');

    const waitForOutput = (fragment: string) => client!.waitFor(
      (message) => message.type === 'event'
        && message.event === 'output'
        && String(message.body?.output).includes(fragment),
    );
    const firstLoopOutput = await waitForOutput(
      "loop=1 total=41 thread='request-worker' literal={ok} data={'value': 1}",
    );
    assert.strictEqual(firstLoopOutput.body?.category, 'console');
    assert.strictEqual(firstLoopOutput.body?.line, hitLogpointLine);
    assert.strictEqual(
      (firstLoopOutput.body?.source as Record<string, unknown>)?.path,
      fixture,
    );
    await waitForOutput("loop=2 total=41 thread='request-worker' literal={ok} data={'value': 2}");
    await waitForOutput("loop=3 total=41 thread='request-worker' literal={ok} data={'value': 3}");
    await waitForOutput('even=2');
    await waitForOutput('error=<evaluation raised SystemExit>');

    const continueAfterHitCount = client.request('continue', {
      threadId: hitCountThreadId,
    });
    assert.strictEqual((await client.response(continueAfterHitCount)).success, true);

    const stopped = await client.event('stopped');
    assert.strictEqual(stopped.body?.reason, 'breakpoint');
    assert.strictEqual(stopped.body?.allThreadsStopped, false);
    assert.deepStrictEqual(stopped.body?.hitBreakpointIds, [
      trueBreakpointId,
      duplicateTrueBreakpointId,
    ]);
    await waitForOutput("loop=4 total=41 thread='request-worker' literal={ok} data={'value': 4}");
    await waitForOutput('even=4');
    const threadId = Number(stopped.body?.threadId);

    const threadsRequest = client.request('threads');
    const threads = (await client.response(threadsRequest)).body?.threads as Array<Record<string, unknown>>;
    assert.ok(threads.some((thread) => thread.id === threadId && thread.name === 'request-worker'));

    const stackRequest = client.request('stackTrace', { threadId });
    const stack = (await client.response(stackRequest)).body?.stackFrames as Array<Record<string, unknown>>;
    assert.strictEqual(stack[0].line, breakpointLine);
    const frameId = Number(stack[0].id);
    const formattedStackRequest = client.request('stackTrace', {
      threadId,
      format: {
        parameters: true,
        parameterNames: true,
        parameterTypes: true,
        parameterValues: true,
        module: true,
        line: true,
        hex: true,
        includeAll: true,
      },
    });
    const formattedStack = (await client.response(formattedStackRequest)).body
      ?.stackFrames as Array<Record<string, unknown>>;
    assert.strictEqual(Number(formattedStack[0].id), frameId);
    assert.match(
      String(formattedStack[0].name),
      /__main__\.calculate\(seed: int=0x14\):line /,
    );

    const scopesRequest = client.request('scopes', { frameId });
    const scopes = (await client.response(scopesRequest)).body?.scopes as Array<Record<string, unknown>>;
    const localsScope = scopes.find((scope) => scope.name === 'Locals');
    const requestScope = scopes.find((scope) => scope.name === 'Django Request');
    const globalsScope = scopes.find((scope) => scope.name === 'Globals');
    assert.ok(localsScope);
    assert.ok(requestScope, 'ordinary request breakpoint must expose Django Request');
    assert.ok(globalsScope);
    const localsReference = Number(localsScope.variablesReference);
    const requestReference = Number(requestScope.variablesReference);
    const globalsReference = Number(globalsScope.variablesReference);
    const repeatedScopesRequest = client.request('scopes', { frameId });
    const repeatedScopes = (await client.response(repeatedScopesRequest)).body
      ?.scopes as Array<Record<string, unknown>>;
    assert.strictEqual(
      Number(repeatedScopes.find((scope) => scope.name === 'Locals')?.variablesReference),
      localsReference,
    );
    assert.strictEqual(
      Number(repeatedScopes.find((scope) => scope.name === 'Django Request')?.variablesReference),
      requestReference,
    );
    assert.strictEqual(
      Number(repeatedScopes.find((scope) => scope.name === 'Globals')?.variablesReference),
      globalsReference,
    );

    const requestVariablesRequest = client.request('variables', {
      variablesReference: requestReference,
    });
    const requestVariables = (await client.response(requestVariablesRequest)).body
      ?.variables as Array<Record<string, unknown>>;
    const requestValues = new Map(requestVariables.map((variable) => [
      String(variable.name),
      String(variable.value),
    ]));
    assert.strictEqual(requestValues.get('request'), '<WSGIRequest>');
    assert.strictEqual(requestValues.get('method'), "'GET'");
    assert.strictEqual(requestValues.get('path'), "'/orders/42/'");
    assert.strictEqual(requestValues.get('path_info'), "'/orders/42/'");
    assert.strictEqual(requestValues.get('resolver_match'), "'orders:detail'");
    const mutateRequestSnapshot = client.request('setVariable', {
      variablesReference: requestReference,
      name: 'method',
      value: "'POST'",
    });
    const mutateRequestResponse = await client.response(mutateRequestSnapshot);
    assert.strictEqual(mutateRequestResponse.success, false);
    assert.match(String(mutateRequestResponse.message), /read.?only/i);

    const globalsVariablesRequest = client.request('variables', {
      variablesReference: globalsReference,
    });
    const globalsVariables = (await client.response(globalsVariablesRequest)).body
      ?.variables as Array<Record<string, unknown>>;
    const globalValue = globalsVariables.find((variable) => variable.name === 'GLOBAL_VALUE');
    const shadowedGlobal = globalsVariables.find(
      (variable) => variable.name === 'SHADOWED_VALUE',
    );
    assert.strictEqual(
      globalsVariables.find((variable) => variable.name === 'REQUEST_HOOK_CALLS')?.value,
      '[]',
      'request scope discovery must not call repr, str, or properties',
    );
    assert.strictEqual(globalValue?.evaluateName, 'GLOBAL_VALUE');
    assert.strictEqual(shadowedGlobal?.evaluateName, undefined);
    const evaluateGlobalByName = client.request('evaluate', {
      expression: String(globalValue?.evaluateName),
      frameId,
      context: 'watch',
    });
    assert.strictEqual((await client.response(evaluateGlobalByName)).body?.result, '5');
    const setShadowedGlobal = client.request('setVariable', {
      variablesReference: globalsReference,
      name: 'SHADOWED_VALUE',
      value: '[1, 2]',
    });
    const setShadowedGlobalResponse = await client.response(setShadowedGlobal);
    const shadowedGlobalResultReference = Number(
      setShadowedGlobalResponse.body?.variablesReference,
    );
    assert.ok(shadowedGlobalResultReference > 0);
    const shadowedGlobalChildrenRequest = client.request('variables', {
      variablesReference: shadowedGlobalResultReference,
    });
    const shadowedGlobalChildren = (
      await client.response(shadowedGlobalChildrenRequest)
    ).body?.variables as Array<Record<string, unknown>>;
    assert.ok(
      shadowedGlobalChildren.every(
        (variable) => variable.evaluateName === undefined,
      ),
    );

    const threadEvaluate = client.request('evaluate', {
      expression: 'threading.current_thread().name',
      frameId,
      context: 'repl',
    });
    const threadEvaluateResponse = await client.response(threadEvaluate);
    assert.strictEqual(threadEvaluateResponse.success, true);
    assert.strictEqual(threadEvaluateResponse.body?.result, "'request-worker'");

    const globalThreadEvaluate = client.request('evaluate', {
      expression: 'threading.current_thread().name',
      context: 'repl',
    });
    assert.strictEqual(
      (await client.response(globalThreadEvaluate)).body?.result,
      "'request-worker'",
    );
    const localWithoutFrame = client.request('evaluate', {
      expression: 'total',
      context: 'repl',
    });
    assert.strictEqual((await client.response(localWithoutFrame)).success, false);

    const arithmeticEvaluate = client.request('evaluate', {
      expression: 'payload["seed"] + total',
      frameId,
      context: 'repl',
    });
    assert.strictEqual((await client.response(arithmeticEvaluate)).body?.result, '61');

    const comprehensionEvaluate = client.request('evaluate', {
      expression: '[item + total for item in payload["items"]]',
      frameId,
      context: 'repl',
    });
    assert.strictEqual(
      (await client.response(comprehensionEvaluate)).body?.result,
      '[61, 62]',
    );

    const setGlobal = client.request('setVariable', {
      variablesReference: globalsReference,
      name: 'GLOBAL_VALUE',
      value: 'GLOBAL_VALUE + 2',
    });
    assert.strictEqual((await client.response(setGlobal)).body?.value, '7');
    const changedGlobalEvaluate = client.request('evaluate', {
      expression: 'GLOBAL_VALUE',
      context: 'repl',
    });
    assert.strictEqual((await client.response(changedGlobalEvaluate)).body?.result, '7');

    const structuredEvaluate = client.request('evaluate', {
      expression: 'payload["items"] # trailing comment',
      frameId,
      context: 'repl',
    });
    const structuredBody = (await client.response(structuredEvaluate)).body;
    const structuredReference = Number(structuredBody?.variablesReference);
    assert.ok(structuredReference > 0);
    const structuredVariablesRequest = client.request('variables', {
      variablesReference: structuredReference,
    });
    const structuredVariables = (await client.response(structuredVariablesRequest)).body
      ?.variables as Array<Record<string, unknown>>;
    assert.deepStrictEqual(
      structuredVariables.map((variable) => variable.value),
      ['20', '21'],
    );
    const firstItemEvaluateName = structuredVariables[0].evaluateName;
    assert.strictEqual(typeof firstItemEvaluateName, 'string');
    assert.match(String(firstItemEvaluateName), /payload/);
    const evaluateFirstItemByName = client.request('evaluate', {
      expression: String(firstItemEvaluateName),
      frameId,
      context: 'watch',
    });
    assert.strictEqual(
      (await client.response(evaluateFirstItemByName)).body?.result,
      '20',
    );
    const setListItem = client.request('setVariable', {
      variablesReference: structuredReference,
      name: '0',
      value: 'seed + 5',
    });
    assert.strictEqual((await client.response(setListItem)).body?.value, '25');

    const tupleEvaluate = client.request('evaluate', {
      expression: '(1, 2)',
      frameId,
      context: 'repl',
    });
    const tupleReference = Number(
      (await client.response(tupleEvaluate)).body?.variablesReference,
    );
    const setTupleItem = client.request('setVariable', {
      variablesReference: tupleReference,
      name: '0',
      value: '9',
    });
    assert.strictEqual((await client.response(setTupleItem)).success, false);

    const nonStringDictEvaluate = client.request('evaluate', {
      expression: '{1: "read-only"}',
      frameId,
      context: 'repl',
    });
    const nonStringDictReference = Number(
      (await client.response(nonStringDictEvaluate)).body?.variablesReference,
    );
    const nonStringDictVariablesRequest = client.request('variables', {
      variablesReference: nonStringDictReference,
    });
    const nonStringDictVariables = (
      await client.response(nonStringDictVariablesRequest)
    ).body?.variables as Array<Record<string, unknown>>;
    assert.deepStrictEqual(nonStringDictVariables[0].presentationHint, {
      attributes: ['readOnly'],
    });
    const setNonStringDictItem = client.request('setVariable', {
      variablesReference: nonStringDictReference,
      name: '1',
      value: '9',
    });
    assert.strictEqual((await client.response(setNonStringDictItem)).success, false);

    const nestedEvaluate = client.request('evaluate', {
      expression: '{"child": [[1, 2]]}',
      frameId,
      context: 'repl',
    });
    const nestedReference = Number(
      (await client.response(nestedEvaluate)).body?.variablesReference,
    );
    const nestedVariablesRequest = client.request('variables', {
      variablesReference: nestedReference,
    });
    const nestedVariables = (await client.response(nestedVariablesRequest)).body
      ?.variables as Array<Record<string, unknown>>;
    const oldChildReference = Number(nestedVariables[0].variablesReference);
    const childVariablesRequest = client.request('variables', {
      variablesReference: oldChildReference,
    });
    const childVariables = (await client.response(childVariablesRequest)).body
      ?.variables as Array<Record<string, unknown>>;
    const oldGrandchildReference = Number(childVariables[0].variablesReference);
    const replaceNestedChild = client.request('setVariable', {
      variablesReference: nestedReference,
      name: 'child',
      value: '[[3, 4]]',
    });
    assert.ok(
      Number((await client.response(replaceNestedChild)).body?.variablesReference) > 0,
    );
    const expiredChildRequest = client.request('variables', {
      variablesReference: oldChildReference,
    });
    assert.strictEqual((await client.response(expiredChildRequest)).success, false);
    const expiredGrandchildRequest = client.request('variables', {
      variablesReference: oldGrandchildReference,
    });
    assert.strictEqual((await client.response(expiredGrandchildRequest)).success, false);

    const failedEvaluate = client.request('evaluate', {
      expression: '(_ for _ in ()).throw(SystemExit("evaluate error"))',
      frameId,
      context: 'repl',
    });
    const failedEvaluateResponse = await client.response(failedEvaluate);
    assert.strictEqual(failedEvaluateResponse.success, false);
    assert.match(String(failedEvaluateResponse.message), /SystemExit/);

    const variablesRequest = client.request('variables', {
      variablesReference: localsReference,
    });
    const variables = (await client.response(variablesRequest)).body?.variables as Array<Record<string, unknown>>;
    assert.strictEqual(
      variables.find((variable) => variable.name === 'total')?.type,
      'int',
    );
    assert.strictEqual(
      variables.find((variable) => variable.name === 'total')?.value,
      '41',
    );
    const hexVariablesRequest = client.request('variables', {
      variablesReference: localsReference,
      format: { hex: true },
    });
    const hexVariables = (await client.response(hexVariablesRequest)).body
      ?.variables as Array<Record<string, unknown>>;
    assert.strictEqual(
      hexVariables.find((variable) => variable.name === 'total')?.value,
      '0x29',
    );
    const hexEvaluate = client.request('evaluate', {
      expression: 'total',
      frameId,
      context: 'watch',
      format: { hex: true },
    });
    assert.strictEqual((await client.response(hexEvaluate)).body?.result, '0x29');
    const negativeHexEvaluate = client.request('evaluate', {
      expression: '-42',
      frameId,
      context: 'watch',
      format: { hex: true },
    });
    assert.strictEqual(
      (await client.response(negativeHexEvaluate)).body?.result,
      '-0x2a',
    );
    const clipboardEvaluate = client.request('evaluate', {
      expression: 'total',
      frameId,
      context: 'clipboard',
    });
    assert.strictEqual((await client.response(clipboardEvaluate)).body?.result, '41');
    const longStringEvaluate = client.request('evaluate', {
      expression: '"x" * 1000',
      frameId,
      context: 'watch',
    });
    assert.ok(
      String((await client.response(longStringEvaluate)).body?.result).length <= 500,
    );
    const longStringClipboard = client.request('evaluate', {
      expression: '"x" * 1000',
      frameId,
      context: 'clipboard',
    });
    assert.strictEqual(
      (await client.response(longStringClipboard)).body?.result,
      `'${'x'.repeat(1000)}'`,
    );
    const payload = variables.find((variable) => variable.name === 'payload');
    assert.ok(payload);
    assert.strictEqual(payload.evaluateName, 'payload');
    const payloadVariablesRequest = client.request('variables', {
      variablesReference: Number(payload.variablesReference),
    });
    const payloadVariables = (await client.response(payloadVariablesRequest)).body
      ?.variables as Array<Record<string, unknown>>;
    assert.strictEqual(
      payloadVariables.find((variable) => variable.name === 'false_checked')?.value,
      "'request-worker'",
    );
    assert.strictEqual(
      payloadVariables.find((variable) => variable.name === 'true_checked')?.value,
      "'request-worker'",
    );
    const payloadItems = payloadVariables.find((variable) => variable.name === 'items');
    assert.strictEqual(typeof payloadItems?.evaluateName, 'string');
    const evaluatePayloadItemsByName = client.request('evaluate', {
      expression: String(payloadItems?.evaluateName),
      frameId,
      context: 'watch',
    });
    assert.strictEqual(
      (await client.response(evaluatePayloadItemsByName)).body?.result,
      '[25, 21]',
    );

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
    assert.strictEqual(dangerous.value, "<DangerousValue state='original'>");
    assert.doesNotMatch(String(dangerous.value), /0x[0-9a-f]+/i);
    const dangerousVariablesRequest = client.request('variables', {
      variablesReference: Number(dangerous.variablesReference),
    });
    const dangerousVariables = (await client.response(dangerousVariablesRequest)).body
      ?.variables as Array<Record<string, unknown>>;
    assert.strictEqual(
      dangerousVariables.find((variable) => variable.name === 'state')?.value,
      "'original'",
    );
    const expectedLazyHint = (kind: 'method' | 'property') => ({
      kind,
      attributes: ['readOnly', 'hasSideEffects'],
      lazy: true,
    });
    const assertLazyRow = (
      rows: Array<Record<string, unknown>>,
      name: string,
      kind: 'method' | 'property',
    ): Record<string, unknown> => {
      const row = rows.find((variable) => variable.name === name);
      assert.ok(row, `missing lazy ${name} row`);
      assert.strictEqual(row.value, '<not evaluated>');
      assert.ok(Number(row.variablesReference) > 0);
      assert.deepStrictEqual(row.presentationHint, expectedLazyHint(kind));
      return row;
    };
    const requestLazyValue = async (
      row: Record<string, unknown>,
    ): Promise<Record<string, unknown>> => {
      const request = client!.request('variables', {
        variablesReference: Number(row.variablesReference),
      });
      const response = await client!.response(request);
      assert.strictEqual(response.success, true);
      const rows = response.body?.variables as Array<Record<string, unknown>>;
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].name, row.name);
      const resultHint = rows[0].presentationHint as Record<string, unknown> | undefined;
      assert.ok(
        resultHint === undefined
          || !Object.prototype.hasOwnProperty.call(resultHint, 'lazy'),
        'resolved lazy value must remove the lazy presentation hint',
      );
      return rows[0];
    };

    const dangerousRepr = assertLazyRow(dangerousVariables, 'repr()', 'method');
    const dangerousStr = assertLazyRow(dangerousVariables, 'str()', 'method');
    assert.strictEqual(
      (await requestLazyValue(dangerousRepr)).value,
      '<evaluation raised RuntimeError>',
    );
    assert.strictEqual(
      (await requestLazyValue(dangerousStr)).value,
      '<evaluation raised RuntimeError>',
    );

    const lazyCalls = variables.find((variable) => variable.name === 'lazy_calls');
    const lazyValue = variables.find((variable) => variable.name === 'lazy_value');
    assert.ok(lazyCalls);
    assert.ok(lazyValue);
    assert.strictEqual(lazyCalls.value, '[]', 'lazy discovery must not execute hooks');
    assert.strictEqual(lazyValue.value, '<LazyValue>');
    assert.strictEqual(lazyValue.evaluateName, 'lazy_value');
    const lazyValueVariablesRequest = client.request('variables', {
      variablesReference: Number(lazyValue.variablesReference),
    });
    const lazyValueVariables = (await client.response(lazyValueVariablesRequest)).body
      ?.variables as Array<Record<string, unknown>>;
    const lazyRepr = assertLazyRow(lazyValueVariables, 'repr()', 'method');
    const lazyStr = assertLazyRow(lazyValueVariables, 'str()', 'method');
    const lazyWorkerName = assertLazyRow(
      lazyValueVariables,
      'worker_name',
      'property',
    );
    const lazyRuntimeError = assertLazyRow(
      lazyValueVariables,
      'runtime_error',
      'property',
    );
    const lazyStructured = assertLazyRow(
      lazyValueVariables,
      'structured',
      'property',
    );
    const lazySystemExit = assertLazyRow(
      lazyValueVariables,
      'system_exit',
      'property',
    );
    const lazySlot = assertLazyRow(lazyValueVariables, 'label', 'property');
    assert.strictEqual(lazyWorkerName.evaluateName, 'lazy_value.worker_name');
    assert.strictEqual(lazySlot.evaluateName, 'lazy_value.label');
    const callsAfterLazyDiscovery = client.request('evaluate', {
      expression: 'lazy_calls',
      frameId,
      context: 'watch',
    });
    assert.strictEqual(
      (await client.response(callsAfterLazyDiscovery)).body?.result,
      '[]',
      'expanding an object must only discover lazy hooks',
    );

    assert.match(String((await requestLazyValue(lazyRepr)).value), /LazyValue\(label='ready'\)/);
    assert.match(String((await requestLazyValue(lazyStr)).value), /lazy:ready/);
    const workerPropertyResult = await requestLazyValue(lazyWorkerName);
    assert.strictEqual(workerPropertyResult.value, "'request-worker'");
    assert.strictEqual(workerPropertyResult.evaluateName, 'lazy_value.worker_name');
    const firstStructuredResult = await requestLazyValue(lazyStructured);
    const firstStructuredReference = Number(firstStructuredResult.variablesReference);
    assert.ok(firstStructuredReference > 0);
    const secondStructuredResult = await requestLazyValue(lazyStructured);
    const secondStructuredReference = Number(secondStructuredResult.variablesReference);
    assert.ok(secondStructuredReference > 0);
    assert.notStrictEqual(secondStructuredReference, firstStructuredReference);
    const staleStructuredRequest = client.request('variables', {
      variablesReference: firstStructuredReference,
    });
    assert.strictEqual(
      (await client.response(staleStructuredRequest)).success,
      false,
    );
    assert.strictEqual(
      (await requestLazyValue(lazyRuntimeError)).value,
      '<evaluation raised RuntimeError>',
    );
    assert.strictEqual(
      (await requestLazyValue(lazySystemExit)).value,
      '<evaluation raised SystemExit>',
    );
    assert.strictEqual((await requestLazyValue(lazySlot)).value, "'ready'");
    const dangerousEvaluate = client.request('evaluate', {
      expression: 'dangerous',
      frameId,
      context: 'repl',
    });
    assert.strictEqual(
      (await client.response(dangerousEvaluate)).body?.result,
      "<DangerousValue state='original'>",
    );

    const failedSet = client.request('setVariable', {
      variablesReference: localsReference,
      name: 'total',
      value: '1 / 0',
    });
    const failedSetResponse = await client.response(failedSet);
    assert.strictEqual(failedSetResponse.success, false);
    assert.match(String(failedSetResponse.message), /ZeroDivisionError/);

    const missingSet = client.request('setVariable', {
      variablesReference: localsReference,
      name: 'new_local',
      value: '1',
    });
    assert.strictEqual((await client.response(missingSet)).success, false);

    const unchangedEvaluate = client.request('evaluate', {
      expression: 'total',
      frameId,
      context: 'repl',
    });
    assert.strictEqual((await client.response(unchangedEvaluate)).body?.result, '41');

    const setTotal = client.request('setVariable', {
      variablesReference: localsReference,
      name: 'total',
      value: '100',
    });
    const setTotalResponse = await client.response(setTotal);
    assert.strictEqual(setTotalResponse.success, true);
    assert.strictEqual(setTotalResponse.body?.value, '100');

    const setPayload = client.request('setVariable', {
      variablesReference: Number(payload.variablesReference),
      name: 'seed',
      value: '30',
    });
    assert.strictEqual((await client.response(setPayload)).body?.value, '30');

    const setAttribute = client.request('setVariable', {
      variablesReference: Number(dangerous.variablesReference),
      name: 'state',
      value: '"changed"',
    });
    assert.strictEqual((await client.response(setAttribute)).body?.value, "'changed'");

    const changedEvaluate = client.request('evaluate', {
      expression: '(total, payload["seed"], dangerous.state)',
      frameId,
      context: 'repl',
    });
    assert.strictEqual(
      (await client.response(changedEvaluate)).body?.result,
      "(100, 30, 'changed')",
    );
    const changedListEvaluate = client.request('evaluate', {
      expression: 'payload["items"]',
      frameId,
      context: 'repl',
    });
    assert.strictEqual(
      (await client.response(changedListEvaluate)).body?.result,
      '[25, 21]',
    );

    const refreshedVariablesRequest = client.request('variables', {
      variablesReference: localsReference,
    });
    const refreshedVariables = (await client.response(refreshedVariablesRequest)).body
      ?.variables as Array<Record<string, unknown>>;
    assert.strictEqual(
      refreshedVariables.find((variable) => variable.name === 'total')?.value,
      '100',
    );

    const next = client.request('next', { threadId });
    assert.strictEqual((await client.response(next)).success, true);
    const stepped = await client.event('stopped');
    assert.strictEqual(stepped.body?.reason, 'step');
    const steppedThreadId = Number(stepped.body?.threadId);
    const steppedStackRequest = client.request('stackTrace', { threadId: steppedThreadId });
    const steppedStack = (await client.response(steppedStackRequest)).body
      ?.stackFrames as Array<Record<string, unknown>>;
    const steppedFrameId = Number(steppedStack[0].id);
    const resultEvaluate = client.request('evaluate', {
      expression: 'result',
      frameId: steppedFrameId,
      context: 'repl',
    });
    assert.strictEqual((await client.response(resultEvaluate)).body?.result, '200');

    const expiredEvaluate = client.request('evaluate', {
      expression: 'total',
      frameId,
      context: 'repl',
    });
    assert.strictEqual((await client.response(expiredEvaluate)).success, false);
    const expiredSet = client.request('setVariable', {
      variablesReference: localsReference,
      name: 'total',
      value: '200',
    });
    assert.strictEqual((await client.response(expiredSet)).success, false);
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
    assert.ok(outputLines.includes('RESULT=200'));
  });

  it('stops on raised and uncaught exceptions and serves safe exception details', async function () {
    this.timeout(40_000);
    const python = await findSystemPython();
    if (!python) {
      this.skip();
      return;
    }

    const fixture = path.join(fixturesDir(), 'native_dap_exception_target.py');
    const source = await fs.readFile(fixture, 'utf8');
    const sourceLines = source.split(/\r?\n/);
    const caughtRaiseLine = sourceLines.findIndex((line) => line.includes('# CAUGHT_RAISE')) + 1;
    const uncaughtRaiseLine = sourceLines.findIndex((line) => line.includes('# UNCAUGHT_RAISE')) + 1;
    const causeInnerRaiseLine = sourceLines
      .findIndex((line) => line.includes('# CAUSE_INNER_RAISE')) + 1;
    const causeOuterRaiseLine = sourceLines
      .findIndex((line) => line.includes('# CAUSE_OUTER_RAISE')) + 1;
    assert.ok(caughtRaiseLine > 0);
    assert.ok(uncaughtRaiseLine > 0);
    assert.ok(causeInnerRaiseLine > 0);
    assert.ok(causeOuterRaiseLine > 0);

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

    let targetErrors = '';
    target.stderr.on('data', (chunk: Buffer) => {
      targetErrors += chunk.toString();
    });
    const outputLines: string[] = [];
    const output = readline.createInterface({ input: target.stdout });
    const info = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Exception target did not publish endpoint')),
        8_000,
      );
      output.once('line', (line) => {
        clearTimeout(timer);
        outputLines.push(line);
        resolve(JSON.parse(line) as Record<string, unknown>);
      });
      target?.once('exit', (code, signal) => {
        clearTimeout(timer);
        reject(new Error(
          `Exception target exited early: code=${code} signal=${signal}`
            + (targetErrors ? ` stderr=${targetErrors.trim()}` : ''),
        ));
      });
    });

    const completedCommands = new Map<
      string,
      Array<{ hooks: number; chain: number }>
    >();
    output.on('line', (line) => {
      outputLines.push(line);
      const match = line.match(/^DONE:([^:]+):HOOKS=(\d+):CHAIN=(\d+)$/);
      if (!match) {
        return;
      }
      const hooks = completedCommands.get(match[1]) ?? [];
      hooks.push({ hooks: Number(match[2]), chain: Number(match[3]) });
      completedCommands.set(match[1], hooks);
    });

    const startCommand = (command: string): (() => Promise<void>) => {
      const expectedCompletion = (completedCommands.get(command)?.length ?? 0) + 1;
      target!.stdin.write(`${command}\n`);
      return async () => {
        const deadline = Date.now() + 8_000;
        while ((completedCommands.get(command)?.length ?? 0) < expectedCompletion) {
          if (target?.exitCode !== null || target?.signalCode) {
            throw new Error(
              `Exception target exited before ${command} completed`
                + (targetErrors ? `: ${targetErrors.trim()}` : ''),
            );
          }
          if (Date.now() >= deadline) {
            throw new Error(
              `Timed out waiting for DONE:${command}; output=${outputLines.join(' | ')}`,
            );
          }
          await sleep(10);
        }
        const completion = completedCommands.get(command)?.[expectedCompletion - 1];
        assert.strictEqual(
          completion?.hooks,
          0,
          `${command} invoked user exception __str__ or __repr__`,
        );
        assert.strictEqual(
          completion?.chain,
          command === 'CAUGHT' ? 0 : 1,
          `${command} did not invoke the original threading.excepthook exactly once`,
        );
      };
    };

    const assertNoStoppedEvent = async (label: string): Promise<void> => {
      await assert.rejects(
        client!.waitFor(
          (message) => message.type === 'event' && message.event === 'stopped',
          200,
        ),
        /Timed out waiting for DAP message/,
        `${label} unexpectedly stopped`,
      );
    };

    const setExceptionFilters = async (filters: string[]): Promise<void> => {
      const request = client!.request('setExceptionBreakpoints', { filters });
      const response = await client!.response(request);
      assert.strictEqual(response.success, true);
      const rows = response.body?.breakpoints as Array<Record<string, unknown>>;
      assert.ok(Array.isArray(rows));
      assert.strictEqual(rows.length, filters.length);
      assert.ok(rows.every((row) => row.verified === true));
    };

    const requestExceptionInfo = async (
      threadId: number,
    ): Promise<DapMessage> => {
      const request = client!.request('exceptionInfo', { threadId });
      return client!.response(request);
    };

    const continueThread = async (threadId: number): Promise<void> => {
      const request = client!.request('continue', { threadId });
      const response = await client!.response(request);
      assert.strictEqual(response.success, true);
    };

    const host = String(info.host);
    const port = Number(info.port);
    client = await RawDapClient.connect(host, port);

    const initialize = client.request('initialize', {
      adapterID: 'django-process',
      supportsVariableType: true,
    });
    const initializeResponse = await client.response(initialize);
    assert.strictEqual(initializeResponse.success, true);
    assert.strictEqual(initializeResponse.body?.supportsExceptionInfoRequest, true);
    const exceptionFilters = initializeResponse.body
      ?.exceptionBreakpointFilters as Array<Record<string, unknown>>;
    assert.deepStrictEqual(
      exceptionFilters.map((filter) => filter.filter),
      ['raised', 'uncaught', 'djangoRequestUnhandled'],
    );
    assert.deepStrictEqual(
      exceptionFilters.map((filter) => filter.default),
      [false, true, false],
    );

    const attach = client.request('attach', {
      request: 'attach',
      [DAP_AUTH_TOKEN_KEY]: String(info.authToken),
    });
    await client.event('initialized');
    await setExceptionFilters([]);
    const configurationDone = client.request('configurationDone');
    assert.strictEqual((await client.response(configurationDone)).success, true);
    assert.strictEqual((await client.response(attach)).success, true);

    const noFilterCaughtDone = startCommand('CAUGHT');
    await noFilterCaughtDone();
    await assertNoStoppedEvent('caught exception with no filters');

    await setExceptionFilters(['raised']);
    const raisedCaughtDone = startCommand('CAUGHT');
    const raisedStop = await client.event('stopped');
    assert.strictEqual(raisedStop.body?.reason, 'exception');
    assert.strictEqual(raisedStop.body?.allThreadsStopped, false);
    assert.strictEqual(
      raisedStop.body?.text,
      'ChildProblem',
      `unexpected raised stop: ${JSON.stringify(raisedStop.body)}`,
    );
    assert.strictEqual(raisedStop.body?.description, 'ChildProblem: caught child');
    const raisedThreadId = Number(raisedStop.body?.threadId);
    assert.ok(raisedThreadId > 0);

    const raisedThreadsRequest = client.request('threads');
    const raisedThreads = (await client.response(raisedThreadsRequest)).body
      ?.threads as Array<Record<string, unknown>>;
    assert.ok(
      raisedThreads.some(
        (thread) => thread.id === raisedThreadId
          && thread.name === 'exception-worker-caught',
      ),
    );

    const raisedStackRequest = client.request('stackTrace', { threadId: raisedThreadId });
    const raisedStack = (await client.response(raisedStackRequest)).body
      ?.stackFrames as Array<Record<string, unknown>>;
    assert.strictEqual(raisedStack[0].line, caughtRaiseLine);
    assert.strictEqual(
      (raisedStack[0].source as Record<string, unknown>).path,
      fixture,
    );
    const raisedFrameId = Number(raisedStack[0].id);
    const raisedThreadEvaluate = client.request('evaluate', {
      expression: 'threading.current_thread().name',
      frameId: raisedFrameId,
      context: 'watch',
    });
    assert.strictEqual(
      (await client.response(raisedThreadEvaluate)).body?.result,
      "'exception-worker-caught'",
    );

    const raisedInfo = await requestExceptionInfo(raisedThreadId);
    assert.strictEqual(raisedInfo.success, true);
    assert.match(String(raisedInfo.body?.exceptionId), /ChildProblem$/);
    assert.strictEqual(raisedInfo.body?.description, 'ChildProblem: caught child');
    assert.strictEqual(raisedInfo.body?.breakMode, 'always');
    const raisedDetails = asRecord(raisedInfo.body?.details);
    assert.strictEqual(raisedDetails.message, 'caught child');
    assert.strictEqual(raisedDetails.typeName, 'ChildProblem');
    assert.match(String(raisedDetails.fullTypeName), /ChildProblem$/);
    assert.match(String(raisedDetails.stackTrace), new RegExp(`line ${caughtRaiseLine}(?:,|$)`));
    assert.match(String(raisedDetails.stackTrace), /in run_one/);

    // Replacing filters affects future exceptions, not the active stop's
    // immutable exceptionInfo snapshot.
    await setExceptionFilters(['uncaught']);
    const preservedRaisedInfo = await requestExceptionInfo(raisedThreadId);
    assert.strictEqual(preservedRaisedInfo.success, true);
    assert.strictEqual(preservedRaisedInfo.body?.breakMode, 'always');

    await continueThread(raisedThreadId);
    const staleRaisedInfo = await requestExceptionInfo(raisedThreadId);
    assert.strictEqual(staleRaisedInfo.success, false);
    assert.match(String(staleRaisedInfo.message), /not stopped on an exception/i);
    await raisedCaughtDone();
    await assertNoStoppedEvent('resumed caught exception propagation');

    const replacedCaughtDone = startCommand('CAUGHT');
    await replacedCaughtDone();
    await assertNoStoppedEvent('caught exception with uncaught filter');

    // Raised and uncaught are distinct first/second-chance phases. Switching
    // filters while the first stop is active must not suppress the later
    // post-mortem stop for the same exception object.
    await setExceptionFilters(['raised']);
    const uncaughtDone = startCommand('UNCAUGHT');
    const firstChanceUncaught = await client.event('stopped');
    assert.strictEqual(firstChanceUncaught.body?.reason, 'exception');
    assert.strictEqual(firstChanceUncaught.body?.text, 'ChildProblem');
    const firstChanceThreadId = Number(firstChanceUncaught.body?.threadId);
    const firstChanceInfo = await requestExceptionInfo(firstChanceThreadId);
    assert.strictEqual(firstChanceInfo.success, true);
    assert.strictEqual(firstChanceInfo.body?.breakMode, 'always');
    await setExceptionFilters(['uncaught']);
    await continueThread(firstChanceThreadId);

    const uncaughtStop = await client.event('stopped');
    assert.strictEqual(uncaughtStop.body?.reason, 'exception');
    assert.strictEqual(uncaughtStop.body?.text, 'ChildProblem');
    assert.strictEqual(uncaughtStop.body?.description, 'ChildProblem: uncaught child');
    const uncaughtThreadId = Number(uncaughtStop.body?.threadId);
    assert.ok(uncaughtThreadId > 0);
    assert.strictEqual(uncaughtThreadId, firstChanceThreadId);
    const uncaughtStackRequest = client.request('stackTrace', { threadId: uncaughtThreadId });
    const uncaughtStack = (await client.response(uncaughtStackRequest)).body
      ?.stackFrames as Array<Record<string, unknown>>;
    assert.strictEqual(uncaughtStack[0].line, uncaughtRaiseLine);
    assert.strictEqual(uncaughtStack[0].name, 'uncaught_exception');
    const uncaughtFrameId = Number(uncaughtStack[0].id);

    const uncaughtInfo = await requestExceptionInfo(uncaughtThreadId);
    assert.strictEqual(uncaughtInfo.success, true);
    assert.strictEqual(uncaughtInfo.body?.breakMode, 'unhandled');
    const uncaughtDetails = asRecord(uncaughtInfo.body?.details);
    assert.strictEqual(uncaughtDetails.message, 'uncaught child');
    assert.strictEqual(uncaughtDetails.typeName, 'ChildProblem');
    assert.match(
      String(uncaughtDetails.stackTrace),
      new RegExp(`line ${uncaughtRaiseLine}(?:,|$)`),
    );

    const postmortemScopesRequest = client.request('scopes', { frameId: uncaughtFrameId });
    const postmortemScopesResponse = await client.response(postmortemScopesRequest);
    assert.strictEqual(postmortemScopesResponse.success, true);
    const postmortemScopes = postmortemScopesResponse.body
      ?.scopes as Array<Record<string, unknown>>;
    const postmortemLocals = postmortemScopes.find(
      (scope) => scope.presentationHint === 'locals',
    );
    assert.ok(postmortemLocals);
    await setExceptionFilters(['raised', 'uncaught']);
    const postmortemEvaluate = client.request('evaluate', {
      expression: 'postmortem_value + 1',
      frameId: uncaughtFrameId,
      context: 'watch',
    });
    assert.strictEqual((await client.response(postmortemEvaluate)).body?.result, '8');
    const failedPostmortemEvaluate = client.request('evaluate', {
      expression: '(_ for _ in ()).throw(RuntimeError("postmortem evaluate"))',
      frameId: uncaughtFrameId,
      context: 'watch',
    });
    const failedPostmortemResponse = await client.response(failedPostmortemEvaluate);
    assert.strictEqual(failedPostmortemResponse.success, false);
    assert.match(String(failedPostmortemResponse.message), /RuntimeError/);
    assert.strictEqual((await requestExceptionInfo(uncaughtThreadId)).success, true);
    await setExceptionFilters(['uncaught']);
    const postmortemSet = client.request('setVariable', {
      variablesReference: Number(postmortemLocals.variablesReference),
      name: 'postmortem_value',
      value: '9',
    });
    assert.strictEqual((await client.response(postmortemSet)).success, false);
    for (const stepCommand of ['next', 'stepIn', 'stepOut']) {
      const postmortemStep = client.request(stepCommand, {
        threadId: uncaughtThreadId,
      });
      assert.strictEqual((await client.response(postmortemStep)).success, false);
    }
    assert.strictEqual((await requestExceptionInfo(uncaughtThreadId)).success, true);

    await continueThread(uncaughtThreadId);
    await uncaughtDone();
    await assertNoStoppedEvent('uncaught exception propagation');

    const causeDone = startCommand('CAUSE');
    const causeStop = await client.event('stopped');
    assert.strictEqual(causeStop.body?.reason, 'exception');
    assert.strictEqual(causeStop.body?.text, 'OuterProblem');
    const causeThreadId = Number(causeStop.body?.threadId);
    const causeStackRequest = client.request('stackTrace', { threadId: causeThreadId });
    const causeStack = (await client.response(causeStackRequest)).body
      ?.stackFrames as Array<Record<string, unknown>>;
    assert.strictEqual(causeStack[0].line, causeOuterRaiseLine);
    const causeInfo = await requestExceptionInfo(causeThreadId);
    assert.strictEqual(causeInfo.success, true);
    assert.strictEqual(causeInfo.body?.breakMode, 'unhandled');
    const causeDetails = asRecord(causeInfo.body?.details);
    assert.strictEqual(causeDetails.message, 'outer problem');
    assert.strictEqual(causeDetails.typeName, 'OuterProblem');
    assert.match(
      String(causeDetails.stackTrace),
      new RegExp(`line ${causeOuterRaiseLine}(?:,|$)`),
    );
    const innerExceptions = causeDetails.innerException as Array<Record<string, unknown>>;
    assert.strictEqual(innerExceptions.length, 1);
    assert.strictEqual(innerExceptions[0].message, 'root cause');
    assert.strictEqual(innerExceptions[0].typeName, 'ValueError');
    assert.match(
      String(innerExceptions[0].stackTrace),
      new RegExp(`line ${causeInnerRaiseLine}(?:,|$)`),
    );
    await continueThread(causeThreadId);
    await causeDone();
    await assertNoStoppedEvent('explicitly chained exception propagation');

    await setExceptionFilters([]);
    const clearedUncaughtDone = startCommand('UNCAUGHT');
    await clearedUncaughtDone();
    await assertNoStoppedEvent('uncaught exception after clearing filters');

    const disconnect = client.request('disconnect', { terminateDebuggee: false });
    assert.strictEqual((await client.response(disconnect)).success, true);
    const targetExit = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Exception target did not exit after QUIT')),
        8_000,
      );
      target?.once('exit', (code, signal) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(
            `Exception target exit: code=${code} signal=${signal}`
              + (targetErrors ? ` stderr=${targetErrors.trim()}` : ''),
          ));
        }
      });
    });
    target.stdin.write('QUIT\n');
    await targetExit;
  });

  it('stops at the Django request exception boundary without a Django dependency', async function () {
    this.timeout(40_000);
    const python = await findSystemPython();
    if (!python) {
      this.skip();
      return;
    }

    const fixture = path.join(
      fixturesDir(),
      'native_dap_django_exception_target.py',
    );
    const source = await fs.readFile(fixture, 'utf8');
    const sourceLines = source.split(/\r?\n/);
    const syncRaiseLine = sourceLines
      .findIndex((line) => line.includes('# SYNC_RAISE')) + 1;
    const fallbackRaiseLine = sourceLines
      .findIndex((line) => line.includes('# FALLBACK_RAISE')) + 1;
    const asgiOriginRaiseLine = sourceLines
      .findIndex((line) => line.includes('# ASGI_ORIGIN_RAISE')) + 1;
    const asgiWorkerReraiseLine = sourceLines
      .findIndex((line) => line.includes('# ASGI_WORKER_RERAISE')) + 1;
    assert.ok(syncRaiseLine > 0);
    assert.ok(fallbackRaiseLine > 0);
    assert.ok(asgiOriginRaiseLine > 0);
    assert.ok(asgiWorkerReraiseLine > 0);

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

    let targetErrors = '';
    target.stderr.on('data', (chunk: Buffer) => {
      targetErrors += chunk.toString();
    });
    const outputLines: string[] = [];
    const output = readline.createInterface({ input: target.stdout });
    const info = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Django exception target did not publish endpoint')),
        8_000,
      );
      output.once('line', (line) => {
        clearTimeout(timer);
        outputLines.push(line);
        resolve(JSON.parse(line) as Record<string, unknown>);
      });
      target?.once('exit', (code, signal) => {
        clearTimeout(timer);
        reject(new Error(
          `Django exception target exited early: code=${code} signal=${signal}`
            + (targetErrors ? ` stderr=${targetErrors.trim()}` : ''),
        ));
      });
    });

    const completedCommands = new Map<string, Array<{ hooks: number }>>();
    output.on('line', (line) => {
      outputLines.push(line);
      const match = line.match(/^DONE:([^:]+):HOOKS=(\d+)$/);
      if (!match) {
        return;
      }
      const completions = completedCommands.get(match[1]) ?? [];
      completions.push({ hooks: Number(match[2]) });
      completedCommands.set(match[1], completions);
    });

    const startCommand = (command: string): (() => Promise<void>) => {
      const expectedCompletion = (completedCommands.get(command)?.length ?? 0) + 1;
      target!.stdin.write(`${command}\n`);
      return async () => {
        const deadline = Date.now() + 8_000;
        while ((completedCommands.get(command)?.length ?? 0) < expectedCompletion) {
          if (target?.exitCode !== null || target?.signalCode) {
            throw new Error(
              `Django exception target exited before ${command} completed`
                + (targetErrors ? `: ${targetErrors.trim()}` : ''),
            );
          }
          if (Date.now() >= deadline) {
            throw new Error(
              `Timed out waiting for DONE:${command}; output=${outputLines.join(' | ')}`,
            );
          }
          await sleep(10);
        }
        const completion = completedCommands.get(command)?.[expectedCompletion - 1];
        assert.strictEqual(
          completion?.hooks,
          0,
          `${command} invoked application __str__ or __repr__`,
        );
      };
    };

    const assertNoStoppedEvent = async (label: string): Promise<void> => {
      await assert.rejects(
        client!.waitFor(
          (message) => message.type === 'event' && message.event === 'stopped',
          250,
        ),
        /Timed out waiting for DAP message/,
        `${label} unexpectedly stopped`,
      );
    };

    const setExceptionFilters = async (filters: string[]): Promise<void> => {
      const request = client!.request('setExceptionBreakpoints', { filters });
      const response = await client!.response(request);
      assert.strictEqual(response.success, true);
      const rows = response.body?.breakpoints as Array<Record<string, unknown>>;
      assert.ok(Array.isArray(rows));
      assert.strictEqual(rows.length, filters.length);
      assert.ok(rows.every((row) => row.verified === true));
    };

    const requestExceptionInfo = async (threadId: number): Promise<DapMessage> => {
      const request = client!.request('exceptionInfo', { threadId });
      return client!.response(request);
    };

    const continueThread = async (threadId: number): Promise<void> => {
      const request = client!.request('continue', { threadId });
      assert.strictEqual((await client!.response(request)).success, true);
    };

    const requestStack = async (
      threadId: number,
    ): Promise<Array<Record<string, unknown>>> => {
      const request = client!.request('stackTrace', { threadId });
      const response = await client!.response(request);
      assert.strictEqual(response.success, true);
      const frames = response.body?.stackFrames as Array<Record<string, unknown>>;
      assert.ok(frames.length > 0);
      return frames;
    };

    const requestTopFrame = async (
      threadId: number,
      expectedLine: number,
    ): Promise<Record<string, unknown>> => {
      const frames = await requestStack(threadId);
      assert.strictEqual(frames[0].line, expectedLine);
      assert.strictEqual(asRecord(frames[0].source).path, fixture);
      return frames[0];
    };

    const assertDjangoRequestScope = async (
      frameId: number,
      expected: { method: string; path: string; pathInfo: string },
    ): Promise<Record<string, unknown>> => {
      const scopesRequest = client!.request('scopes', { frameId });
      const scopesResponse = await client!.response(scopesRequest);
      assert.strictEqual(scopesResponse.success, true);
      const scopes = scopesResponse.body?.scopes as Array<Record<string, unknown>>;
      const djangoRequest = scopes.find((scope) => scope.name === 'Django Request');
      assert.ok(djangoRequest, 'Django exception stop must expose a request scope');
      assert.strictEqual(djangoRequest.expensive, false);
      const variablesRequest = client!.request('variables', {
        variablesReference: Number(djangoRequest.variablesReference),
      });
      const variablesResponse = await client!.response(variablesRequest);
      assert.strictEqual(variablesResponse.success, true);
      const variables = variablesResponse.body
        ?.variables as Array<Record<string, unknown>>;
      const values = new Map(variables.map((variable) => [
        String(variable.name),
        String(variable.value),
      ]));
      const requestVariable = variables.find(
        (variable) => variable.name === 'request',
      );
      assert.strictEqual(requestVariable?.value, '<FakeRequest>');
      assert.ok(Number(requestVariable?.variablesReference) > 0);
      assert.strictEqual(values.get('method'), `'${expected.method}'`);
      assert.strictEqual(values.get('path'), `'${expected.path}'`);
      assert.strictEqual(values.get('path_info'), `'${expected.pathInfo}'`);
      return scopes.find((scope) => scope.presentationHint === 'locals')!;
    };

    client = await RawDapClient.connect(String(info.host), Number(info.port));
    const initialize = client.request('initialize', {
      adapterID: 'django-process',
      supportsVariableType: true,
    });
    const initializeResponse = await client.response(initialize);
    assert.strictEqual(initializeResponse.success, true);
    assert.strictEqual(initializeResponse.body?.supportsExceptionInfoRequest, true);
    const exceptionFilters = initializeResponse.body
      ?.exceptionBreakpointFilters as Array<Record<string, unknown>>;
    assert.deepStrictEqual(
      exceptionFilters.map((filter) => filter.filter),
      ['raised', 'uncaught', 'djangoRequestUnhandled'],
    );
    const djangoFilter = exceptionFilters.find(
      (filter) => filter.filter === 'djangoRequestUnhandled',
    );
    assert.strictEqual(djangoFilter?.label, 'Django Request Exceptions');
    assert.strictEqual(djangoFilter?.default, false);

    const attach = client.request('attach', {
      request: 'attach',
      [DAP_AUTH_TOKEN_KEY]: String(info.authToken),
    });
    await client.event('initialized');
    await setExceptionFilters([]);
    const configurationDone = client.request('configurationDone');
    assert.strictEqual((await client.response(configurationDone)).success, true);
    assert.strictEqual((await client.response(attach)).success, true);

    // Clearing every filter must leave the fake Django signal completely
    // transparent, including its application exception text hooks.
    const unfilteredDone = startCommand('SYNC');
    await unfilteredDone();
    await assertNoStoppedEvent('Django request exception with no filters');

    // Calling response_for_exception outside an active except block exercises
    // the exact handler-local ``exc`` fallback used by the integration.
    await setExceptionFilters(['djangoRequestUnhandled']);
    const fallbackDone = startCommand('FALLBACK');
    const fallbackStop = await client.event('stopped');
    assert.strictEqual(fallbackStop.body?.reason, 'exception');
    assert.strictEqual(fallbackStop.body?.allThreadsStopped, false);
    assert.strictEqual(fallbackStop.body?.text, 'RequestProblem');
    assert.strictEqual(
      fallbackStop.body?.description,
      'RequestProblem: fallback request problem',
    );
    const fallbackThreadId = Number(fallbackStop.body?.threadId);
    assert.ok(fallbackThreadId > 0);
    const fallbackFrame = await requestTopFrame(fallbackThreadId, fallbackRaiseLine);
    const fallbackFrameId = Number(fallbackFrame.id);

    const fallbackInfo = await requestExceptionInfo(fallbackThreadId);
    assert.strictEqual(fallbackInfo.success, true);
    assert.strictEqual(fallbackInfo.body?.breakMode, 'userUnhandled');
    assert.match(String(fallbackInfo.body?.exceptionId), /RequestProblem$/);
    const fallbackDetails = asRecord(fallbackInfo.body?.details);
    assert.strictEqual(fallbackDetails.message, 'fallback request problem');
    assert.strictEqual(fallbackDetails.typeName, 'RequestProblem');
    assert.match(
      String(fallbackDetails.stackTrace),
      new RegExp(`line ${fallbackRaiseLine}(?:,|$)`),
    );
    const fallbackLocals = await assertDjangoRequestScope(fallbackFrameId, {
      method: 'GET',
      path: '/app/fallback/',
      pathInfo: '/fallback/',
    });
    const fallbackEvaluate = client.request('evaluate', {
      expression: 'fallback_value + 1',
      frameId: fallbackFrameId,
      context: 'watch',
    });
    assert.strictEqual((await client.response(fallbackEvaluate)).body?.result, '10');
    const fallbackSet = client.request('setVariable', {
      variablesReference: Number(fallbackLocals.variablesReference),
      name: 'fallback_value',
      value: '10',
    });
    assert.strictEqual((await client.response(fallbackSet)).success, false);
    for (const stepCommand of ['next', 'stepIn', 'stepOut']) {
      const step = client.request(stepCommand, { threadId: fallbackThreadId });
      assert.strictEqual((await client.response(step)).success, false);
    }
    assert.strictEqual((await requestExceptionInfo(fallbackThreadId)).success, true);
    await continueThread(fallbackThreadId);
    const staleFallbackInfo = await requestExceptionInfo(fallbackThreadId);
    assert.strictEqual(staleFallbackInfo.success, false);
    await fallbackDone();
    await assertNoStoppedEvent('resumed handler-local Django exception');

    // The same exception is allowed to stop once at its raised phase and once
    // at Django's request boundary. The active sys.exc_info() path also keeps
    // the original application traceback and frame available for evaluation.
    await setExceptionFilters(['raised', 'djangoRequestUnhandled']);
    const syncDone = startCommand('SYNC');
    const raisedStop = await client.event('stopped');
    assert.strictEqual(raisedStop.body?.reason, 'exception');
    assert.strictEqual(raisedStop.body?.text, 'RequestProblem');
    const raisedThreadId = Number(raisedStop.body?.threadId);
    await requestTopFrame(raisedThreadId, syncRaiseLine);
    const raisedInfo = await requestExceptionInfo(raisedThreadId);
    assert.strictEqual(raisedInfo.success, true);
    assert.strictEqual(raisedInfo.body?.breakMode, 'always');
    await continueThread(raisedThreadId);

    const djangoStop = await client.event('stopped');
    assert.strictEqual(djangoStop.body?.reason, 'exception');
    assert.strictEqual(djangoStop.body?.text, 'RequestProblem');
    assert.strictEqual(djangoStop.body?.description, 'RequestProblem: sync request problem');
    const djangoThreadId = Number(djangoStop.body?.threadId);
    assert.strictEqual(djangoThreadId, raisedThreadId);
    const djangoFrame = await requestTopFrame(djangoThreadId, syncRaiseLine);
    const djangoInfo = await requestExceptionInfo(djangoThreadId);
    assert.strictEqual(djangoInfo.success, true);
    assert.strictEqual(djangoInfo.body?.breakMode, 'userUnhandled');
    const djangoFrameId = Number(djangoFrame.id);
    await assertDjangoRequestScope(djangoFrameId, {
      method: 'POST',
      path: '/shop/orders/42/',
      pathInfo: '/orders/42/',
    });
    const syncEvaluate = client.request('evaluate', {
      expression: 'route_value + 1',
      frameId: djangoFrameId,
      context: 'watch',
    });
    assert.strictEqual((await client.response(syncEvaluate)).body?.result, '42');
    await continueThread(djangoThreadId);
    await syncDone();
    await assertNoStoppedEvent('resumed raised-to-Django exception phases');

    // ASGI adapters can preserve an exception across a thread boundary and
    // explicitly re-raise the same object in a worker. Raised is the single
    // first-chance phase; Django's boundary is the one user-unhandled phase.
    const asgiDone = startCommand('ASGI');
    const asgiRaisedStop = await client.event('stopped');
    assert.strictEqual(asgiRaisedStop.body?.reason, 'exception');
    assert.strictEqual(asgiRaisedStop.body?.text, 'RequestProblem');
    const asgiRaisedThreadId = Number(asgiRaisedStop.body?.threadId);
    await requestTopFrame(asgiRaisedThreadId, asgiOriginRaiseLine);
    const asgiRaisedInfo = await requestExceptionInfo(asgiRaisedThreadId);
    assert.strictEqual(asgiRaisedInfo.success, true);
    assert.strictEqual(asgiRaisedInfo.body?.breakMode, 'always');
    await continueThread(asgiRaisedThreadId);

    const asgiDjangoStop = await client.event('stopped');
    assert.strictEqual(asgiDjangoStop.body?.reason, 'exception');
    assert.strictEqual(asgiDjangoStop.body?.text, 'RequestProblem');
    assert.strictEqual(
      asgiDjangoStop.body?.description,
      'RequestProblem: asgi request problem',
    );
    const asgiDjangoThreadId = Number(asgiDjangoStop.body?.threadId);
    assert.notStrictEqual(asgiDjangoThreadId, asgiRaisedThreadId);
    const asgiInfo = await requestExceptionInfo(asgiDjangoThreadId);
    assert.strictEqual(asgiInfo.success, true);
    assert.strictEqual(asgiInfo.body?.breakMode, 'userUnhandled');
    const asgiDetails = asRecord(asgiInfo.body?.details);
    assert.match(
      String(asgiDetails.stackTrace),
      new RegExp(`line ${asgiOriginRaiseLine}(?:,|$)`),
    );
    assert.match(
      String(asgiDetails.stackTrace),
      new RegExp(`line ${asgiWorkerReraiseLine}(?:,|$)`),
    );
    const asgiStack = await requestStack(asgiDjangoThreadId);
    assert.strictEqual(asgiStack[0].line, asgiOriginRaiseLine);
    assert.strictEqual(asgiStack[0].name, 'asgi_like_cross_thread_exception');
    const asgiWorkerFrame = asgiStack.find(
      (frame) => frame.name === 'run_asgi_boundary',
    );
    assert.ok(asgiWorkerFrame, 'historical stack must preserve the ASGI worker frame');
    assert.strictEqual(asgiWorkerFrame.line, asgiWorkerReraiseLine);
    await assertDjangoRequestScope(Number(asgiStack[0].id), {
      method: 'PATCH',
      path: '/asgi/orders/42/',
      pathInfo: '/orders/42/',
    });
    await continueThread(asgiDjangoThreadId);
    await asgiDone();
    await assertNoStoppedEvent('resumed cross-thread ASGI exception phases');

    await setExceptionFilters([]);
    const clearedDone = startCommand('FALLBACK');
    await clearedDone();
    await assertNoStoppedEvent('Django request exception after clearing filters');

    const disconnect = client.request('disconnect', { terminateDebuggee: false });
    assert.strictEqual((await client.response(disconnect)).success, true);
    const targetExit = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Django exception target did not exit after QUIT')),
        8_000,
      );
      target?.once('exit', (code, signal) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(
            `Django exception target exit: code=${code} signal=${signal}`
              + (targetErrors ? ` stderr=${targetErrors.trim()}` : ''),
          ));
        }
      });
    });
    target.stdin.write('QUIT\n');
    await targetExit;
  });
});
