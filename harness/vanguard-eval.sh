#!/bin/bash
# Vanguard Eval Harness Entry Point

if [ "$#" -lt 1 ]; then
    echo "Usage: $0 <trace_file>"
    exit 1
fi

TRACE_FILE=$1
TEMPLATE_FILE=$(dirname "$0")/judge_prompt.md
JUDGE_SCRIPT=$(dirname "$0")/judge.js

node "$JUDGE_SCRIPT" "$TRACE_FILE" "$TEMPLATE_FILE"
