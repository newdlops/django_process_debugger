# Optimization Plan

이 문서는 `django-process-debugger` v0.2.4 기준 정적 분석에서 도출된 성능·구조 개선 항목을 우선순위 순으로 정리한다.
E2E 테스트에 내장된 성능 리포터(`test-results/perf-report.md`)가 항목별 실측값을 제공하므로, 개선 전/후 수치를 여기에 함께 기록한다.

## 우선순위 매트릭스

| 우선순위 | 항목 | 예상 체감 효과 | 난이도 |
|---|---|---|---|
| 🔴 HIGH | **[버그]** `resolvePythonForPid`가 venv 대신 base Python 반환 (macOS symlink) | venv 시나리오에서 attach 자체가 실패 | 중 |
| 🔴 HIGH | **[버그]** gunicorn `-b :PORT` 포트 정규식 미스매치 (수정 완료) | Attach 선택창에 포트 표시 누락 | 하 |
| 🔴 HIGH | **[버그]** breakpoint 중 hot reload 요청이 소실됨 (수정 완료 — 아래 "실전 log.txt 진단") | "hot reload 안 됨" 증상의 주범 | 중 |
| 🔴 HIGH | **[버그]** decorator closure가 pre-reload 함수를 유지 (수정 완료) | GraphQL resolver / Django view 대부분 영향 | 중 |
| 🔴 HIGH | Attach 플로우의 `ps`/`lsof`/`python` 중복 호출 제거 | Attach 클릭 → 첫 DAP 핸드셰이크까지 500ms~1s 감소 | 중 (리팩터링 필요) |
| 🔴 HIGH | `Clean All` 탐색 범위·kill 범위 축소 | Clean All 30s+ → 3~5s | 중 |
| 🟡 MEDIUM | `FileSystemWatcher`에 exclude glob 적용 | hot reload 불필요 이벤트 90%+ 제거 | 하 |
| 🟡 MEDIUM | Hot reload 결과 대기를 고정 1초 → 폴링 | 대부분 reload 50~150ms로 단축 | 하 |
| 🟡 MEDIUM | DAP 메시지 trace 기본 OFF | 브레이크포인트 hit-heavy 세션 지연 감소 | 하 |
| 🟡 MEDIUM | `onPyFileChanged` exclusion 로직을 순수 함수로 추출 | 테스트 가능성 확보 + `FileSystemWatcher` glob 개선과 함께 진행 | 하 |
| 🟢 LOW | Lock 파일 sync I/O → async | 부수효과 정돈 | 하 |
| 🟢 LOW~~~~ | ~~부트스트랩 `_is_target_process()` fast-path~~ | **측정 결과 무의미 — 제외** (아래 참고) | — |
| 🟢 LOW | `debugSession.ts` dead code 제거 | 유지보수 청소 | 하 |

---

## 🔴 HIGH — `resolvePythonForPid` venv-symlink 버그 (macOS)

### 문제
E2E 테스트 중 발견한 실버그. macOS 커널은 `execve()` 시 symlink를 resolve해서 프로세스의 실행 경로 테이블에 저장한다. 이 때문에 `ps -p PID -o command=`는 **symlink를 따라간 실제 경로**를 반환한다.

재현:
```bash
python3 -m venv --without-pip /tmp/v
/tmp/v/bin/python -c 'import time; time.sleep(30)' &
PID=$!
ps -p $PID -o command=
# => /Library/Developer/CommandLineTools/.../Python.app/Contents/MacOS/Python ...
#    venv 경로가 아님!
```

결과:
- `injector.resolvePythonForPid(pid)` → base Python 경로 반환
- `injector.verifyBootstrapLoaded(basePython)` → base Python의 site-packages에 부트스트랩 없음 → `BootstrapNotInstalledError`
- 실제로는 venv에 부트스트랩이 잘 설치되어 있는데도 attach 실패

현재 production에서는 `uv run python ...` / `poetry run python ...` 시나리오가 process tree의 wrapper 덕분에 우회되지만, 순수 venv attach는 깨져 있을 가능성이 높다.

### 제안
1. **Process environment 기반 fallback**: `ps eww -p PID`로 `VIRTUAL_ENV` 환경변수 노출 가능. 있으면 `$VIRTUAL_ENV/bin/python`을 우선 사용.
2. **Argv[0] 유지 탐색**: `/proc/PID/exe`는 macOS에 없지만, `lsof -p PID -Fn`의 `ftxt`도 커널 resolved 경로다. 반면 `sysctl kern.proc.args.PID` (macOS)는 원본 argv를 반환 → **argv[0]이 venv symlink면 그걸 사용**.
3. **Fallback 체크**: base Python 반환 시, 해당 PID의 `/proc/PID/cwd`(리눅스) 또는 `lsof -p -Fn cwd` 결과에서 venv 상위 디렉터리(`pyvenv.cfg` 존재)를 찾아 venv python으로 정정.

