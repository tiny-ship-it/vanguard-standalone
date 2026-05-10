/**
 * Vanguard Harness
 * The execution engine that binds Router and Vault to an agent session.
 */

const { AssistantCoreEngine } = require('./engine');
const { getSpecialistPrompt } = require('./specialists');
const { ToolLoop } = require('./tool-loop');
const { SessionPersistence } = require('./persistence');

class Harness {
    constructor(config = {}) {
        this.userId = config.userId;
        this.channelId = config.channelId;
        this.orgId = config.orgId;
        this.provider = config.provider || 'slack';
        
        this.engine = new AssistantCoreEngine();
        this.instance = null;
        this.isInitialized = false;
    }

    /**
     * Initialize tenant and services
     */
    async init() {
        if (!this.userId) throw new Error('userId is required for Vanguard Harness');
        
        this.instance = await this.engine.createHarness({
            userId: this.userId,
            provider: this.provider,
            channelId: this.channelId,
            orgId: this.orgId
        });
        
        this.router = this.instance.router;
        this.vault = this.instance.vault;
        this.tenantId = this.instance.context.tenantId;
        this.toolLoop = new ToolLoop(this.vault, this.router);
        this.persistence = new SessionPersistence(this.vault);
        
        this.isInitialized = true;
        console.log(`[vanguard-harness] Initialized for User: ${this.userId}, Tenant: ${this.tenantId}`);
    }

    /**
     * Prepare context for a task
     */
    async prepareTask(taskPrompt, sessionId, options = {}) {
        if (!this.isInitialized) await this.init();
        
        const execution = await this.instance.execute(taskPrompt, sessionId, options);

        return {
            systemPrompt: execution.systemPrompt,
            model: execution.model
        };
    }

    /**
     * Execute a task with autonomous tool loops
     */
    async executeTask(message, sessionId, options = {}) {
        if (!this.isInitialized) await this.init();

        const { systemPrompt, model } = await this.prepareTask(message, sessionId, options);
        
        console.log(`[vanguard-harness] Running autonomous task execution with ${model}...`);
        return await this.toolLoop.run(message, systemPrompt, { ...options, model });
    }

    /**
     * Complete a session by distilling context
     */
    async finalizeSession(conversationHistory) {
        if (!this.isInitialized) return;
        
        console.log(`[vanguard-harness] Finalizing session for ${this.userId}...`);
        return this.vault.distill(conversationHistory);
    }

    /**
     * Run a quality check on the current output
     * @param {string} output - The content to verify
     * @param {string} rubric - Optional specific verification instructions
     */
    async verify(output, rubric = null) {
        if (!this.isInitialized) await this.init();
        
        console.log(`[vanguard-harness] Running quality check for ${this.userId}...`);
        
        const auditorPrompt = getSpecialistPrompt('AUDITOR');
        const verificationPrompt = `${auditorPrompt}

Target Goals: ${rubric || 'Accuracy, clarity, and adherence to instructions.'}

Output to Check:
---
${output}
---

Provide a status: PASS or FAIL.
If FAIL, list specific issues.`;

        // We use a high-reasoning model for checking
        const model = await this.router.resolve(verificationPrompt, { taskType: 'SYNTHESIS' });
        
        const { callLlm } = require('../llm-client');
        const verificationResult = await callLlm({
            prompt: verificationPrompt,
            model: model,
            maxTokens: 500,
            temperature: 0,
            includeUsage: true
        });

        const result = verificationResult.text || '';
        if (verificationResult.usage) {
            await this.router.recordUsage(model, verificationResult.usage.promptTokens, verificationResult.usage.completionTokens);
        }

        const status = result.includes('PASS') ? 'PASS' : 'FAIL';
        
        await this.vault.store(`Verification Result: ${status}\nFeedback: ${result}`, {
            kind: 'fact',
            source: 'vanguard-checker'
        });

        return {
            status,
            feedback: result
        };
    }
}

module.exports = {
    Harness
};
