# Spell Cast System — Architecture Review

**Status:** Exploratory — starting point for further investigation and specification
**Branch:** `docs/spell-cast-architecture-review`
**Author:** Investigation notes from the `fix/mobile-compose-spell-and-media-save` bug-fix sweep (4.7.3 → 4.7.4)
**Scope:** End-to-end spell cast lifecycle: canvas → API → workflow execution → adapter → webhook → settlement.

---

## Why this document exists

Over the course of patching mobile spell casting we hit a chain of bugs whose
common thread was *the spell cast system has no single owner*. Each piece —
schema loading, input resolution, step execution, charging, finalization —
has at least two implementations sitting next to each other, with a third
"in transition" version glued in for whichever surface (Telegram, Discord,
canvas, web sandbox) was added most recently. Every fix in this sweep landed
in a different file:

| Commit  | Area                                                |
|---------|-----------------------------------------------------|
| `e7ebfe4` | Sandbox primitive turned into a real backend tool  |
| `9a31490` | Workflow stopped fan-out of step outputs in spells |
| `0019f2a` | Telegram cast prompt routed to sole exposed input  |
| `7d9cc89` | Canvas backfill exposed inputs / all-optional schemas |
| `bff864e` | Spell steps actually billed (the no-charge bug)    |

Each of these was a real bug in production; none of them were caught by the
existing test surface. The point of this document is to capture *why* this
system is so fragile and to propose a reduced, testable architecture so the
next sweep is shorter than this one.

---

## TL;DR

1. **Charging is scattered across at least four files.** A spell can be
   debited upfront (`SpellsService.castSpell`), per-immediate-step
   (`generationExecutionService.execute`), per-async-completion
   (`generationExecutionService.execute` async branch), per-webhook-completion
   (`comfyDeploy/webhookProcessor.js`), and aggregated for display in
   `StepContinuator._finalizeSpell` — but never in a single funnel that an
   integration test can pin.
2. **Cost-rate derivation is duplicated.** The exact same `costingModel →
   { amount, unit }` mapping now lives in two places after `bff864e`. This
   will drift.
3. **Spell-step debit was silently broken in production.** It was the
   canvas-cast cost-rate bug. No test would have caught it; no log louder
   than `debug` flagged it.
4. **The canvas spell window doesn't load its tool schema.** The reason
   "I cast a spell and there are no inputs" keeps coming back.
5. **`exposedInputs` has at least three on-the-wire formats.** Object,
   array of strings, array of `{name,...}`. Every consumer reimplements the
   coercion.
6. **There is no integration test for `cast → balance changed`.** The
   absence of this test is the single highest-leverage fix.

The proposed direction at the bottom is: a single `BillingService.settleGeneration`
funnel, a typed `SpellSchema` resolver, and a smoke test that asserts a cast
debits the cast-er.

---

## Findings

### 1. Charging is scattered across multiple subsystems

A spell can become "paid for" through any of these paths:

| Path                                                              | File                                                            | Triggered by                                |
|-------------------------------------------------------------------|-----------------------------------------------------------------|---------------------------------------------|
| Upfront quote charge                                              | `src/core/services/SpellsService.js` `castSpell()`              | `context.quote && context.chargeUpfront !== false` |
| Immediate (synchronous) tool execution                            | `src/core/services/generationExecutionService.js` line 459      | `ImmediateStrategy`                         |
| Async adapter completion                                          | `src/core/services/generationExecutionService.js` line 597      | `AsyncAdapterStrategy` poll completion      |
| Webhook completion (comfyui)                                      | `src/core/services/comfydeploy/webhookProcessor.js` line ~347   | `WebhookStrategy` → ComfyDeploy webhook     |
| Aggregation only (no debit)                                       | `src/core/services/workflow/continuation/StepContinuator.js` `_finalizeSpell` | Last step of a spell run                    |
| **`AsyncJobPoller` completion (NEVER debits)**                    | `src/core/services/workflow/adapters/AsyncJobPoller.js`         | Adapter polling completion                  |