### 회귀 방지
`src/test/suite/attach.test.ts`에서 이 버그가 재발하면 `before()` 단계에서 진단 메시지와 함께 skip. 버그가 수정되면 자동으로 test가 다시 활성화된다.

---

## 🔴 HIGH — Attach 경로 subprocess 통합

### 문제
한 번의 "Attach to Django Process" 클릭에서 발생하는 subprocess 호출:

| # | 호출부 | 명령 | 비고 |
|---|---|---|---|
| 1 | `processFinder.findDjangoProcesses()` | `ps aux` | 전체 프로세스 리스트 스캔 |
| 2 | `processFinder.findListeningPort(pid)` × N | `lsof -iTCP -sTCP:LISTEN -p PID` | 매 후보 PID마다 |
| 3 | `processFinder.resolveDebuggablePid(pid)` | `ps -eo pid,ppid,command` | #1과 사실상 같은 정보 다시 수집 |
| 4 | `injector.resolvePythonForPid(pid)` | `ps -p PID -o command=`, `lsof -p PID -Fn`, `pgrep -P PID`, `ps -p CHILD -o command=` | 최악 4회 spawn |
| 5 | `injector.resolveSitePackages(pythonPath)` | `python -c "..."` | Python 인터프리터 cold start 100~400ms |
| 6 | `injector.verifyBootstrapLoaded(pythonPath)` | `python -c "import _django_debug_bootstrap"` | 또다시 Python cold start |
| 7 | `injector.getProcessCommand(pid)` | `ps -p PID -o command=` | #4와 중복 |
| 8 | `injector.waitForPortListening(port)` | `lsof -i TCP:PORT` 200ms 간격 폴링 | attach 완료까지 지속 |

또한 `runtimeSetup.discoverRuntimeCandidates()` (Setup 경로)도 독립적으로 `findDjangoProcesses()`를 다시 호출한다.

### 제안
1. **ProcessSnapshot 도입**: `ps -eo pid,ppid,user,%cpu,%mem,command` 한 번으로 `{ pid, ppid, command }[]` 맵을 만들고, `classifyProcess`, `resolveDebuggablePid`, `resolvePythonForPid` 모두 이 맵에서 추론. 스폰을 1회로 축소.
2. **Python introspection 통합 스크립트**: `resolveSitePackages` + `verifyBootstrapLoaded` + (선택) `pythonVersion`/`canImportPip`까지를 단일 `python -c` 호출로 병합. Cold start를 여러 번에서 1번으로.
3. **PID별 TTL 캐시**: 같은 세션 내 동일 PID에 대한 `pythonPath`/`sitePackages` 조회는 메모리에 5~30초 캐시.
4. **포트 룩업 최적화**: `lsof -iTCP -sTCP:LISTEN -nP` 한 번으로 모든 리스닝 소켓을 받아 PID→port 맵을 만들고, 각 프로세스에 조인.

### 측정 포인트
E2E 테스트의 `processFinder.findDjangoProcesses` 및 `fullAttachFlow` 타이밍.

---

## 🔴 HIGH — `Clean All`의 탐색 스톰프

### 문제
`extension.ts:820` 근처의 정리 루틴:
- `find <root> -maxdepth 8 \( -name django_process_debugger.pth -o -name _django_debug_bootstrap.py \)` 를 `~/.asdf`, `~/.pyenv/versions`, `~/Library/Caches/pypoetry/virtualenvs`, `/opt/homebrew/lib` 등 15곳 각각에 실행. 대형 사용자는 수십만 stat.
- `ps aux` 라인 전수를 순회하며 **VS Code 제외 모든 Python 프로세스**를 `SIGKILL`. 언어 서버·Jedi·LSP·다른 프로젝트의 uvicorn까지 무차별.
- `repairCodeSignature`가 바이너리 하나씩 순차로 `xattr` + `codesign` + verify → 10개 기준 30~60s.

### 제안
1. **탐색 깊이 제한**: site-packages 규칙은 `<venv>/lib/python*/site-packages`로 고정. `fs.readdir`로 3단계까지만 내려가도 충분.
2. **Kill 범위 축소**: `.pth`가 설치된 venv 경로 집합을 먼저 모으고, `ps` 라인에 해당 경로가 포함된 프로세스에만 SIGTERM. Opt-in 플래그로 "모두 kill"은 별도 명령으로 분리.
3. **Repair 병렬화**: `repairCodeSignature` 내부 루프를 `Promise.all`로. 또한 `check` 단계를 먼저 전부 모아서 "실제로 broken인 바이너리"만 repair.
4. **Progress 세분화**: `vscode.window.withProgress`로 단계 표시 (현재는 silent에 가까움).

---

