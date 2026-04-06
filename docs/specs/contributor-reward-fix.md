# Specification: Contributor Reward System Fix

## Problem Statement

The contributor reward system (`distributeContributorRewards`) exists in the webhook processor but never fires because `loraResolutionData.appliedLoras` is always empty in generation records. Three bugs prevent LoRA ownership data from reaching the reward distribution logic.

## Intended Behavior

When a user runs a generation that uses LoRA models trained by other users (and/or a spell authored by another user), an additional surcharge of up to 20% of the base generation cost is charged to the user and distributed to contributors:

- **Spell author**: 1 share from the pool (if the generation is a spell and the author is not the generating user)
- **LoRA model trainers**: 1 share per LoRA used (if the LoRA owner is not the generating user)
- **Per-model cap**: Each LoRA contributes at most 5% of base cost
- **Hard cap**: Total contributor surcharge cannot exceed 20% of base cost
- **Pool division**: The capped pool is divided proportionally by share count

### Example Scenarios

**Scenario A** — 1 spell + 1 LoRA (different authors):
- Pool = 20% of base, 2 shares → each gets 10%

**Scenario B** — 1 spell + 4 LoRAs (all different authors):
- 4 LoRAs × 5% = 20%, already at cap → pool = 20%, 5 shares → each gets 4%

**Scenario C** — No spell, 2 LoRAs (same author):
- 2 shares × 5% = 10% → pool = 10%, 1 author with 2 shares → author gets 10%

**Scenario D** — No spell, 6 LoRAs (6 different authors):
- 6 × 5% = 30%, capped to 20% → pool = 20%, 6 shares → each gets ~3.3%

**Scenario E** — User uses their own LoRA + 1 external LoRA:
- Own LoRA excluded → 1 share × 5% = 5% → pool = 5%, 1 author gets 5%

## Root Cause Analysis

### Bug 1: `ownerAccountId` missing from `appliedLoras` output

**File:** `src/core/services/loraResolutionService.js:307-313`

The `resolveLoraTriggers()` function builds `appliedLoras` entries with only `{ slug, weight, originalWord, replacedWord, modelId }`. The `selectedLora` object at that point contains `ownerAccountId` (populated from the trigger map at `LoraService.js:74`), but it is not included in the output.

Additionally, inline LoRA tags (line 116) push entries with `modelId: 'N/A_INLINE_TAG'` and no `ownerAccountId`, making ownership lookup impossible for inline tags.

### Bug 2: Full resolution result discarded in direct generations

**File:** `src/core/services/generationExecutionService.js:376`

For direct ComfyUI generations, `resolveLoraTriggers()` is called but only `modifiedPrompt` is destructured:
```js
const { modifiedPrompt } = await this.loraResolutionService.resolveLoraTriggers(...);
```
The `appliedLoras`, `rawPrompt`, and `warnings` are discarded.

### Bug 3: `loraResolutionData` hardcoded to `{}` in generation record

**File:** `src/core/services/generationExecutionService.js:672`

The generation record metadata always sets:
```js
loraResolutionData: {},
```
This overwrites any `loraResolutionData` that may have been passed in via the `metadata` spread on line 669 (the spell execution path), and ignores the resolution result from Bug 2 (the direct execution path).

## Proposed Changes

### Change 1: Include `ownerAccountId` in `appliedLoras`

**File:** `src/core/services/loraResolutionService.js`

**At line 307-313** (trigger-word resolved LoRAs), add `ownerAccountId` from `selectedLora`:

```js
appliedLoras.push({
  slug: selectedLora.slug,
  weight: weight,
  originalWord: segment,
  replacedWord: loraTag,
  modelId: selectedLora.modelId,
  ownerAccountId: selectedLora.ownerAccountId || null,
});
```

**At line 116** (inline `<lora:slug:weight>` tags), look up ownership from the trigger map:

```js
// Find ownerAccountId for inline tag by scanning trigger map
let inlineOwnerAccountId = null;
triggerMap.forEach(loraList => {
  const match = loraList.find(l => l.slug === slug);
  if (match) inlineOwnerAccountId = match.ownerAccountId || null;
});
appliedLoras.push({
  slug, weight, originalWord: fullTag, replacedWord: fullTag,
  modelId: 'N/A_INLINE_TAG',
  ownerAccountId: inlineOwnerAccountId,
});
```

