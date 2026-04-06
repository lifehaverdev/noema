# Specification: Contributor Reward System Fix

## Problem Statement

The contributor reward system (`distributeContributorRewards`) exists in the webhook processor but never fires because `loraResolutionData.appliedLoras` is always empty in generation records. Three bugs prevent LoRA ownership data from reaching the reward distribution logic.

## Intended Behavior

When a user runs a generation that uses LoRA models trained by other users (and/or a spell authored by another user), an additional surcharge of up to 20% of the base generation cost is charged to the user and distributed to contributors. The surcharge is split into two separate pools:

### Spell Author Reward (fixed 5%)
- **Spell author** receives a flat **5%** of base cost (if the generation is a spell and the author is not the generating user)
- This is not shared or diluted — it is a fixed allocation

### LoRA Model Trainer Reward (up to 15%, capped)
- Each external LoRA used contributes **5%** of base cost to the LoRA reward pool
- The LoRA pool is **capped at 15%** of base cost (i.e., 3+ LoRAs hit the cap)
- The capped pool is divided proportionally by share count among LoRA authors

### Hard Cap
- Total contributor surcharge (spell + LoRA) cannot exceed **20%** of base cost

### Example Scenarios

**Scenario A** — 1 spell + 1 LoRA (different authors):
- Spell author: 5%, LoRA author: 5% → total surcharge: 10%

**Scenario B** — 1 spell + 4 LoRAs (all different authors):
- Spell author: 5%, LoRA pool: 4 × 5% = 20% capped to 15%, 4 shares → each gets 3.75%
- Total surcharge: 20%

**Scenario C** — No spell, 2 LoRAs (same author):
- LoRA pool: 2 × 5% = 10%, 1 author with 2 shares → author gets 10%
- Total surcharge: 10%

**Scenario D** — No spell, 6 LoRAs (6 different authors):
- LoRA pool: 6 × 5% = 30% capped to 15%, 6 shares → each gets 2.5%
- Total surcharge: 15%

**Scenario E** — User uses their own LoRA + 1 external LoRA:
- Own LoRA excluded → 1 share × 5% = 5%, 1 author gets 5%
- Total surcharge: 5%

**Scenario F** — 1 spell + 3 LoRAs (spell author also owns 1 LoRA):
- Spell author: 5%
- LoRA pool: 3 shares but 1 is user's own → 2 external shares × 5% = 10%
- 2 shares → spell author gets 5% (LoRA) + 5% (spell) = 10%, other author gets 5%
- Total surcharge: 15%

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

### Change 4: Split reward distribution into spell + LoRA pools with caps

**File:** `src/core/services/comfydeploy/webhookProcessor.js`

Replace the current single-pool logic (lines 520-630) with two separate pools:

```js
const SPELL_REWARD_RATE = 0.05;    // Spell author gets flat 5%
const PER_LORA_RATE = 0.05;        // 5% per external LoRA
const LORA_POOL_CAP_RATE = 0.15;   // LoRA pool capped at 15%

// --- Spell reward (fixed, not shared) ---
let spellRewardPoints = 0;
if (isSpell && spellOwnerId && spellOwnerId !== generatingUserId) {
  spellRewardPoints = Math.floor(basePoints * SPELL_REWARD_RATE);
}

// --- LoRA reward pool (capped, shared proportionally) ---
// Count only external LoRA shares (exclude user's own)
const loraShares = {}; // { ownerId: shareCount }
let totalLoraShares = 0;
loras.forEach(lora => {
  const ownerId = lora.ownerAccountId?.toString();
  if (ownerId && ownerId !== generatingUserId) {
    loraShares[ownerId] = (loraShares[ownerId] || 0) + 1;
    totalLoraShares++;
  }
});

const uncappedLoraPool = Math.floor(basePoints * PER_LORA_RATE * totalLoraShares);
const loraRewardPool = Math.min(uncappedLoraPool, Math.floor(basePoints * LORA_POOL_CAP_RATE));
const pointsPerLoraShare = totalLoraShares > 0 ? Math.floor(loraRewardPool / totalLoraShares) : 0;

// Distribute LoRA rewards proportionally
for (const [ownerId, shares] of Object.entries(loraShares)) {
  const points = pointsPerLoraShare * shares;
  if (points > 0) rewardsToDistribute.push({ contributorId: ownerId, points });
}

// Distribute spell reward
if (spellRewardPoints > 0) {
  rewardsToDistribute.push({ contributorId: spellOwnerId, points: spellRewardPoints });
}

const totalRewards = rewardsToDistribute.reduce((sum, r) => sum + r.points, 0);
const totalPointsToCharge = basePoints + totalRewards;
```

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

## Delivery

### Branch & PR

- **Branch**: `fix/contributor-reward-distribution`
- **PR target**: `main` on `lifehaverdev/noema`
- All commits use [Conventional Commits](https://www.conventionalcommits.org/) with the `fix:` prefix so that release-please generates a **patch version bump** (e.g., 4.7.3 → 4.7.4)
- Final commit message: `fix: enable contributor reward distribution for model trainers and spell authors`

### Commit Strategy

A single squash-style commit is preferred to keep the release-please changelog clean. If multiple commits are needed during development, the PR should be squash-merged with the `fix:` title.

## Testing Strategy

1. **Unit test `resolveLoraTriggers`**: Verify `appliedLoras` entries include `ownerAccountId` for both trigger-word and inline-tag LoRAs
2. **Unit test `distributeContributorRewards`**: Verify correct distribution with mock generation records containing 1, 3, and 6 LoRAs from varying authors, confirming per-model cap and hard cap
3. **Integration test**: Execute a generation using another user's public LoRA and verify a `CONTRIBUTOR_REWARD` credit ledger entry is created for the LoRA owner
4. **Edge cases**:
   - User uses only their own LoRAs → no reward distributed
   - User uses a mix of own + external LoRAs → only external LoRAs generate shares
   - Generation with no LoRAs → no reward logic triggered
   - Inline `<lora:slug:weight>` tags → ownership resolved from trigger map