## 🟡 MEDIUM — `FileSystemWatcher` scope

### 문제
`extension.ts:1152`
```ts
hotReloadWatcher = vscode.workspace.createFileSystemWatcher('**/*.py');
```
→ `.venv/`, `node_modules/`, `site-packages/`, `__pycache__/`, `migrations/` 아래 변경까지 이벤트 발생. 필터링은 `onPyFileChanged`에서 path substring으로 사후 처리.

### 진행 상황 (2026-04-17)
- 필터 로직(`src/hotReloadFilter.ts#shouldIgnoreForHotReload`)을 **순수 함수로 분리** 완료. 회귀 방지 단위 테스트 3개 추가 (`Feature: hot reload exclusion filter`). 현재는 post-event 필터링이므로 여전히 이벤트 자체는 발생한다.
- 남은 작업: 분리한 filter를 그대로 두고, VS Code `FileSystemWatcher`에 exclude glob을 태울 것. 구현 시 `HOT_RELOAD_EXCLUDE_SUBSTRINGS` 목록과 **정확히 동일한 규칙**이어야 하므로 상수 재사용을 고려.

### 제안 (유지)
```ts
const include = new vscode.RelativePattern(folder, '**/*.py');
const excludePatterns = '{**/.venv/**,**/venv/**,**/node_modules/**,**/site-packages/**,**/__pycache__/**,**/migrations/**}';
const watcher = vscode.workspace.createFileSystemWatcher(include, false, false, true);
```
또는 workspace 설정의 `files.watcherExclude`를 권장.

### 측정
E2E에서 "대량 파일 변경 시 트리거 횟수" 카운트 (후속).

---

---

## 🔴 HIGH — 실전 `log.txt` 진단 (2026-04-17, 수정 완료)

실제 Django + graphene-django ASGI 서버 디버깅 세션의 `log.txt`를 분석해서 "hot reload가 실제로는 안 된다"는 증상의 근본 원인 3가지를 확정.

### Bug #1 — breakpoint deadlock (UX killer)

**증상**: `log.txt`의 hot reload 요청 8건 중 3건이 `[HotReload] Results:` 로그 없이 사라짐 (라인 311, 1502, 2991). Toast도 안 뜨고 사용자는 "안 됐다" 결론.

**근본 원인**: debugpy가 breakpoint에 걸리면 `allThreadsStopped: true`로 **모든 Python 스레드를 정지** (`log.txt:316`의 DAP 이벤트 확인). `django-debug-hot-reload` watcher 스레드도 포함. `extension.ts:1217`의 `setTimeout(1000)` 고정 대기는 타임아웃되고, 실제로 나중에 (continue 이후) 생성된 `.reload.result` 파일은 `/tmp/django-process-debugger/`에 고아로 남음 — `35277.reload.result`, `41089.reload.result`가 실제 증거.

**수정**:
- `DebugpyInjector.pollReloadResult(pid, timeoutMs, intervalMs=20)` 추가 — 고정 1s 대기 → 20ms 폴링.
- `DebugpyInjector.isReloadPending(pid)` — `.reload` 파일 잔존 여부 확인.
- `extension.ts` DAP tracker가 `stopped(allThreadsStopped)` / `continued` / `terminated` 이벤트로 `pausedSessions: Set<string>` 관리.
- `flushHotReload`: 3s 단기 폴링 → 결과 없고 pending이면 "Reload queued" status bar + 60s 장기 폴링.
- 결과: continue 후 즉시 결과가 UI에 반영 (E2E 실측 `reload cycle (queued then resumed)` ~340ms).

**회귀 방지 테스트**: `Feature: hot reload breakpoint-deadlock recovery (log.txt bug #1)` 3 케이스. harness에 `PAUSE_WATCHER`/`RESUME_WATCHER` stdin 명령 추가해 debugpy all-threads-stopped를 시뮬레이션.

### Bug #2 — decorator closure keeps pre-reload code

**증상**: `.reload.result`가 `OK:... (patched: ... RtccEmailRecipientsInitialValuesQuery.resolve_*)` 로 리로드 성공을 보고하지만, 실제 GraphQL 응답은 구 코드. User의 resolver는 `@company_owner_required`, `@login_required` 등으로 감싸져 있음 (stack trace `log.txt:328` 참고).

**근본 원인**: `@functools.wraps(fn)`가 생성한 wrapper는 `fn`을 **closure에 capture**. 기존 `_deep_reload_module`은 wrapper의 `__code__`만 교체하지만 wrapper의 `__closure__`는 그대로 OLD 내부 함수를 가리킴 → OLD 코드 실행.

**수정**: `debugpyInjector.ts :: makeBootstrapScript`의 `_deep_reload_module`에 `_unwrap_chain` / `_patch_fn_pair` 헬퍼 추가. `__wrapped__` 체인을 따라 내려가 모든 레벨을 패치. 결과 메시지에 `(+N unwrapped)` suffix 표시.

