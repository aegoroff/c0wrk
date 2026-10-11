# Code Review — накопленные находки

## Обзор

- **Scope:** ветка `fix/indexing-issues` относительно `main` (merge-base `d14bbe6450c58fae0e80d78047937626c7c80cdf`).
- **Коммиты:**
  - `0dd6b97d` fix(config): move worktree embedding cache inside its storage root
  - `3d27045c` fix(backend): bound switch critical section with one deadline and dump busy lock holders
- **Изменения:** 17 файлов, +445/−107 (backend/, backend/config, specs/).
- **Инструкция:** в файл накапливаются только находки уровней MUST FIX и SHOULD FIX; код не исправляется.

## Вердикт

**MUST FIX: 0. SHOULD FIX: 1.**

Первоначальный проход записал 0/0; независимый повторный проход по тому же диффу выявил одну находку уровня SHOULD FIX — S1 (раздел «Находки»), записанную без правок кода. Остальное содержимое файла сохранено. Ниже — зафиксированная доказательная база (что именно проверено), чтобы повторное ревью сходилось к тому же результату и не порождало новых находок тех же уровней.

Ревизия 3: S1 устранена (вариант «c»); актуальное состояние диффа — **MUST FIX: 0. SHOULD FIX: 0** (см. «История находок» и ревизионную заметку в конце файла).

## Проверено и подтверждено (доказательная база)

### Коммит `0dd6b97d` — кэш эмбеддингов worktree внутри его storage root

1. **Контейнмент-правило SDK подтверждено исходником**, а не комментарием: `core/vectorindex/service.go:560-566` — `Service.SetProject` отключает persistent-кэш (`IsWithinPath(fullPath, embeddingCachePath)`, fail-closed с Warn), когда корень кэша вне storage root. Старое расположение `<projectVI>/embedding_cache-worktrees/<name>` действительно отказывалось → первый проход индексации дерева всегда был холодным. Новое `<storage>/embedding_cache` проходит проверку.
2. **Инвариант «кэш-корни не вкладываются»** сохранён: `<projectVI>/embedding_cache` и `<projectVI>/worktrees/<name>/embedding_cache` — непересекающиеся поддеревья; деревья не вкладываются друг в друга (`validateManagedWorktreeName` запрещает разделители пути). Закреплено тестами `TestWorktreeEmbeddingCachePath_NoNestedCacheRoots` / `..._InsideWorktreeVectorStorage`.
3. **Миграция legacy-layout не задевает новые каталоги:** `isLegacyCollectionDirName` (core/vectorindex/layout.go:90) совпадает только с 8-hex именами; `embedding_cache`, `worktrees`, `embedding_cache-worktrees` не совпадают, миграция не спускается в подкаталоги.
4. **Legacy-путь воспроизводится байт-в-байт:** `LegacyWorktreeEmbeddingCachePath` (backend/config/paths.go:198) повторяет точное старое выражение (сверено с `git show d14bbe64:backend/config/paths.go`), поэтому cleanup `deleteWorktreeVectorIndex` (backend/frontend_api_vector.go:157-167) целится в реальное старое расположение. Писателей в старое место в коде не осталось (`rg embedding_cache-worktrees` — только доки и legacy-builder).
5. **Удаление полно:** `DeleteProjectData(storage)` снимает менеджер до удаления (Windows-безопасно) и удаляет storage root целиком — новый кэш внутри; явный `RemoveAll` оставлен как belt-and-braces; legacy-каталог удаляется отдельно; `DeleteProject` удаляет весь `<projectVI>` (обе категории). Ранний `return` при ошибке деривации storage эквивалентен по валидации ошибке деривации кэша (одинаковые проверки имени).
6. **Seed и recreate-семантика сохранены:** `seedWorktreeEmbeddingCache` (backend/frontend_api_vector.go:197) следует за новым `WorktreeEmbeddingCachePath`; существующий dst не трогается; recreate-путь переиспользует уцелевший корень кэша — поведение эквивалентно старой схеме.
7. **Централизованный path API соблюдён** (AGENTS.md): только `config.*Path` + `pathutil.IsWithinPath` (родитель, потомок — семантика сверена по `sp4rk/pathutil/pathutil.go:37`; правка повторным проходом: функции `pathutil.IsThroughPath` не существует — первоначальная цитата ошибочна, код ветки использует `pathutil.IsWithinPath`, напр. `backend/config/paths.go:541`, `core/vectorindex/service.go:563`); никаких инлайн-`HasPrefix`.

