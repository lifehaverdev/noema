/**
 * StepExecutor - Executes a single step of a spell
 * 
 * Uses Execution Strategy pattern - NO service-specific conditionals!
 */

const { validateStepIndex, validateStep, validateTool } = require('../utils/ValidationUtils');
const { createEvent } = require('../utils/EventManager');
const ParameterResolver = require('./ParameterResolver');
const StrategyFactory = require('./strategies/StrategyFactory');

class StepExecutor {
    constructor({ logger, toolRegistry, workflowsService, internalApiClient, userEventsDb, adapterRegistry, generationRecordManager, adapterCoordinator, workflowNotifier, generationExecutionService }) {
        this.logger = logger;
        this.toolRegistry = toolRegistry;
        this.workflowsService = workflowsService;
        this.internalApiClient = internalApiClient;
        // userEventsDb preferred for event creation; falls back to internalApiClient
        this.userEventsDb = userEventsDb || null;
        this.adapterRegistry = adapterRegistry;
        this.generationRecordManager = generationRecordManager;
        this.generationExecutionService = generationExecutionService || null;

        // Initialize sub-services
        this.parameterResolver = new ParameterResolver({ logger });
        this.adapterCoordinator = adapterCoordinator;
        this.workflowNotifier = workflowNotifier;
        this.strategyFactory = new StrategyFactory({
            logger,
            adapterRegistry,
            adapterCoordinator,
            workflowNotifier,
            generationExecutionService: this.generationExecutionService, // Phase 8
        });
    }

    /**
     * Executes a single step of a spell
     * @param {Object} spell - Spell definition
     * @param {number} stepIndex - Step index
     * @param {Object} pipelineContext - Pipeline context
     * @param {Object} originalContext - Original execution context
     * @returns {Promise<any>} - Execution result
     */
    async executeStep(spell, stepIndex, pipelineContext, originalContext) {
        // Validate step
        validateStepIndex(stepIndex, spell.steps.length, spell.name);
        const step = spell.steps[stepIndex];
        validateStep(step, stepIndex, spell.name);

        // Resolve tool
        let tool = this.toolRegistry.findByDisplayName(step.toolIdentifier);
        if (!tool) {
            tool = this.toolRegistry.getToolById(step.toolIdentifier);
        }
        validateTool(tool, step.toolIdentifier, step.stepId, stepIndex, spell.name);

        this.logger.debug(`[StepExecutor] Executing Step ${stepIndex + 1}/${spell.steps.length}: ${tool.displayName}`);

        // Create event FIRST (required for initiatingEventId in generation records)
        // Use userEventsDb directly if available (Phase 7a), fall back to internalApiClient
        const { eventId } = await createEvent(
            'spell_step_triggered',
            originalContext,
            { spellId: spell._id, stepId: step.stepId, toolId: tool.toolId },
            this.userEventsDb || this.internalApiClient
        );
        this.logger.debug(`[StepExecutor] Created event ${eventId} for spell step ${stepIndex + 1}`);

        // Resolve parameters
        const stepInput = this.parameterResolver.resolveStepInputs(step, pipelineContext, tool);

        // Validate required inputs
        const missing = this.parameterResolver.validateRequiredInputs(tool, stepInput);
        if (missing.length) {
            this.logger.warn(`[StepExecutor] Missing required inputs for tool '${tool.displayName}' (step ${step.stepId} of spell '${spell.name}'): ${missing.join(', ')}`);
            // TODO: emit metric 'spell_missing_input' with tags { toolId, spellId }
        }

        // Prepare tool run payload (may include LoRA resolution, etc.)
        const { inputs: finalInputs, loraResolutionData } = await this.workflowsService.prepareToolRunPayload(
            tool.toolId,
            stepInput,
            originalContext.masterAccountId,
            { internal: { client: this.internalApiClient } }
        );

        // Pre-routing Seed Randomization — spell version.
        //
        // Normal tool execution (generationExecutionService.execute) randomizes
        // input_seed when the *caller* leaves it undefined / null / '' / -1.
        // For spells we can't just inspect the merged step input, because
        // resolveStepInputs() stamps step.parameterOverrides on top — which
        // means every cast reuses whatever seed was in the tool window at
        // compose time and the result is deterministic.
        //
        // The rule we want is: "if the caster (the user casting the spell)
        // did not explicitly provide a seed, randomize it — regardless of
        // what was baked into the spell at compose time." A step can still
        // pin its seed by wiring it through parameterMappings (e.g. piping
        // another step's seed output), which we treat as an explicit
        // reference and leave alone.
        if (tool.service === 'comfyui') {
            const seedKey = tool.metadata?.seedInputKey || 'input_seed';
            const casterSeed = originalContext?.parameterOverrides?.[seedKey];
            const casterProvidedSeed =
                casterSeed !== undefined &&
                casterSeed !== null &&
                casterSeed !== '' &&
                casterSeed !== -1 &&
                casterSeed !== '-1';
            const stepWiredSeed =
                step.parameterMappings && step.parameterMappings[seedKey] &&
                step.parameterMappings[seedKey].type === 'nodeOutput';

            if (!casterProvidedSeed && !stepWiredSeed) {
                finalInputs[seedKey] = Math.floor(Math.random() * 0xffffffff);
                this.logger.debug(`[StepExecutor] Caster did not specify ${seedKey}; auto-assigned random ${finalInputs[seedKey]} for spell '${spell.name}' step ${stepIndex + 1}`);
            }
        }

        // Get execution strategy (from tool definition or factory)
        const strategy = tool.executionStrategy || this.strategyFactory.createDefaultStrategy(tool);

        // Build execution context
        const executionContext = {
            tool,
            spell,
            stepIndex,
            pipelineContext,
            originalContext,
            loraResolutionData
        };

        // Prepare dependencies
        const dependencies = {
            adapter: this.adapterRegistry.get(tool.service),
            internalApiClient: this.internalApiClient,
            generationRecordManager: this.generationRecordManager,
            workflowNotifier: this.workflowNotifier,
            eventId: eventId
        };

        // Execute using strategy - NO CONDITIONALS!
        try {
            const result = await strategy.execute(finalInputs, executionContext, dependencies);

            // Handle response if completed
            if (result.status === 'completed' && strategy.handleResponse) {
                await strategy.handleResponse(result, executionContext, dependencies);
            }

            return result;
        } catch (error) {
            // Handle error using strategy
            if (strategy.handleError) {
                const errorResult = await strategy.handleError(error, executionContext, dependencies);
                if (errorResult.handled) {
                    // Error handled by strategy, return early
                    return { status: 'failed', handled: true };
                }
            }
            // Re-throw if not handled
            throw error;
        }
    }
}

module.exports = StepExecutor;