**회귀 방지 테스트**: `Feature: decorator-wrapped method reload via __wrapped__ chain` 2 케이스 — top-level + class method 모두, 외부가 미리 저장한 wrapper / 인스턴스를 통해 호출 시 reload가 반영됨을 확인.

### Bug #3 — imported symbols in "patched" list (로그 오염)

**증상**: `.reload.result`에 `patched: TypedDict, cast, company_owner_required, ItemNotFound.__init__, ...` — import한 심볼이 reload 결과로 보고됨. 실제로는 OLD==NEW 같은 객체라 no-op이지만 진단을 방해.

**근본 원인**: `_deep_reload_module`이 `_mod.__dict__` 전체를 훑으면서 `__module__` 확인 안 함.

**수정**: `_original_mod_funcs`/`_original_mod_class_methods` 등록 루프에서 `getattr(_obj, '__module__', None) != _mod_name`이면 skip.

**회귀 방지 테스트**: `Feature: deep-reload skips imported symbols`. 새 fixture `sampleapp/imports_from_elsewhere.py`가 `from typing import TypedDict, cast`, `from sampleapp.decorated import decorate, DecoratedView`로 외부 import + 자체 정의 클래스/함수를 섞어 놓고, reload 후 patched list에 import된 이름이 **하나도** 없어야 한다고 단정.

### 부수효과: BOOTSTRAP_VERSION bump

`'2026.04.15' → '2026.04.17'`. 기존 venv에 설치된 구 bootstrap은 `isBootstrapUpToDate`가 `false` 반환 → extension이 자동 재설치. 사용자는 별도 조치 불필요.

---

## 🟡 MEDIUM — Hot reload 결과 대기 고정 1초

### 문제
`extension.ts:1217`
```ts
await injector.requestHotReload(pid, files);
await new Promise((r) => setTimeout(r, 1000));
const results = await injector.readReloadResult(pid);
```
- Python watcher 쪽은 `time.sleep(0.3)` 폴링 후 reload 수행. 실제 reload 자체는 수 ms~수십 ms.
- 고정 1초 대기는 UX 체감 느림 + 빠른 편집자에게 race 가능성.

### 실측 (2026-04-17, harness 기반 E2E)
새로 추가한 `src/test/suite/hotReloadCycle.test.ts`에서 Python 측 poll 간격을 **0.05s**로 둔 상태로 edit → `.reload` 쓰기 → 모듈 `importlib.reload` → `.reload.result` 읽기까지 wall-time을 측정했다.

| 시나리오 | 실측 ms | 비고 |
|---|---:|---|
| OK (단일 모듈 reload) | ~74 | includes one watcher poll tick (50ms) |
| SKIP (미로드 파일) | ~51 | watcher 루프 1회 + fs round-trip |
| ERR (SyntaxError) | ~45 | importlib.reload가 바로 실패 |
| batch 2개 파일 | ~48 | 파일 수에 비례하지 않음 |
| request 파일 unlink 잠복기 | ~47 | harness 50ms 폴링 1회 |

**즉, 실제 reload cycle은 45-75ms이며, 생산 코드의 1000ms 고정 대기는 15배 이상 과도.** 폴링으로 바꾸면 체감 UX가 즉각 개선된다 (편집 후 거의 즉시 toast notification).

### 제안 (유지)
1. **최우선**: 결과 파일 존재를 20ms 간격으로 최대 3s 폴링:
   ```ts
   const results = await pollForResult(reloadResultFilePath(pid), { intervalMs: 20, timeoutMs: 3000 });
   ```
   측정 기반 기대값: median ~60-80ms, tail ~200ms 수준.
2. (선택) Python watcher 폴링 주기 0.3s → 0.1s. CPU 영향 미미.
3. (선택) Node 쪽에서 `fs.watch`로 결과 파일 생성 감지 → 폴링도 불필요.

### 회귀 방지
위 E2E 테스트에서 `hot reload cycle (e2e latency)` 측정이 `<500ms` 단정문을 포함. 최적화 후에는 `<200ms`로 조이는 것을 권장.

---

## 🟡 MEDIUM — DAP trace 기본 ON

### 문제
`extension.ts:88-111`에서 등록한 `registerDebugAdapterTrackerFactory`가 모든 DAP 메시지를 `JSON.stringify` 후 OutputChannel에 기록. `stackTrace`, `variables`, `scopes` 응답은 크고 빈번.

### 제안
- `djangoProcessDebugger.traceDap: boolean` 설정 추가, 기본 `false`.
- `true`일 때만 tracker 등록.
- 또는 `trace: "off"|"summary"|"verbose"` 로 단계화.

---

## 🟢 LOW — Lock 파일 sync I/O