### Коммит `3d27045c` — один deadline критической секции свитча + дамп занятого lock

1. **Воронка store-операций полная:** все round-trip внутри критической секции `SwitchProject` (backend/frontend_api_project.go:316-483) выведены из одного `switchCtx` через `switchStoreOpCtx` (= `min(15s, остаток секции)`): `GetProjectCtx` (оба пути), `persistCurrentProjectSwitchState` → LoadUIState/resolve/SaveUIState, `resolveVectorIndexTarget` → LoadUIState + `WorkspacePathFor`, `applySavedProjectSwitchState`, `createSessionForProject` (GetProject + SaveSession), `resolveNoProjectSessionWorkspace`, `ListSessionsByProjectCtx`. Неконвертированных store-вызовов в секции не осталось.
2. **Атомарность свитча сохранена при истечении deadline:** после teardown все шаги fail-soft по ctx — `switchProjectSetupVector` не возвращает ошибку по deadline (проверено тело: handshake/mu, LeaveFocus, resolveVectorIndexTarget degrade-to-base, ApplyFocus warn-only); активация коммитится безусловно; отказ `GetProjectCtx` до teardown чисто прерывает свитч. Спецификация (specs/domains/workspace.md, ADR-081) обновлена согласованно с кодом.
3. **Поведение не-switch вызовов не деградировало:** `restoreDBReadTimeout == sessionStoreOpTimeout == 15s` (backend/session/manager.go:48, backend/frontend_api_session.go:24), поэтому `resolveSavedSessionForProject(context.Background(), …)` сохраняет прежнюю границу; `ListSessionsByProject` сохраняет `restoreDBReadTimeout`. Пост-сторовая часть `ListSessionsByProjectCtx` — только in-memory overlay, блокирующих чтений под ctx нет.
4. **Cancel-пары полны** (проверен каждый `switchStoreOpCtx`/`WithTimeout`): defer или явный cancel на всех путях, включая ветки ошибок; гонок на `f.logger` нет (dump и deferred-warn идут в пределах жизни capture-хука теста).
5. **Дамп занятого lock корректен:** `dumpBusySwitchHolders` вызывается без удержания switchMu, каппирован (512 KiB, `dump_truncated` консервативен), не влияет на исход; `runtime.Stack` детерминированно содержит кадры вызывающего горутинного пути, что закреплено матчером теста `TestSwitchProject_AcquireSwitchLockTimesOut` (проект ожидает ровно 2 WARN-записи — сверено с потоком свитчей в тесте: held первого свитча ≈200ms < порога 3s).
6. **Хук-сейм и все вызовы обновлены** (`switchProjectSetupVectorFn func(ctx, *project.ProjectInfo)`); `InitVectorIndexForActiveProject` передаёт `context.Background()` — по-прежнему ограничено per-op бюджетами (10s/15s), блокирующий `switchMu.Lock()` дрена — прежнее поведение, теперь ждёт ≤30s вместо минут.
7. **Замеченный остаточный риск задокументирован самим кодом:** `createSessionForProject` неустранимо неограничен (полная сборка оркестратора без deadline) — pre-check `switchCtx.Err()` сокращает окно, held-warn ≥3s его подсвечивает; eviction-drain `ManagerForRoot` ≤25s и `mgr.SwitchProject` (init асинхронный, `go m.initProject`, core/vectorindex/manager.go) — прежние, не ctx-зависимые шаги.

### Верификация

- `GOWORK=off go test ./backend/... ./core/vectorindex -count=1` — все пакеты ok (backend 50.7s, session 7.2s, vectorindex 13.0s).
- Целевые тесты ветки (`TestWorktreeEmbeddingCachePath*`, `TestLegacyWorktreeEmbeddingCachePath`, `TestSwitchProject*`, `TestApplySavedProjectSwitchState*`, `TestResolve*`, `TestSwitchProjectSetup*`) — PASS, без посторонних diagnostics в выводе.
- `gofmt -l` по изменённым Go-файлам — чисто; `go vet ./backend/...` — чисто.

