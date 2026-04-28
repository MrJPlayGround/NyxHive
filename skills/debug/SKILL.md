---
name: debug
description: Use when encountering bugs or test failures - systematic debugging with NyxHive patterns
---

# Systematic Debugging

## The Rule
Complete root cause investigation before proposing a fix.

## Process
1. Reproduce the failure with exact error output
2. Trace from symptom to root cause — don't guess
3. Check all call sites (incomplete call-site fix pattern)
4. Fix and verify — run full test suite, not just the failing test
