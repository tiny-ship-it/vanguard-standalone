/**
 * Vanguard Resources
 * Curated list of shared AI tools and knowledge for the Vanguard platform.
 * These are ingested into the 'workspace' or 'global' namespace.
 */

const AI_RESOURCES = [
    {
        name: "Blender AI Connectors",
        type: "tool",
        url: "https://github.com/tinwins/blender-ai-connectors", // Hypothetical repo based on context
        description: "Connect Blender to AI agents for automated animation and 3D scene generation."
    },
    {
        name: "SREF Designer Playbook",
        type: "doc",
        path: "docs/sref-designer-playbook.md",
        description: "Standardized Style Reference (SREF) patterns for consistent AI image generation."
    },
    {
        name: "Vercel AI SDK v4 Guide",
        type: "doc",
        path: "projects/vanguard/TECHNICAL_BRIEF_VERCEL_SDK_V4.md",
        description: "Implementation details for multi-step agent interactions."
    }
];

module.exports = {
    AI_RESOURCES
};
