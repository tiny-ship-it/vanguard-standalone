# Vanguard Eval Harness

## Overview
Automated evaluation of Vanguard agent traces using an LLM-as-a-judge (Garry Tan persona).

## Components
- `judge_prompt.md`: The system prompt for the judge.
- `judge.js`: Node.js script using AI SDK to perform the evaluation.
- `vanguard-eval.sh`: CLI wrapper.
- `traces/`: Directory for input traces.

## Usage
```bash
./harness/vanguard-eval.sh traces/sample-trace.json
```

## Requirements
- `GOOGLE_GENERATIVE_AI_API_KEY`: Must be set in the environment for the judge to function.
- Node.js environment with access to `@ai-sdk/google`.

## Personas
**The Judge**: Garry Tan (YC). Focuses on Agency, Outcome, and Efficiency. Brutally honest.
