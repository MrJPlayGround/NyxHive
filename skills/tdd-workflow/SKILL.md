---
name: tdd-workflow
description: Use when changing behavior, fixing bugs, or adding features with testable outcomes
---

# TDD Workflow

## The Rule
When behavior changes, put the expected behavior under test before or alongside the implementation.

## Workflow
1. Find the closest existing test for the behavior.
2. Add or adjust a focused test that would fail against the current bug or missing feature.
3. Run the narrow test and confirm the failure when risk justifies the extra loop.
4. Implement the smallest change that makes the test pass.
5. Run the narrow test again, then full verification.

## Exceptions
For low-risk mechanical changes, generated metadata, or documentation-only edits, a new test may not add value. Say why, then still run the relevant existing verification.