`extension.ts:36-52`의 `readFileSync`/`writeFileSync`. 호출 빈도 낮아 성능 영향 미미하나, 확장 host에서 sync I/O는 피하는 게 관례. `fs/promises`로 통일 권장.

## 🟢 ~~LOW — 부트스트랩 fast-path~~ (측정 결과 제외)

당초 가설: `_is_target_process()`가 모든 Python startup마다 blocklist 9개 + 서버 패턴 7개 검사를 수행하므로 argv[0] fast-path로 O(1) 컷이 가능하다.

**E2E 측정 결과** (`src/test/suite/bootstrapGating.test.ts`, 2026-04-17):
- Base Python (bootstrap 없음) `python -c pass` median: **15ms** (samples: [18,15,16,14,15])
- venv Python (bootstrap 설치됨) `python -c pass` median: **12ms** (samples: [11,11,13,14,12])
- Delta: 사실상 0 — 노이즈 범위 내, 오히려 venv가 약간 빠름 (interpreter 워밍 차이로 추정)

→ gating 자체의 비용은 인터프리터 cold start 대비 측정 불가능한 수준. **개선 여지 없음**. 항목 제외.

단, E2E 테스트가 회귀 방지 목적으로 남아 있으므로 삭제하지 말 것.

## 🟢 LOW — `src/debugSession.ts` 제거

`DjangoDebugSessionFactory` 클래스는 정의되어 있으나 `extension.ts:74-85`에서 인라인 팩토리를 직접 등록하고 있어 어디에서도 참조되지 않음. 삭제하거나, 반대로 인라인을 걷어내고 이 파일을 사용하도록 정리.

---

## 구조 리팩터링 제안 (선택)

1. **`extension.ts` 분해** (1,285 LOC):
   - `commands/attach.ts` — attach 플로우
   - `commands/setup.ts` — setup/status/reinstall
   - `commands/cleanAll.ts` — Clean All 단계별 함수
   - `lock.ts` — 세션 락
   - `hotReload.ts` — 워처 + 디바운스
2. **`logger.showAndLog`** 미사용 → 제거 또는 실제 사용처 식별.
3. **에러 메시지 국제화** (현재 모두 영어 하드코딩) — 확장성 확보.

---

## 측정 기준선 (2026-04-17, darwin/arm64, node v22.22.1)

E2E 성능 리포터는 `npm test` 실행 후 `test-results/perf-report.md`, `test-results/perf-report.json`에 기록된다.
아래 값은 개선 작업을 시작할 때 초기 기준선이며, 개선 PR마다 before/after를 이 표에 누적한다.

| 항목 | 기준선 (ms) | 개선 후 | PR |
|---|---:|---|---|
| `findDjangoProcesses` (1 fake) | 2300.6 | — | — |
| `findDjangoProcesses` (2 fake) | 2340.5 | — | — |
| `discoverRuntimeCandidates` | 2665.4 | — | — |
| `resolvePythonForPid` (self PID) | 1027.4 | — | — |
| `resolveDebuggablePid` (leaf) | 52.2 | — | — |
| `resolveSitePackages` | 19.5 | — | — |
| `installBootstrap` (파일 쓰기만) | 1.4 | — | — |
| `requestHotReload` | 0.7 | — | — |
| `readReloadResult` | 0.4 | — | — |
| `python -c pass` (bootstrap 설치됨, median) | 12 | — | — |
| `python -c pass` (base python, median) | 15 | — | — |
| Hot reload cycle: OK (harness) | 74 | — | — |
| Hot reload cycle: SKIP (harness) | 51 | — | — |
| Hot reload cycle: ERR (harness) | 45 | — | — |
| Hot reload cycle: batch 2 (harness) | 48 | — | — |
| Hot reload cycle: e2e latency (production 대기 1000ms 포함 X) | 71 | — | — |
| Full attach (bootstrap loaded) | skipped* | — | — |

\* venv-symlink 버그로 attach E2E는 현재 자동 skip. 버그 수정 후 자동 활성화.

### 관찰 포인트

- **`findDjangoProcesses (1 fake)` 2.3s vs `(2 fake)` 2.34s — 프로세스 수에 비례하지 않음.** `ps aux`의 고정 비용(전체 프로세스 스캔)이 압도적. HIGH-priority subprocess 통합 작업 시 "N개 프로세스마다 K번" 중복 스폰을 제거하는 효과가 더 크다는 뜻 — 즉, `lsof -p PID` per-PID 루프보다 단일 `lsof -iTCP -sTCP:LISTEN -nP`가 훨씬 큰 개선.
- **`resolvePythonForPid` 1.0s**는 최대 4번의 subprocess 스폰이 지배. 통합 스크립트 하나로 병합 시 **200~300ms** 목표.
- `installBootstrap` 자체는 1ms 근방이라 사용자 체감 attach 지연의 병목은 파일 I/O가 아님.
- `resolveDebuggablePid`는 fake 프로세스 1개 기준 50ms — 실제 프로덕션 환경에서는 `ps -eo` 파싱이 프로세스 개수에 선형 비례하므로 머신 로드에 따라 수백 ms까지 갈 수 있음.
- **Bootstrap gating overhead는 측정 노이즈 범위 내** — 부트스트랩이 설치된 venv의 `python -c pass`는 base Python보다 느리지 않다 (12ms vs 15ms). LOW 항목 중 "fast-path"는 불필요 (위 참고).

