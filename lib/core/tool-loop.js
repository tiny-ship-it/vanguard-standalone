/**
 * Vanguard Tool Loop
 * Handles autonomous tool loops for Specialist agents.
 */

const { callLlm } = require('../llm-client');
const { VANGUARD_TOOLS } = require('./tools');

class ToolLoop {
    constructor(vault, router) {
        this.vault = vault;
        this.router = router;
        this.maxSteps = 5;
    }

    /**
     * Run a multi-step agent loop
     */
    async run(prompt, systemPrompt, options = {}) {
        let currentMessages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt }
        ];

        let step = 0;
        let finalResponse = "";

        while (step < this.maxSteps) {
            console.log(`[vanguard-loop] Step ${step + 1}/${this.maxSteps}...`);
            
            // 1. Resolve model (if not already resolved)
            const model = options.model || await this.router.resolve(prompt);

            // 2. Call LLM with tools
            const response = await callLlm({
                prompt: this._formatMessages(currentMessages),
                model: model,
                // In a real system, we'd pass tool definitions to the API
                // For this mock, we'll handle tool parsing manually if the model outputs a specific format
                includeUsage: true
            });

            const text = response.text;
            
            // 3. Parse for tool calls (simple mock pattern)
            const toolCallMatch = text.match(/TOOL_CALL:\s*(\w+)\((.*)\)/);
            
            if (toolCallMatch) {
                const [_, toolName, toolParamsRaw] = toolCallMatch;
                console.log(`[vanguard-loop] Tool Call detected: ${toolName}`);
                
                let toolResult = "";
                try {
                    const params = JSON.parse(toolParamsRaw);
                    toolResult = await this.executeTool(toolName, params);
                    
                    // Persistent State Tracking: Record tool call in decision memory
                    await this.vault.recordDecision(
                        `Agent executed tool: ${toolName}`,
                        `Params: ${toolParamsRaw}\nResult: ${typeof toolResult === 'string' ? toolResult.substring(0, 500) : 'Object'}`,
                        { step: step + 1, sessionId: options.sessionId }
                    );
                } catch (err) {
                    toolResult = `Error executing tool: ${err.message}`;
                }

                currentMessages.push({ role: 'assistant', content: text });
                currentMessages.push({ role: 'system', content: `TOOL_RESULT: ${toolResult}` });
                
                step++;
            } else {
                // Final response
                finalResponse = text;
                
                // Track final outcome
                await this.vault.recordDecision(
                    `Agent completed task loop`,
                    `Final response length: ${finalResponse.length}`,
                    { sessionId: options.sessionId }
                );
                break;
            }
        }

        return finalResponse || "Error: Max steps exceeded without final response.";
    }

    /**
     * Execute a specific tool
     */
    async executeTool(name, params) {
        switch (name) {
            case 'search_memories':
                const results = await this.vault.getSharedContext(null, params.query);
                return JSON.stringify(results);
            case 'record_decision':
                await this.vault.recordDecision(params.decision, params.reasoning);
                return "Decision recorded successfully.";
            default:
                return `Unknown tool: ${name}`;
        }
    }

    _formatMessages(messages) {
        return messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
    }
}

module.exports = { ToolLoop };