Two of these (`AsyncJobPoller` completion, and the canvas path that bypassed
`SpellsService.castSpell`'s upfront branch) result in **un-charged work**
unless their generation record happens to drop into the comfydeploy webhook
processor's debit branch. In the canvas spell case, the comfydeploy webhook
*does* fire — but it can't compute `costUsd` if `metadata.costRate` is
missing, which is exactly what `bff864e` fixed.

The crucial test that nobody is running is: **for every code path that can
"finish" a generation record, is there exactly one debit attempt?**

### 2. Cost-rate derivation is duplicated (and now drifting)

The mapping from `tool.costingModel` → `{ amount, unit }` lives in two places:

- `src/core/services/generationExecutionService.js` lines 277–309 — the
  "official" rate-derivation, used by immediate and async tools.
- `src/core/services/workflow/adapters/AdapterCoordinator.js` `_computeCostRate()`
  — added by `bff864e` because spell-step records didn't get one.

These two implementations agree *today*, but there is no shared module and
no shared test. Any future change to `costingModel` (a new `rateSource`,
a new shape for `staticCost`, etc.) has to land in both files. **Extract
to a shared `costRate.js` module that both call.**

While at it: there are also two `getCostRateForDeployment` functions that
return *different shapes*:

- `src/core/services/comfydeploy/workflowCacheManager.js` line 1001 returns
  a number from `GPU_COST_PER_SECOND[gpuType]`.
- `src/core/services/comfydeploy/comfyui.js` `ComfyUIService.getCostRateForDeployment`
  line 262 returns `{ amount, currency, unit }` from the static
  `MACHINE_COST_RATES` map.

Rename or merge.

### 3. Dead spell-step bypass code in `webhookProcessor.js`

`src/core/services/comfydeploy/webhookProcessor.js` lines ~193–253 contain
a vestigial spell-step branch with this comment:

> NOTE: Previously we bypassed debit for spell steps. This vestigial logic
> has been removed so that spell steps are now billed like regular tool
> runs.

The comment claims the logic was removed; ~60 lines of it remain. This is
exactly the kind of dead code that hides bugs — when something goes wrong
in spell-step billing, the first place to look is now misleading. **Either
delete the block entirely or replace it with a single-line `// no-op:
spell steps follow the standard debit path` and remove the surrounding
machinery.**

### 4. `StepContinuator._finalizeSpell` aggregates costs but cannot reconcile

`src/core/services/workflow/continuation/StepContinuator.js` `_finalizeSpell`
calls `costAggregator.aggregateCosts(stepGenerationIds)` and writes the
resulting `costUsd` / `pointsSpent` / `protocolNetPoints` onto the *final
notification generation record*. It never compares this to "what was
actually debited" and never calls the credit service.

In practice:

- If every step billed correctly, the aggregate is informational.
- If a step *failed to bill* (the `bff864e` case), nobody notices because
  the aggregate says "$0 spent across 4 generations" and gets shown as a
  display-only field on a notification.

`_finalizeSpell` should at minimum:

1. Sum what *should have been* charged (from per-step `costRate`).
2. Sum what was *actually* charged (from per-step `pointsSpent`).
3. If they differ by more than rounding, log a `warn` and emit a metric.

Better yet: have `_finalizeSpell` *be* the place where billing happens,
and remove per-step debit entirely. (See "Proposed direction" below.)

### 5. The canvas spell window doesn't load its tool schema

`src/platforms/web/frontend/src/sandbox/canvas2/SandboxCanvas2.js`:

- `addSpellWindow` (line 132) creates a window with no `win.tool`,
  leaving freshly-added spell windows with no `inputSchema`.
- `_inputSchema(win)` (line 827) returns `win.tool?.inputSchema || win.tool?.metadata?.inputSchema || {}` — i.e. an empty object when `win.tool` is missing.
- `_loadToolDetail(windowId)` (line 831) only runs for `win.type === 'tool'`,
  so spells never get a schema fetched.
- The deserializer (line 263) backfills `win.tool` with a stub
  `{ displayName, toolId: 'spell:<id>' }` — no inputs.

This is the root cause of "I cast a spell and there are no inputs to fill
in". `7d9cc89` papered over part of it by tolerating all-optional schemas,
but the underlying fix is to teach `_loadToolDetail` (or a new
`_loadSpellDetail`) to fetch the spell's exposed input schema and stamp
it onto `win.tool`.

### 6. `exposedInputs` has at least three on-the-wire formats

The same field appears as:

- An object keyed by step+input: `{ "step1.prompt": { ... } }`
- An array of strings: `[ "step1.prompt", "step2.seed" ]`
- An array of objects: `[ { name: "step1.prompt", required: true } ]`

Every consumer (Telegram cast handler, canvas window, sandbox renderer,
spell editor) reimplements coercion. `0019f2a` was a fix in this exact
area — Telegram was routing the prompt to the wrong field because it
guessed wrong about which format the spell carried. **Pick one canonical
shape (object preferred), write a `normalizeExposedInputs(spell)` helper,
and call it on read.**

### 7. There are no tests on the charge path

No file under `tests/` exercises `cast → economy.spend`. The system relies
entirely on production reports to discover billing regressions. The
`bff864e` bug shipped to production and was caught by the user noticing
their balance hadn't changed.

### 8. The canvas execute flow does not pass an upfront quote

`src/api/external/generations/generationExecutionApi.js` line ~63 detects
`toolId.startsWith('spell:')` and routes to `/internal/v1/data/spells/cast`
with a `context` containing `masterAccountId`, `platform`, and
`parameterOverrides` — but **no `quote`**. Therefore
`SpellsService.castSpell`'s upfront-charge branch (which requires
`context.quote`) is skipped, and the system falls back to per-step debit.

This is by design (canvas wanted accurate per-run billing rather than
estimate-then-reconcile), but the design was never written down, so when
per-step debit broke, there was no fallback. The "we no longer charge
upfront" decision needs to either:

- Be reverted (compute a quote at canvas execute time), **or**
- Have a hard guarantee that *every* code path that finishes a step will
  debit — i.e. the consolidated `BillingService` proposed below.

### 9. Silent debit failures are logged at `debug`

When `webhookProcessor` cannot compute `costUsd` (the `bff864e` failure
mode), it does not warn. It just doesn't debit. The only trace is a
`debug` log line, and the generation record is marked `completed`.

**Any "I expected to charge but couldn't" condition should be `warn` at
minimum, and ideally emit a metric.** The new
`AdapterCoordinator._computeCostRate` already does this — but the
webhook processor's "costUsd is null, skipping debit" path does not.

---

## Proposed direction

These are starting points for further specification, not finished
designs.

### A. Single `BillingService.settleGeneration(generationId)` funnel

**Goal:** every code path that finishes a generation record (immediate
return, async poll completion, comfydeploy webhook, error path) calls
exactly one function: `BillingService.settleGeneration(generationId)`.
That function:

1. Loads the generation record.
2. Refuses to double-bill (idempotency key on the record:
   `metadata.billing.settledAt`).
3. Computes `costUsd` from `metadata.costRate` + `metadata.jobStartTime` +
   `finalEventTimestamp` using the *single* `computeCostUsd` helper
   extracted from `webhookProcessor.calculateCostUsd`.
4. Calls `economyService.spend(...)`, splits creator share if it's a spell
   step, and records the result back onto the generation.
5. Emits `generationSettled` for downstream display.

Once this exists:

- `webhookProcessor` calls it.
- `AsyncJobPoller` calls it (currently doesn't bill at all).
- `generationExecutionService` calls it (currently has its own copy of
  the spend logic).
- `StepContinuator._finalizeSpell` becomes purely informational (or
  goes away).

Then the integration test in (B) actually has a single seam to assert
against.

### B. Integration test: `cast → balance changes by the right amount`

A single test that:

1. Creates a fixture user with a known balance.
2. Creates a fixture spell with one comfyui step and a known `costingModel`.
3. Mocks the comfyui webhook fixture.
4. Calls the `/api/v1/generation/execute` endpoint with `toolId: 'spell:<id>'`.
5. Asserts `economyService.spend` was called once with the expected amount.
6. Asserts the user balance dropped by that amount.

This single test would have caught both `bff864e` and the
`AsyncJobPoller`-never-debits issue. **Highest leverage of any item in
this document.**

Variants to add later: an immediate-only spell, a spell containing both
immediate and webhook steps, a spell where the webhook fails, a spell
where one step has `staticCost: 0` and a `costTable`.

### C. Canvas spell window: actually load the schema

In `SandboxCanvas2.js`:

- Generalize `_loadToolDetail` to handle `win.type === 'spell'` by
  fetching from `/internal/v1/data/spells/:id` (or a public mirror) and
  populating `win.tool.inputSchema` from `spell.exposedInputs` after
  passing through the canonical `normalizeExposedInputs`.
- Call it from `addSpellWindow` and from the deserializer's spell branch.
- Drop the all-optional-schema special case in `_inputSchema` once every
  spell window has a real schema attached.

### D. Canonicalize `exposedInputs`

Pick the object shape:

```js
{
  [`${stepIndex}.${inputName}`]: {
    label: string,
    required: boolean,
    type: string,
    default?: any,
  },
}
```

Add `normalizeExposedInputs(spell)` and call it everywhere
`spell.exposedInputs` is read. Remove the array-of-strings and
array-of-objects branches one consumer at a time.

### E. Promote the silent-skip to a warn

`webhookProcessor.js` debit guard:

```js
if (!(generationRecord && updatePayload.status === 'completed' && costUsd != null && costUsd > 0)) {
    if (generationRecord && updatePayload.status === 'completed' && costUsd == null) {
        this.logger.warn(`[webhookProcessor] Refusing to debit generation ${generationId}: costUsd is null. Check metadata.costRate.`);
    }
    // ... existing skip ...
}
```

Cheap, immediately surfaces the next regression.

---

## Out of scope (for this document)

- The mobile compose UI changes that started this sweep.
- The collection / collectionTest window types (different bug surface).
- Spell *creation* and the spell editor's inputSchema authoring (related,
  but a separate review).
- Telegram-specific spell flows (similar issues but different consumers).

---

## Starting points for the next investigation

When picking this back up, start here:

1. **Read** `BillingService` — does not exist yet; sketch its API in a
   second markdown file in this directory before writing any code.
2. **Read** `tests/integration/` — confirm there is *no* existing
   cast→balance test. If there is even a stub, build on it.
3. **Read** `src/api/external/generations/generationExecutionApi.js`
   `executeGenerationHandler` — understand exactly what context the
   canvas surface passes, because that is the contract the new
   `BillingService` has to honour.
4. **Read** every callsite of `economyService.spend` (`grep -rn
   'economyService.spend' src/`) — this is the inventory of debit
   sites that need to collapse into the funnel.

The test in (B) should land *before* the refactor in (A). Otherwise the
refactor has no safety net.