## Находки

### S1 — SHOULD FIX — комментарий `switchSectionTimeout` заявляет «total hold is bounded» и «every store round-trip in the critical section is derived from one ctx», чему противоречит код самой ветки

`backend/frontend_api.go:745-758` — комментарий константы `switchSectionTimeout` (добавлен этой веткой в `3d27045c`) заявляет: «Every store round-trip in the critical section is derived from one ctx carrying this deadline (see SwitchProject), so the total hold is bounded». Оба тезиса опровергаются кодом той же ветки:

**(а) `createSessionForProject` — неограниченная сборка оркестратора внутри секции за pre-check'ом.** Внутри критической секции `SwitchProject` выполняется цепочка `applySavedProjectSwitchState` (frontend_api_project.go:462 → :1057) → `resolveSessionFallback` (:1100) → `createSessionForProject` (вызов :1114, определение :1178). Функция ограничивается pre-check'ом `switchCtx.Err()` (:1185), который отсекает только уже истёкший дедлайн, после чего запускает `CreateSession` — полную сборку оркестратора (MCP gateway, skill scans) без внутреннего deadline. Её собственный комментарий (:1186-1191) признаёт: «CreateSession builds a full orchestrator … with no internal deadline, so starting it here could hold switchMu far past switchSectionTimeout».

**(б) Векторная нога — store-round-trip мимо единого дедлайна и ожидание eviction-drain до 25s.** Внутри секции `switchProjectSetupVector` (:889) вызывает `vr.ApplyFocus` (:931, warn-only) → `VectorRoots.ApplyFocus` (vector_roots.go:426) → `ManagerForRoot` (:435) → `resolveRootPlan` (:308 → :214), который на :219 зовёт plain `f.projectManager.ListProjects()` — вариант, создающий независимый `m.opCtx()` (project/manager.go:264-267), хотя для этой секции существует ровно предназначенный `ListProjectsCtx` (manager.go:270-276: «the caller-deadline variant … exists so the project-switch critical section can derive every store round-trip from ONE switch-scoped deadline»). Кроме того, `ManagerForRoot` может ждать eviction Shutdown-drain до `vectorRootsEvictWait = 25 * time.Second` (vector_roots.go:53-58) — не ctx-зависимый шаг внутри секции.

То же завышенное обобщение зеркалится в документации: новый пункт `specs/domains/workspace.md` («The switch critical section carries ONE deadline…») утверждает «The switch therefore derives every store read/write from ONE ctx» — правка комментария (вариант a ниже) должна сопровождаться исправлением этой строки спецификации.

**Why it is a problem:** комментарий — несущая документация ключевого инварианта ветки (потолок удержания `switchMu`). Сопровождающий, положившийся на заявленную гарантию «total hold is bounded» (≤30s), при будущей правке может удалить «избыточный» pre-check в `createSessionForProject` или пересчитать UI-бюджеты (5s acquire / 30s section) под мнимую гарантию — и вернуть тот самый отказ «Another project switch is still finishing», который ветка чинит; сценарий насыщенной машины уже описан в самом комментарии. Это «likely future bug», а не стилистическая мелочь уровня CONSIDER.

**Suggested fix:**
a) Минимальный (устраняет находку): привести комментарий `switchSectionTimeout` в соответствие с кодом — единый ctx-дедлайн ограничивает только ctx-производные store-round-trip; явно перечислить исключения (fallback-создание сессии: pre-check + неограниченная сборка оркестратора; векторная нога: `ListProjects` с собственным opCtx и eviction-drain ≤25s) и указать, что фактические превышения подсвечивает held-warn ≥ `switchHeldWarnThreshold`.
b) Свести код к заявленному инварианту: на пути свитча передавать в `resolveRootPlan`/`ListProjectsCtx` ctx, производный от `switchCtx` (сигнатура `resolveRootPlan` ctx не принимает — потребуется параметр), устраняя исключение (б); исключение (а) задокументировать как осознанное (см. a) либо ограничить `CreateSession` производным ctx, если это поддерживается.
c) a + b вместе: и честный комментарий, и максимальное сведение кода к нему.