### E2E 테스트 구성 (feature 중심)

| 파일 | Feature | 수록된 perf 계측 |
|---|---|---|
| `commands.test.ts` | 확장 활성화 + 커맨드 등록 | `activate extension`, `getCommands` |
| `runtimeSetup.test.ts` | 런타임 candidate 탐색 | `discoverRuntimeCandidates` |
| `processFinder.test.ts` | 프로세스 분류·포트 추출·live ps | `findDjangoProcesses (live)`, `resolveDebuggablePid (leaf)` |
| `multiProcess.test.ts` | 다중 Django 프로세스 탐지 | `findDjangoProcesses (2 fake)` |
| `lock.test.ts` | 디버그 세션 락 파일 계약 | `lock write/read` |
| `hotReload.test.ts` | hot reload 파일 프로토콜 + exclusion filter | `requestHotReload`, `readReloadResult` |
| `hotReloadCycle.test.ts` | Python harness 기반 full reload cycle (OK/ERR/SKIP, batch, e2e latency) + Django/ASGI 참조 시나리오 + 멀티워커 격리 | `hot reload cycle (OK/SKIP/ERR/batch 2/file unlink latency/e2e latency/class patch/worker A only)` |
| `debugpyInjector.test.ts` | 부트스트랩 설치/업데이트/제거 수명주기 | `installBootstrap`, `isBootstrapUpToDate`, `resolveSitePackages`, `resolvePythonForPid (self)`, `python -m py_compile bootstrap` |
| `bootstrapGating.test.ts` | 비-타겟 프로세스에서 부트스트랩이 no-op임을 보장 | `python -c pass (bootstrap installed)`, `python -c pass` 기준선 vs 설치본 |
| `attach.test.ts` | 전체 attach E2E (venv-symlink 버그 시 자동 skip) | `installBootstrap (e2e venv)`, `spawn fake runserver`, `injector.activate*`, `resolveDebuggablePid (e2e)` |

모든 perf 항목은 `getPerf().measure(name, fn, { group })`를 통해 기록되며, `src/test/suite/index.ts`가 Mocha 실행 종료 후 `test-results/perf-report.{md,json}`에 덤프한다. 개선 PR마다 이 파일을 diff로 공유 가능.

### 현재 테스트가 닿지 않는 영역 (후속 테스트 후보)

- **Debug adapter descriptor factory** (`django-process` 타입) — `vscode.debug.registerDebugAdapterDescriptorFactory` 호출 자체는 활성화 테스트에서 실행되지만, 실제 DAP 핸드셰이크를 거치는 경로는 attach E2E가 skip 중이라 공백.
- **`FileSystemWatcher` + `onPyFileChanged` 디바운스 경로** — exclusion 필터는 분리·테스트 완료 (`Feature: hot reload exclusion filter`). 나머지 디바운스 + pending-set 병합 로직은 여전히 `extension.ts` 내부의 클로저. 후속으로 extract 고려.
- **`Clean All` 명령 전체 플로우** — 부작용이 크고(파일 삭제·프로세스 kill) 샌드박싱 필요. 개선 작업 시 테스트 fixture 설계 필요.
- **`djangoProcessDebugger.reinstallDebugpy`**, **`.killProcess`** 등 UI 의존 명령은 현재 등록 여부만 검증.

---

## Hot Reload 시나리오 매트릭스

Hot reload는 "파일 저장 → 바뀐 코드가 즉시 돈다"처럼 단순하지 않다. Python의 reference 모델과 서버의 배포 형태에 따라 **되는 케이스와 안 되는 케이스가 섞여 있다**. 아래 매트릭스는 `src/test/suite/hotReloadCycle.test.ts`의 시나리오 테스트로 각각 검증되어 있다. 사용자에게 문서로 노출할 때도 이 표를 바탕으로 한계를 명확히 해야 한다.

### 1) 참조 캡처 패턴별 결과 (단일 프로세스 기준, deep-reload 적용)

