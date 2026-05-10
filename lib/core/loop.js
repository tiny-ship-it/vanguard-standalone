/**
 * Vanguard Main Agent Loop
 * Coordinates the full execution lifecycle of a Vanguard task.
 */

const { Harness } = require('./harness');
const { callLlm } = require('../llm-client');

async function runAssistantCoreTurn(params) {
    const { userId, message, sessionId, channelId, orgId } = params;

    // 1. Initialize Harness
    const harness = new Harness({
        userId,
        channelId,
        orgId
    });

    try {
        // 2. Prepare Task (Routing + Hierarchical Context)
        console.log(`[vanguard-loop] Preparing task for user ${userId}...`);
        const { systemPrompt, model } = await harness.prepareTask(message, sessionId);

        // 3. Execute Turn
        console.log(`[vanguard-loop] Executing turn with model: ${model}`);
        const result = await callLlm({
            prompt: `${systemPrompt}\n\nUser: ${message}\n\nAssistant:`,
            model: model,
            includeUsage: true
        });

        const assistantReply = result.text;
        
        // Record Usage
        if (result.usage) {
            await harness.router.recordUsage(model, result.usage.promptTokens, result.usage.completionTokens);
        } else {
            console.warn(`[vanguard-loop] Usage data missing for model: ${model}`);
        }

        // 4. Quality Gate (Verification)
        console.log(`[vanguard-loop] Running verification gate...`);
        const verification = await harness.verify(assistantReply);
        
        if (verification.status === 'FAIL') {
            console.warn(`[vanguard-loop] Verification FAILED: ${verification.feedback}`);
            // In a real loop, we might retry or ask for clarification.
            // For now, we'll return the reply but flag it.
            return {
                reply: assistantReply,
                flag: 'VERIFICATION_FAILED',
                feedback: verification.feedback
            };
        }

        // 5. Finalize Session (Memory Distillation)
        console.log(`[vanguard-loop] Finalizing session and distilling memory...`);
        await harness.finalizeSession(`${message}\n\n${assistantReply}`);

        return {
            reply: assistantReply,
            status: 'SUCCESS'
        };

    } catch (err) {
        console.error(`[vanguard-loop] Error in agent loop:`, err);
        throw err;
    }
}

module.exports = {
    runAssistantCoreTurn
};