## История находок

| # | Уровень | Статус | Файл/коммит | Резюме |
|---|---------|--------|-------------|--------|
| S1 | SHOULD FIX | устранена (ревизия 3, вариант «c»: код сведён к инварианту + честный список исключений) | `backend/frontend_api.go:745-758` (коммит `3d27045c`) | Комментарий `switchSectionTimeout` («every store round-trip … from one ctx … total hold is bounded») противоречит коду ветки: (а) `createSessionForProject` — pre-check-only + неограниченная сборка оркестратора; (б) векторная нога `ApplyFocus → ManagerForRoot → resolveRootPlan` — plain `ListProjects()` с независимым opCtx (мимо `ListProjectsCtx`, созданного для этой секции) и eviction-drain до 25s |

Ревизия 2 (повторный проход): добавлена S1; в п.7 раздела «Проверено и подтверждено» поправлена цитата API (`pathutil.IsThroughPath` не существует; код использует `pathutil.IsWithinPath`); остальное содержимое сохранено без изменений.

Ревизия 3 (устранение S1, вариант «c» — код + документация):
- **Векторная нога сведена к единому ctx:** `resolveRootPlan`/`ManagerForRoot`/`VectorRoots.ApplyFocus`/`FocusManager` принимают `ctx`; листинг проектов внутри `resolveRootPlan` выполняется через `ListProjectsCtx` под caller-контекстом с per-op капой `sessionStoreOpTimeout` (= прежний бюджет `Manager.opCtx` для plain `ListProjects()`); switch-путь (`switchProjectSetupVector`) передаёт `switchCtx` → `ApplyFocus(switchCtx, …)`, не-switch пути — `f.ctx()` (git-focus, три RPC: SearchVectorStore/GetVectorIndexStatus/ReindexVectorIndex) или task-ctx (`ManagerForContext`). Доки `ListProjectsCtx`, `resolveRootPlan`, `ManagerForRoot`, `ApplyFocus`, `FocusManager` обновлены; eviction-drain остался time-bounded (`vectorRootsEvictWait`, 25s) — задокументирован как исключение.
- **Комментарий `switchSectionTimeout` и `specs/domains/workspace.md` приведены к коду:** убрано завышенное «total hold is bounded»; добавлен векторный канал в воронку (`switchProjectSetupVector → ApplyFocus → resolveRootPlan → ListProjectsCtx`); явно перечислены два известных исключения (createSessionForProject: pre-check + неограниченная сборка оркестратора; eviction-drain ≤25s) и held-warn как наблюдаемый backstop.
- **Верификация:** `GOWORK=off go test ./backend/... ./core/vectorindex -count=1` — все пакеты ok; целевые тесты (`TestSwitchProject*`, `TestSwitchProjectSetupVector*`, `TestInitVectorIndexForActiveProject*`, `TestApplyFocus*`, `TestSetGitPanelFocus*`, `TestManagerForContext*`, `TestResolveVectorIndexTarget*`) — PASS, посторонних diagnostics нет; `GOWORK=off make lint` — чисто (fmt-check, golangci-lint 0 issues, frontend eslint; plain `make lint` в этом worktree падает на родительском `go.work` корня c0wrk — состояние ADR-031, к диффу отношения не имеет).
- **Повторное ревью диффа (merge-base `d14bbe64` → рабочее дерево):** новых находок уровней MUST FIX / SHOULD FIX не обнаружено. Проверено: cancel-пара `readCtx` в `resolveRootPlan`; не-switch поведение без регрессий (те же 15s per-op); атомарность свитча сохранена (истечение дедлайна в векторной ноге → warn-only, активация коммитится); оставшиеся plain store-вызовы (`frontend_api_project.go:144` RPC ListProjects, `:215` SaveProjectActiveSession, `:1259` WorkspacePathFor под switchCtx, `frontend_api_vector.go:74`) — вне критической секции.