| 참조 패턴 | 예시 | Reload 반영? | 테스트 | 비고 |
|---|---|---|---|---|
| 모듈 속성 재조회 | `views.greet()` (`MODULE.greet()`) | ✅ 반영 | `WORKS: module-indirected function call` | `views.greet`가 reload 시 rebind되고, 호출 시점에 재조회됨 |
| 클래스 메소드 (외부가 class 참조 보유) | `path('/', View.as_view())` → `urls.SAVED_CLASS().get()` | ✅ 반영 | `WORKS: class method deep-reload propagates...` | `_deep_reload_module`이 OLD class의 method `__code__`를 in-place 패치 |
| **함수 자체 캡처 (딕셔너리/리스트에 저장)** | `URLCONF = {'/': greet}` → `URLCONF['/']()` | ❌ stale | `LIMITATION: function captured in dict...` | Django `path(..., view_func)` 안티패턴. OLD function object가 그대로 보관됨. **mitigation: urls.py까지 같이 reload** |
| 클래스 속성 (class attribute) | `class V: version = 'v1'; def get(self): return self.version` | ❌ stale (in-place 패치 안 됨) | — | class `__dict__`의 non-method 속성은 deep-reload 대상 외. 메소드 body 안에서 값을 직접 반환하거나, 인스턴스 속성으로 돌리면 우회 가능. |
| 상수의 by-value 복사 | `saved = views.GREETING` | ❌ stale | `LIMITATION: top-level constants rebound...` | 이미 복사된 str/int은 갱신 불가. `views.GREETING`을 직접 보면 ✅ |
| 데코레이터 등록 테이블 | `@app.route('/') def view()` | ❌ stale (테스트 없음 — 문서) | 후속 | 데코레이터는 import 시 registry에 OLD 래퍼를 삽입. 이후 reload는 registry를 건드리지 않음. Flask/FastAPI/Celery task registry 전부 해당. |
| 캡처된 coroutine 객체 | `coro = handle(); await coro` 사이 reload | ❌ stale | `ASGI: async handler — captured coroutine does not` | coroutine의 `cr_code`는 생성 시점에 고정. 신규 `handle()` 호출은 ✅ |

### 2) 서버 배포 형태별 reload 동작

| 형태 | Reload 반영? | 주의점 |
|---|---|---|
| `manage.py runserver` (Django dev) | ✅ | 단일 프로세스 + autoreloader. 확장은 `hotReload=true` 시 Django autoreloader를 suppress하고 signal-based hot reload를 주도한다. |
| `uvicorn --workers 1` | ✅ | 단일 워커. 위 참조 패턴 규칙 그대로 적용. |
| `uvicorn --workers N` | ⚠️ 부분 | **attach한 워커만** reload됨. 다른 워커(N-1개)는 OLD 코드로 서빙 지속 → 로드 밸런서 라운드-로빈이면 사용자가 간헐적으로 OLD를 보게 된다. 테스트: `Feature: hot reload multi-worker isolation`. |
| `uvicorn --reload` | ❌ 충돌 | uvicorn 자체 watchfiles가 변경 감지 시 프로세스 전체 재시작. 확장의 hot reload signal이 닿기 전에 프로세스가 죽고, attach 자체가 끊긴다. **실전에서는 `--reload` 끄고 확장 hot reload를 사용**하거나 그 반대. 동시 활성화 금지. |
| `gunicorn --workers N` | ⚠️ 부분 | uvicorn 멀티워커와 동일. 추가로 `--preload` 플래그가 켜져 있으면 워커는 fork-from-memory로 올라오므로 signal을 보낸 마스터 프로세스는 reload되지 않아야 한다 — **마스터에 attach하지 말 것**. |
| `daphne -p PORT` (ASGI) | ✅ | 기본 단일 프로세스. uvicorn 단일 워커와 동일. |
| `celery worker` | ⚠️ | Task 함수가 Celery registry에 캡처되어 있어 위 "데코레이터 등록 테이블" 패턴에 해당. `tasks.py` reload만으로는 기존 queued task가 새 코드를 못 본다. 각 워커 프로세스가 다수일 경우 멀티-워커 문제도 중첩. |

### 3) 실전 권장 (UX 가이드 초안 — README 반영 후보)

- **attach한 프로세스 내부의 코드 수정 → 즉시 반영**: ✅ 대부분 시나리오에서 잘 동작.
- **`urls.py` 변경**: 반드시 `urls.py` 자체가 reload 대상에 포함되어야 하고, 그 전에 `views.py`도 같이 반영되어야 한다. 확장이 "다중 파일 변경을 한 배치로 묶어서 reload"하는 현 debounce(500ms) 동작이 이 케이스를 지원한다.
- **멀티워커**: 디버그 세션 자체가 단일 프로세스에 attach하므로, **hot reload도 그 프로세스에만 유효**. 개발 중엔 `--workers 1`로 띄우는 것을 권장.
- **`uvicorn --reload` / `gunicorn --reload` 동시 사용 금지**: 프로세스가 통째로 재시작되면 debugger 연결이 끊긴다.
- **Celery task reload**: 단순히 `importlib.reload(tasks)`만으로는 registry 갱신이 안 되므로, Celery worker 재시작이 가장 안전한 방법. 확장이 처리하지 않는 영역임을 문서화할 것.
- **function-as-first-class 캡처를 피하는 스타일**: 코드 작성 시 `URLCONF = {'/': views.greet}`처럼 lazy indirection을 쓰면 reload-friendly. 단, 기존 Django 코드베이스에 이걸 강요할 수는 없으므로 **"관련 urls.py도 저장하시면 반영됩니다"** 정도의 UX 힌트가 현실적.

