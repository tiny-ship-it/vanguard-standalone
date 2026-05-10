/**
 * Vanguard Tools
 * Defined tool definitions for the Specialist fleet.
 */

const VANGUARD_TOOLS = {
    "search_memories": {
        "description": "Search the tenant's memory for relevant facts, decisions, or architectural details.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "The search query" },
                "limit": { "type": "integer", "description": "Max results", "default": 5 }
            },
            "required": ["query"]
        }
    },
    "record_decision": {
        "description": "Record a formal architectural or strategic decision in the project vault.",
        "parameters": {
            "type": "object",
            "properties": {
                "decision": { "type": "string", "description": "The decision made" },
                "reasoning": { "type": "string", "description": "The logic behind the decision" }
            },
            "required": ["decision", "reasoning"]
        }
    },
    "get_weather": {
        "description": "Get current weather for geographic context shifts (Ambient Context).",
        "parameters": {
            "type": "object",
            "properties": {
                "location": { "type": "string", "description": "City or coordinates" }
            },
            "required": ["location"]
        }
    }
};

module.exports = {
    VANGUARD_TOOLS
};