### Change 2: Capture full resolution result in direct generations

**File:** `src/core/services/generationExecutionService.js`

**At line 370-384**, capture the full result instead of only `modifiedPrompt`:

```js
let resolvedInputs = { ...inputs };
let loraResolutionData = null;
if (service === 'comfyui' && tool.metadata?.hasLoraLoader) {
  const promptInputKey = tool.metadata?.telegramPromptInputKey || 'input_prompt';
  if (resolvedInputs[promptInputKey]) {
    const { masterAccountId } = user;
    this.logger.debug(`[Execute] Pre-routing LoRA resolution for tool '${toolId}'.`);
    const resolutionResult = await this.loraResolutionService.resolveLoraTriggers(
      resolvedInputs[promptInputKey],
      masterAccountId,
      tool.metadata.baseModel,
      { internal: { client: this.internalApiClient } }
    );
    resolvedInputs[promptInputKey] = resolutionResult.modifiedPrompt;
    loraResolutionData = resolutionResult;
  }
}
```

### Change 3: Use resolved `loraResolutionData` in generation record

**File:** `src/core/services/generationExecutionService.js`

**At line 672**, replace the hardcoded empty object with the resolved data:

```js
loraResolutionData: loraResolutionData || metadata?.loraResolutionData || {},
```

This covers both paths:
- **Direct generation**: uses `loraResolutionData` captured in Change 2
- **Spell execution**: uses `metadata.loraResolutionData` passed from StepExecutor → ImmediateStrategy

### Change 4: Apply per-model cap and hard cap in reward distribution

**File:** `src/core/services/comfydeploy/webhookProcessor.js`

**At lines 562-575**, replace the current flat 20% pool calculation with capped logic:

```js
// --- 2. Calculate rewards with per-model cap and hard cap ---
const PER_LORA_RATE = 0.05;   // 5% per LoRA
const HARD_CAP_RATE = 0.20;   // 20% total max

// Calculate uncapped pool: 5% per share
const uncappedPool = Math.floor(basePoints * PER_LORA_RATE * totalShares);
// Apply hard cap
const contributorRewardPool = Math.min(uncappedPool, Math.floor(basePoints * HARD_CAP_RATE));
```

The rest of the share-proportional division logic remains the same — `pointsPerShare = floor(pool / totalShares)`.

## Files Changed

| File | Change |
|------|--------|
| `src/core/services/loraResolutionService.js` | Add `ownerAccountId` to `appliedLoras` entries |
| `src/core/services/generationExecutionService.js` | Capture full LoRA resolution result; use it in generation record |
| `src/core/services/comfydeploy/webhookProcessor.js` | Apply per-model 5% rate with 20% hard cap |

## Files NOT Changed

| File | Reason |
|------|--------|
| `src/core/services/comfydeploy/workflows.js` | Already returns full `loraResolutionData` correctly |
| `src/core/services/store/lora/LoraService.js` | Already includes `ownerAccountId` in trigger map data |
| `src/core/services/workflow/execution/StepExecutor.js` | Already passes `loraResolutionData` through correctly |
| `src/core/services/workflow/execution/strategies/ImmediateStrategy.js` | Already includes `loraResolutionData` in metadata |

## Testing Strategy

1. **Unit test `resolveLoraTriggers`**: Verify `appliedLoras` entries include `ownerAccountId` for both trigger-word and inline-tag LoRAs
2. **Unit test `distributeContributorRewards`**: Verify correct distribution with mock generation records containing 1, 3, and 6 LoRAs from varying authors, confirming per-model cap and hard cap
3. **Integration test**: Execute a generation using another user's public LoRA and verify a `CONTRIBUTOR_REWARD` credit ledger entry is created for the LoRA owner
4. **Edge cases**:
   - User uses only their own LoRAs → no reward distributed
   - User uses a mix of own + external LoRAs → only external LoRAs generate shares
   - Generation with no LoRAs → no reward logic triggered
   - Inline `<lora:slug:weight>` tags → ownership resolved from trigger map