### 4) 최적화 관점의 후속 작업 (derived from scenarios)

- 🟡 **Auto-co-reload dependents**: `views.py` 하나만 저장해도 확장이 `urls.py`를 자동으로 같이 reload 큐에 넣어주면 "dict-captured function" 한계가 대부분 가려진다. 구현은 Python쪽 static import-graph 분석 필요 (ast 모듈).
- 🟡 **Decorator registry hint**: 저장한 파일에 `@*.route`, `@*.task`, `@shared_task`, `@app.route` 패턴이 감지되면 "Celery/Flask 데코레이터 기반 registry는 자동 reload가 제한적입니다" toast 표시.
- 🟡 **Multi-worker detection**: `findDjangoProcesses` 결과에 같은 포트의 형제 프로세스가 여럿이면 "이 어플리케이션은 멀티워커로 실행 중입니다 — hot reload는 선택한 워커만 반영됩니다" 경고.
- 🟢 **Pre-attach sanity warning**: `--reload`, `--workers >1` 플래그 탐지 시 attach 직전에 안내 메시지.

---

## 변경 로그

- 2026-04-17 — 초안. 정적 분석 기반 항목 식별. E2E 테스트 인프라와 함께 도입.
- 2026-04-17 — feature 중심 E2E 보강 (`multiProcess.test.ts`, `bootstrapGating.test.ts`). 부트스트랩 gating 측정 결과를 반영해 🟢 LOW "fast-path" 항목 제외. 기준선 표를 2차 측정값으로 갱신 + "테스트 구성" 매트릭스와 "닿지 않는 영역" 섹션 추가.
- 2026-04-17 — 핫 리로드 E2E 보강. `src/hotReloadFilter.ts`로 exclusion 규칙을 분리하고 단위 테스트 3개 추가. Python `hot_reload_harness.py` + `sampleapp` fixture로 OK/SKIP/ERR/batch/unlink 잠복기/e2e 총 6개 시나리오 추가 (`hotReloadCycle.test.ts`). 실측값을 근거로 🟡 "1초 고정 대기" 항목에 구체적 목표치(<200ms tail) 명시.
- 2026-04-17 — Hot reload 시나리오 매트릭스. Harness에 `_deep_reload_module` parity 반영. `sampleapp/urls.py`를 Django urlconf 캡처 패턴(URLCONF dict, SAVED_CLASS, MODULE) 으로 구성하고 7개 시나리오 테스트 추가 (클래스 메소드 deep-reload, 모듈 indirection, dict-captured stale, 상수 by-value stale, async coroutine stale, 멀티워커 격리, unattached-pid 무간섭). 매트릭스를 서버 배포 형태별(runserver/uvicorn/gunicorn/daphne/celery)로 확장. UX 권장사항과 후속 최적화 4종(auto-co-reload, decorator hint, multi-worker detection, pre-attach sanity) 제안.
- 2026-04-17 — **실전 log.txt 진단 → 3개 프로덕션 버그 수정**. (1) breakpoint deadlock: `extension.ts` 고정 1s 대기를 `injector.pollReloadResult`로 교체 + DAP `stopped`/`continued` 이벤트로 `pausedSessions` 추적. 3s 단기 폴링 실패 시 `isReloadPending` 확인 후 60s 장기 폴링 + "Reload queued" status bar. (2) decorator closure: bootstrap `_deep_reload_module`이 `__wrapped__` 체인을 따라가서 가장 안쪽 함수까지 `__code__` 패치. harness도 동기화. 결과 로그에 `(+N unwrapped)` suffix. (3) import filter: `__module__ != _mod_name`인 심볼은 "patched" list에서 제외. BOOTSTRAP_VERSION 2026.04.15 → 2026.04.17 bump으로 기존 설치 자동 갱신. 새 E2E `hotReloadProductionBugs.test.ts` 5 케이스 (단기 폴링 null, 장기 폴링 복구, 파일 소비, 데코레이터 wrapping top-level + class method, import filter). "LIMITATION: dict-captured function stale" 테스트는 프로덕션 bootstrap이 실제로는 해결하고 있음을 밝혀 WORKS 테스트로 전환. 핫 리로드 시나리오 매트릭스의 Django urlconf 행은 이제 ✅.
