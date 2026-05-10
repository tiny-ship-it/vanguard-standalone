/**
 * model-selector.js
 * Smart model selection with multi-provider tiered routing
 * Distributes load across Anthropic, OpenAI, and Google Vertex AI
 */

/**
 * @typedef {'LEAF' | 'STANDARD' | 'SYNTHESIS' | 'DEEP_REASONING'} TaskComplexity
 * @typedef {'anthropic' | 'openai' | 'google-vertex'} Provider
 * @typedef {'cheap' | 'normal' | 'premium'} Budget
 */

/**
 * Task complexity levels for model selection
 * @enum {string}
 */
const TASK_COMPLEXITY = {
  LEAF: 'LEAF',                     // cheap, fast — classification, data extraction, summarization
  STANDARD: 'STANDARD',             // everyday — coding, research, tool orchestration
  SYNTHESIS: 'SYNTHESIS',           // multi-source — research synthesis, content assembly
  DEEP_REASONING: 'DEEP_REASONING', // high-stakes — architecture, strategy, complex debugging
};

/**
 * Model pool organized by task complexity tier.
 * Each tier has primary + fallback models spread across providers
 * to avoid rate-limit concentration on any single provider.
 *
 * Last updated: 2026-02-28
 * Sources: platform.openai.com/docs/models, platform.claude.com/docs, cloud.google.com/vertex-ai
 */
const MODEL_POOL = {
  // Cheap, fast: classification, data extraction, summarization, cron tasks
  LEAF: [
    { provider: 'google-vertex', model: 'google-vertex/gemini-2.5-flash-lite',   primary: true  }, // Google's cheapest/fastest
    { provider: 'openai',        model: 'openai/gpt-5-nano',                     primary: false }, // OpenAI's cheapest GPT-5 tier
  ],
  // Everyday: coding, research, tool orchestration, direct user interactions
  STANDARD: [
    { provider: 'openai',        model: 'openai/gpt-5-mini',                     primary: true  }, // Fast, cost-efficient GPT-5
    { provider: 'google-vertex', model: 'google-vertex/gemini-3-flash-preview',  primary: false }, // Gemini 3 Flash — strong reasoning at Flash speed
    { provider: 'google-vertex', model: 'google-vertex/gemma-4-31b-it',          primary: false }, // Gemma 4 31B — #3 ranked open model
  ],
  // Multi-source: research synthesis, content assembly, competitive intel, meeting prep
  SYNTHESIS: [
    { provider: 'google-vertex', model: 'google-vertex/gemini-3.1-pro-preview',  primary: true  }, // Gemini flagship, excellent long-context
    { provider: 'openai',        model: 'openai/gpt-5.1',                        primary: false }, // Strong reasoning + large context
  ],
  // High-stakes: architecture decisions, complex debugging, strategic recommendations
  DEEP_REASONING: [
    { provider: 'openai',        model: 'openai/gpt-5.2',                        primary: true  }, // OpenAI's best agentic/coding model
    { provider: 'google-vertex', model: 'google-vertex/gemini-3.1-pro-preview',  primary: false }, // Long-context fallback
  ],
};

// In-memory round-robin counters per tier
const rotationCounters = {
  LEAF: 0,
  STANDARD: 0,
  SYNTHESIS: 0,
  DEEP_REASONING: 0,
};

/**
 * Select the appropriate model based on task complexity and options
 *
 * @param {TaskComplexity} taskType - The complexity level of the task
 * @param {Object} [options={}] - Selection options
 * @param {Provider} [options.provider] - Force a specific provider
 * @param {Budget} [options.budget] - Budget constraint (cheap downgrades one tier)
 * @param {boolean} [options.rotateProviders=false] - Round-robin across providers
 * @returns {string} The selected model string (e.g., "anthropic/claude-sonnet-4-6")
 * @throws {Error} If taskType is unknown or provider not available in tier
 */
function selectModel(taskType, options = {}) {
  const { provider, budget, rotateProviders = false } = options;

  // Validate task type
  if (!TASK_COMPLEXITY[taskType]) {
    throw new Error(
      `Unknown taskType: "${taskType}". Must be one of: ${Object.keys(TASK_COMPLEXITY).join(', ')}`
    );
  }

  // Apply budget downgrade
  let effectiveTier = taskType;
  if (budget === 'cheap') {
    const tierOrder = ['LEAF', 'STANDARD', 'SYNTHESIS', 'DEEP_REASONING'];
    const currentIndex = tierOrder.indexOf(taskType);
    if (currentIndex > 0) {
      effectiveTier = tierOrder[currentIndex - 1];
    }
  }

  const tierModels = MODEL_POOL[effectiveTier];

  // Provider override
  if (provider) {
    const providerModel = tierModels.find(m => m.provider === provider);
    if (!providerModel) {
      throw new Error(
        `Provider "${provider}" not available in ${effectiveTier} tier. ` +
        `Available providers: ${tierModels.map(m => m.provider).join(', ')}`
      );
    }
    return providerModel.model;
  }

  // Round-robin rotation
  if (rotateProviders) {
    const index = rotationCounters[effectiveTier] % tierModels.length;
    rotationCounters[effectiveTier] = (rotationCounters[effectiveTier] + 1) % tierModels.length;
    return tierModels[index].model;
  }

  // Default: return primary model
  const primaryModel = tierModels.find(m => m.primary);
  return primaryModel.model;
}

module.exports = {
  TASK_COMPLEXITY,
  MODEL_POOL,
  selectModel,
};
